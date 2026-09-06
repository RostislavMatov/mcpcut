import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER, SESSION_ID_PATTERN } from '../../src/config.js'
import {
  ACCESS_EDIT_SESSION_ID,
  buildAccessEditRecord,
  type AccessEditInfo,
} from '../../src/journal/access-edit-record.js'
import { verifyChain } from '../../src/journal/chain-verify.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { parseJournalLine } from '../../src/journal/line-source.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { isValidJournalKind, JOURNAL_KINDS, readSessionWithStats } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { REPORT_FILES, buildJournalReport, type ReportManifest } from '../../src/journal/report.js'
import { signReportManifest, type ReportSignatureFile } from '../../src/journal/report-signing.js'
import {
  readVerifyingKey,
  verifyReportExport,
  type ReportVerifyResult,
} from '../../src/journal/report-verify.js'
import { matchesFilters } from '../../src/journal/search-filters.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
} from '../../src/journal/signing.js'
import { sha256Hex } from '../../src/policy/hash.js'
import { PROBE_SESSION_ID } from '../../src/probe/constants.js'
import { REGISTRY_SERVER_NAME_PATTERN } from '../../src/registry/constants.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'
import { render } from '../../src/ui/html.js'
import { renderRecordRow } from '../../src/ui/pages/journal-parts.js'

/**
 * `kind: 'access-edit'` records (plan m55-server-groups Task 7, decisions
 * G4/G6): one group/access change — who did what to which group, server or
 * agent — through the SAME journal path as everything else. The compatibility
 * half is written BEFORE any producer exists (the M5.5 lesson repeated for
 * `policy-edit`): verify, export + offline `verify --report`, the report
 * summary, search filters, the CLI `--kind` validator and the UI renderer
 * must all digest an access edit without attributing it to an agent.
 */

const AS_OF = '2026-08-31T12:00:00.000Z'
const FIXED_NOW_MS = Date.parse('2026-08-31T10:00:00.000Z')

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-access-edit-record-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

// --- Fixtures ---------------------------------------------------------------

function infoOf(overrides: Partial<AccessEditInfo> = {}): AccessEditInfo {
  return {
    actor: { adminName: 'alice', role: 'owner', via: 'ui' },
    action: 'group.grant',
    group: 'analytics',
    server: 'github',
    grant: { tools: ['get_issue', 'list_*'] },
    ...overrides,
  }
}

function grantRecord(): JournalRecord {
  return buildAccessEditRecord({ info: infoOf(), clock: () => FIXED_NOW_MS })
}

function cascadeRecord(): JournalRecord {
  return buildAccessEditRecord({
    info: {
      actor: { adminName: null, role: null, via: 'cli' },
      action: 'server.remove',
      server: 'notes',
      affectedAgents: ['ci-agent', 'reporter'],
      affectedGroups: ['analytics'],
    },
    clock: () => FIXED_NOW_MS,
  })
}

/** `vault set github-pat` by an owner from the CLI (owner decision S2, 2026-09-03). */
function vaultSetRecord(): JournalRecord {
  return buildAccessEditRecord({
    info: {
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'vault.set',
      vaultEntry: 'github-pat',
    },
    clock: () => FIXED_NOW_MS,
  })
}

/** `vault rekey`: every secret re-encrypted, none named. */
function vaultRekeyRecord(): JournalRecord {
  return buildAccessEditRecord({
    info: { actor: { adminName: 'alice', role: 'owner', via: 'cli' }, action: 'vault.rekey' },
    clock: () => FIXED_NOW_MS,
  })
}

function trafficDoc(sessionId: string, id: string): string {
  return JSON.stringify({
    id,
    ts: '2026-08-31T00:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    payload: { hello: 'world' },
  })
}

function rowOf(doc: string, sessionId = 'session-1'): JournalRecordRow {
  const parsed = JSON.parse(doc) as {
    ts: string
    direction: string
    kind: string
    method?: string
  }
  return {
    sessionId,
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: parsed.ts,
    direction: parsed.direction,
    kind: parsed.kind,
    method: parsed.method ?? null,
    doc,
  }
}

function editRowOf(record: JournalRecord): JournalRecordRow {
  return rowOf(JSON.stringify(record), record.sessionId)
}

async function openWithRows(rows: readonly JournalRecordRow[]): Promise<SqliteHandle> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  handle.transaction((db) => insertRecordRows(db, rows))
  return handle
}

function mixedRows(): readonly JournalRecordRow[] {
  return [
    rowOf(trafficDoc('session-1', 'a')),
    editRowOf(grantRecord()),
    rowOf(trafficDoc('session-1', 'b')),
    editRowOf(cascadeRecord()),
  ]
}

/** Traffic interleaved with the three vault actions — the S2 shape of `mixedRows()`. */
function vaultRows(): readonly JournalRecordRow[] {
  return [
    rowOf(trafficDoc('session-1', 'a')),
    editRowOf(vaultSetRecord()),
    editRowOf(vaultRekeyRecord()),
    rowOf(trafficDoc('session-1', 'b')),
  ]
}

// --- Export fixture (mirrors tests/journal/policy-edit-record.test.ts) -------

interface ExportFixture {
  readonly manifest: ReportManifest
  readonly recordsText: string
  readonly summaryMarkdown: string
}

async function buildExport(rows: readonly JournalRecordRow[]): Promise<ExportFixture> {
  const handle = await openWithRows(rows)
  const lines: string[] = []
  const report = await buildJournalReport(handle, { asOf: AS_OF }, {
    writeLine: (line) => void lines.push(line),
  })
  return {
    manifest: withSummary(report.manifest, report.summaryMarkdown),
    recordsText: lines.join(''),
    summaryMarkdown: report.summaryMarkdown,
  }
}

function withSummary(manifest: ReportManifest, summaryMarkdown: string): ReportManifest {
  if ((manifest as { summary?: unknown }).summary !== undefined) return manifest
  const summary = { file: REPORT_FILES.summary, sha256: sha256Hex(summaryMarkdown) }
  return { ...manifest, summary } as ReportManifest
}

async function* chunksOf(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8')
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}

async function signWith(manifest: ReportManifest): Promise<{
  readonly manifest: ReportManifest
  readonly signature: ReportSignatureFile
  readonly publicKeyPem: string
}> {
  const pair = await generateAndWriteSigningKeyPair(journalDir)
  const lookup = await loadSigningPrivateKey(journalDir)
  if (!lookup.present) throw new Error('fixture keygen wrote no private key')
  const signed = signReportManifest(lookup.privateKeyPem, manifest)
  return { manifest: signed.manifest, signature: signed.signature, publicKeyPem: pair.publicKeyPem }
}

function keyOf(publicKeyPem: string): NonNullable<Parameters<typeof verifyReportExport>[0]['key']> {
  const lookup = readVerifyingKey(publicKeyPem)
  if (!lookup.ok) throw new Error(`fixture public key was rejected: ${lookup.message}`)
  return lookup.key
}

async function verifyExport(fixture: ExportFixture): Promise<ReportVerifyResult> {
  const signed = await signWith(fixture.manifest)
  return verifyReportExport({
    manifest: signed.manifest,
    records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
    summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
    signature: { status: 'present', signature: signed.signature },
    key: keyOf(signed.publicKeyPem),
  })
}

// --- Compatibility: the closed M5 tract digests access-edit records ---------

describe('access-edit records and the M5 journal tract', () => {
  test('verify walks a journal holding access-edit records without finding a break', async () => {
    const handle = await openWithRows(mixedRows())
    const result = verifyChain(handle)
    expect(result.break).toBeNull()
    expect(result.totalRowCount).toBe(4)
    expect(result.attestedCount).toBe(4)
    expect(result.intactThroughSeq).not.toBeNull()
  })

  test('export + offline verify --report pass every check over access-edit records', async () => {
    const fixture = await buildExport(mixedRows())
    const result = await verifyExport(fixture)
    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(0)
    for (const check of result.checks) {
      expect(check.status).toBe('passed')
    }
    // The edit is IN the export, verbatim, separable by its kind and session.
    expect(fixture.recordsText).toContain('"kind":"access-edit"')
    expect(fixture.recordsText).toContain(`"sessionId":"${ACCESS_EDIT_SESSION_ID}"`)
    expect(fixture.recordsText).toContain('analytics')
  })

  test('the report never counts an access edit as a decision or an unparsable row', async () => {
    const fixture = await buildExport(mixedRows())
    const counts = fixture.manifest.counts
    expect(counts.records).toBe(4)
    expect(counts.decisions).toBe(0)
    // RED before `kind: 'access-edit'` existed: an unknown kind fails
    // `parseJournalLine` and lands in `unparsableRows` — an edit must not.
    expect(counts.unparsableRows).toBe(0)
    expect(Object.keys(counts.byOutcome)).toEqual([])
  })

  test('a stored access-edit line reads back as a record (not a skipped row)', async () => {
    await openWithRows(mixedRows())
    const result = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir: journalDir })
    expect(result.skippedLineCount).toBe(0)
    expect(result.records).toHaveLength(2)
    expect(result.records[0]?.kind).toBe('access-edit')
  })

  test('a hand-written access-edit doc parses as a journal line', () => {
    const record = parseJournalLine(
      JSON.stringify({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ts: '2026-08-31T00:00:00.000Z',
        sessionId: ACCESS_EDIT_SESSION_ID,
        direction: 'client→server',
        kind: 'access-edit',
        payload: { action: 'group.create', group: 'analytics' },
      }),
    )
    expect(record).not.toBeNull()
    expect(record?.kind).toBe('access-edit')
  })

  test('the CLI --kind validator accepts the new kind', () => {
    expect(isValidJournalKind('access-edit')).toBe(true)
    expect(JOURNAL_KINDS).toContain('access-edit')
  })
})

// --- Search filters and UI journal ------------------------------------------

describe('access-edit records in search and the UI journal', () => {
  test('kind/text filters match an access edit; decision filters never do', () => {
    const record = grantRecord()
    expect(matchesFilters(record, { kind: 'access-edit' })).toBe(true)
    expect(matchesFilters(record, { kind: 'decision' })).toBe(false)
    expect(matchesFilters(record, { text: 'analytics' })).toBe(true)
    expect(matchesFilters(record, { text: 'alice' })).toBe(true)
    // Granting a server to a group is not a call an agent made against it.
    expect(matchesFilters(record, { outcome: 'allow' })).toBe(false)
    expect(matchesFilters(record, { agentName: 'ci-agent' })).toBe(false)
  })

  test('the journal row renderer shows an access-edit record readably', () => {
    const rendered = render(
      renderRecordRow(grantRecord(), { hasLatency: true, withSession: false }),
    )
    expect(rendered).toContain('access-edit')
    expect(rendered).toContain('analytics')
    expect(rendered).toContain('github')
    expect(rendered).toContain('alice')
  })

  test('a hostile group name is escaped by the journal renderer', () => {
    const record = buildAccessEditRecord({
      info: infoOf({ group: '<script>alert(1)</script>' }),
      clock: () => FIXED_NOW_MS,
    })
    const rendered = render(renderRecordRow(record, { hasLatency: false, withSession: false }))
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
  })
})

// --- The reserved session id -------------------------------------------------

describe('the access-edit session id', () => {
  test('is a legal session id but can never be a registry server name', () => {
    expect(SESSION_ID_PATTERN.test(ACCESS_EDIT_SESSION_ID)).toBe(true)
    expect(REGISTRY_SERVER_NAME_PATTERN.test(ACCESS_EDIT_SESSION_ID)).toBe(false)
  })

  test('is distinct from the probe and policy-edit session ids', () => {
    expect(ACCESS_EDIT_SESSION_ID).not.toBe(PROBE_SESSION_ID)
    expect(ACCESS_EDIT_SESSION_ID).not.toBe(POLICY_EDIT_SESSION_ID)
  })
})

// --- The builder --------------------------------------------------------------

describe('buildAccessEditRecord', () => {
  test('a group grant carries actor, action, group, server and the grant itself', () => {
    const record = grantRecord()
    expect(record.kind).toBe('access-edit')
    expect(record.sessionId).toBe(ACCESS_EDIT_SESSION_ID)
    expect(record.direction).toBe('client→server')
    expect(record.ts).toBe(new Date(FIXED_NOW_MS).toISOString())
    expect(record.method).toBeUndefined()
    expect(record.durationMs).toBeUndefined()
    expect(record.decision).toBeUndefined()
    expect(record.payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      action: 'group.grant',
      group: 'analytics',
      server: 'github',
      grant: { tools: ['get_issue', 'list_*'] },
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('absent optional fields stay ABSENT rather than becoming undefined keys', () => {
    const record = buildAccessEditRecord({
      info: { actor: { adminName: 'bob', role: 'operator', via: 'cli' }, action: 'group.create', group: 'analytics' },
      clock: () => FIXED_NOW_MS,
    })
    const payload = record.payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['action', 'actor', 'group'])
    expect(Object.hasOwn(payload, 'server')).toBe(false)
    expect(Object.hasOwn(payload, 'grant')).toBe(false)
    expect(Object.hasOwn(payload, 'affectedAgents')).toBe(false)
  })

  test('an unattributed CLI cascade keeps adminName/role null verbatim — "nobody named" is a fact', () => {
    const record = cascadeRecord()
    const payload = record.payload as Record<string, unknown>
    expect(payload['actor']).toEqual({ adminName: null, role: null, via: 'cli' })
    expect(payload['action']).toBe('server.remove')
    expect(payload['affectedAgents']).toEqual(['ci-agent', 'reporter'])
    expect(payload['affectedGroups']).toEqual(['analytics'])
    expect(Object.hasOwn(payload, 'group')).toBe(false)
  })

  test('the cascade verdict is copied field by field when present, and absent otherwise', () => {
    // Arrange / Act — a half that could not run must be legible in the record:
    // an empty `affectedGroups` alone cannot distinguish "no group granted it"
    // from "the groups store could not be read".
    const withVerdict = buildAccessEditRecord({
      info: {
        actor: { adminName: null, role: null, via: 'cli' },
        action: 'server.remove',
        server: 'notes',
        affectedAgents: ['ci-agent'],
        affectedGroups: [],
        cascade: { agents: 'done', groups: 'failed' },
      },
      clock: () => FIXED_NOW_MS,
    })

    // Assert
    expect((withVerdict.payload as Record<string, unknown>)['cascade']).toEqual({
      agents: 'done',
      groups: 'failed',
    })
    expect(Object.hasOwn(cascadeRecord().payload as Record<string, unknown>, 'cascade')).toBe(false)
  })

  test('an optional grant field is copied only when the grant carries it', () => {
    const record = buildAccessEditRecord({
      info: infoOf({ grant: { tools: '*', resources: '*', prompts: ['weekly_*'] } }),
      clock: () => FIXED_NOW_MS,
    })
    const payload = record.payload as { grant: Record<string, unknown> }
    expect(payload.grant).toEqual({ tools: '*', resources: '*', prompts: ['weekly_*'] })
  })

  test('every string field passes the standard redaction', () => {
    const record = buildAccessEditRecord({
      info: infoOf({ group: 'Bearer sk-live-abcdef1234567890abcd' }),
      clock: () => FIXED_NOW_MS,
    })
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('sk-live-abcdef1234567890abcd')
    expect(serialized).toContain(REDACTED_PLACEHOLDER)
  })

  test('two records built from the same info still get distinct ids', () => {
    expect(grantRecord().id).not.toBe(grantRecord().id)
  })
})

// --- vault.* actions (owner decision S2, 2026-09-03) --------------------------

describe('vault.* access-edit records (S2)', () => {
  test('a vault.set record names the secret, and a vault.rekey record names none', () => {
    // A secret NAME is the only thing the record may carry: the value went
    // into the vault and has no field here to ride in on.
    expect(vaultSetRecord().payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'vault.set',
      vaultEntry: 'github-pat',
    })
    const rekey = vaultRekeyRecord().payload as Record<string, unknown>
    expect(Object.keys(rekey).sort()).toEqual(['action', 'actor'])
    expect(Object.hasOwn(rekey, 'vaultEntry')).toBe(false)
  })

  test('a secret NAME shaped like a real key (sk-…) survives value redaction — it is the fact S2 keeps', () => {
    // Arrange — a legitimate vault name that happens to match the redactor's
    // `sk-` value pattern; the value patterns must not blank a validated name.
    const record = buildAccessEditRecord({
      info: infoOf({ action: 'vault.set', vaultEntry: 'sk-openai-prod-key' }),
      clock: () => FIXED_NOW_MS,
    })

    // Assert
    expect((record.payload as Record<string, unknown>)['vaultEntry']).toBe('sk-openai-prod-key')
    expect(JSON.stringify(record.payload)).not.toContain(REDACTED_PLACEHOLDER)
  })

  test('the builder rejects a vaultEntry outside the vault name pattern WITHOUT echoing it', () => {
    // A caller that passes the value where the name belongs is the mistake
    // this field invites; the vault's own name pattern is the fence, and the
    // error must not repeat the offending string into a diagnostics line.
    const stray = 'Bearer sk-live-abcdef1234567890abcd'
    let thrown: unknown
    try {
      buildAccessEditRecord({ info: infoOf({ action: 'vault.set', vaultEntry: stray }), clock: () => FIXED_NOW_MS })
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).not.toContain(stray)
    expect((thrown as Error).message).not.toContain('sk-live')
    expect((thrown as Error).message).toContain('secret')
  })

  test('verify walks a journal holding vault records without finding a break', async () => {
    const handle = await openWithRows(vaultRows())
    const result = verifyChain(handle)
    expect(result.break).toBeNull()
    expect(result.totalRowCount).toBe(4)
    expect(result.attestedCount).toBe(4)
  })

  test('export + offline verify --report pass, and the vault edit is in the export by name only', async () => {
    const fixture = await buildExport(vaultRows())
    const result = await verifyExport(fixture)
    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(0)
    expect(fixture.recordsText).toContain('"action":"vault.set"')
    expect(fixture.recordsText).toContain('"action":"vault.rekey"')
    expect(fixture.recordsText).toContain('"vaultEntry":"github-pat"')
    expect(fixture.manifest.counts.records).toBe(4)
    expect(fixture.manifest.counts.decisions).toBe(0)
    expect(fixture.manifest.counts.unparsableRows).toBe(0)
  })

  test('a stored vault record reads back as a record, not a skipped row', async () => {
    await openWithRows(vaultRows())
    const result = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir: journalDir })
    expect(result.skippedLineCount).toBe(0)
    expect(result.records.map((record) => (record.payload as { action: string }).action)).toEqual([
      'vault.set',
      'vault.rekey',
    ])
  })

  test('search filters match a vault edit by kind and secret name; decision filters never do', () => {
    const record = vaultSetRecord()
    expect(matchesFilters(record, { kind: 'access-edit' })).toBe(true)
    expect(matchesFilters(record, { text: 'github-pat' })).toBe(true)
    expect(matchesFilters(record, { text: 'alice' })).toBe(true)
    // Swapping a server's credential is not a call an agent made against it.
    expect(matchesFilters(record, { outcome: 'allow' })).toBe(false)
    expect(matchesFilters(record, { agentName: 'ci-agent' })).toBe(false)
  })

  test('the UI journal row renders a vault edit with its action and secret name', () => {
    const rendered = render(
      renderRecordRow(vaultSetRecord(), { hasLatency: false, withSession: false }),
    )
    expect(rendered).toContain('access-edit')
    expect(rendered).toContain('vault.set')
    expect(rendered).toContain('github-pat')
    expect(rendered).toContain('alice')
  })
})

// --- admin.* actions (owner decision 2026-09-06) -----------------------------

describe('admin.* access-edit records', () => {
  /** `admin add bob --role operator`, made by a named owner. */
  function adminAddRecord(): JournalRecord {
    return buildAccessEditRecord({
      info: {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'admin.add',
        admin: 'bob',
        targetRole: 'operator',
      },
      clock: () => FIXED_NOW_MS,
    })
  }

  test('an admin.add record names the admin, the role given and who gave it', () => {
    expect(adminAddRecord().payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'admin.add',
      admin: 'bob',
      targetRole: 'operator',
    })
  })

  test('the fields an action does not use stay ABSENT, not undefined', () => {
    const payload = buildAccessEditRecord({
      info: {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'admin.remove',
        admin: 'bob',
      },
      clock: () => FIXED_NOW_MS,
    }).payload as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual(['action', 'actor', 'admin'])
    expect(Object.hasOwn(payload, 'targetRole')).toBe(false)
    expect(Object.hasOwn(payload, 'recovery')).toBe(false)
  })

  test('a break-glass rotation is recorded with the flag and nobody named', () => {
    const payload = buildAccessEditRecord({
      info: {
        actor: { adminName: null, role: null, via: 'cli' },
        action: 'admin.rotate',
        admin: 'alice',
        recovery: true,
      },
      clock: () => FIXED_NOW_MS,
    }).payload as Record<string, unknown>

    expect(payload['actor']).toEqual({ adminName: null, role: null, via: 'cli' })
    expect(payload['recovery']).toBe(true)
  })

  test('search filters match an admin edit by kind and name; decision filters never do', () => {
    const record = adminAddRecord()

    expect(matchesFilters(record, { kind: 'access-edit' })).toBe(true)
    expect(matchesFilters(record, { text: 'bob' })).toBe(true)
    expect(matchesFilters(record, { text: 'alice' })).toBe(true)
    // Minting an admin is not a call an agent made against a server.
    expect(matchesFilters(record, { outcome: 'allow' })).toBe(false)
    expect(matchesFilters(record, { agentName: 'bob' })).toBe(false)
  })

  test('the UI journal row renders an admin edit with its action, admin and role', () => {
    const rendered = render(
      renderRecordRow(adminAddRecord(), { hasLatency: false, withSession: false }),
    )

    expect(rendered).toContain('access-edit')
    expect(rendered).toContain('admin.add')
    expect(rendered).toContain('bob')
    expect(rendered).toContain('operator')
  })
})
