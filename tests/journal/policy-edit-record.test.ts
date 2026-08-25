import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER, SESSION_ID_PATTERN } from '../../src/config.js'
import { verifyChain } from '../../src/journal/chain-verify.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { buildDecisionRecord } from '../../src/journal/decision.js'
import { parseJournalLine } from '../../src/journal/line-source.js'
import {
  buildPolicyEditRecord,
  POLICY_EDIT_SESSION_ID,
  type PolicyEditInfo,
} from '../../src/journal/policy-edit-record.js'
import { isValidJournalKind, readSessionWithStats } from '../../src/journal/reader.js'
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
 * `kind: 'policy-edit'` records (plan policy-tool-rules-ui §4, O5): one
 * per-tool rule edit with the policy fingerprint before/after, through the
 * SAME journal path as everything else. The compatibility half was written
 * BEFORE the kind existed (plan finding 7, the M5.5 lesson): verify, export +
 * offline verify --report, report summary, search filters, the CLI `--kind`
 * validator and the UI renderer must digest an edit without attributing it
 * to an agent.
 */

const AS_OF = '2026-08-25T12:00:00.000Z'
const FIXED_NOW_MS = Date.parse('2026-08-25T10:00:00.000Z')
const [HASH_BEFORE, HASH_AFTER] = ['a'.repeat(64), 'b'.repeat(64)]
const SOURCE_PATH = '/home/op/.mcp-journal/policy.json'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-edit-record-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

// --- Fixtures ---------------------------------------------------------------

function editOf(overrides: Partial<PolicyEditInfo> = {}): PolicyEditInfo {
  return {
    actor: { adminName: 'alice', role: 'owner', via: 'ui' },
    serverName: 'github',
    toolName: 'create_issue',
    rule: 'deny',
    policyHashBefore: HASH_BEFORE,
    policyHashAfter: HASH_AFTER,
    sourcePath: SOURCE_PATH,
    ...overrides,
  }
}

function denyEditRecord(): JournalRecord {
  return buildPolicyEditRecord({ edit: editOf(), clock: () => FIXED_NOW_MS })
}

function resetEditRecord(): JournalRecord {
  return buildPolicyEditRecord({
    edit: editOf({ actor: { adminName: 'bob', role: 'owner', via: 'cli' }, rule: null }),
    clock: () => FIXED_NOW_MS,
  })
}

function trafficDoc(sessionId: string, id: string): string {
  return JSON.stringify({
    id,
    ts: '2026-08-25T00:00:00.000Z',
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
    editRowOf(denyEditRecord()),
    rowOf(trafficDoc('session-1', 'b')),
    editRowOf(resetEditRecord()),
  ]
}

// --- Export fixture (mirrors tests/journal/probe-record.test.ts) ------------

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

// --- Compatibility: the closed M5 tract digests policy-edit records ---------

describe('policy-edit records and the M5 journal tract', () => {
  test('verify walks a journal holding policy-edit records without finding a break', async () => {
    const handle = await openWithRows(mixedRows())
    const result = verifyChain(handle)
    expect(result.break).toBeNull()
    expect(result.totalRowCount).toBe(4)
    expect(result.attestedCount).toBe(4)
    expect(result.intactThroughSeq).not.toBeNull()
  })

  test('export + offline verify --report pass every check over policy-edit records', async () => {
    const fixture = await buildExport(mixedRows())
    const result = await verifyExport(fixture)
    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(0)
    for (const check of result.checks) {
      expect(check.status).toBe('passed')
    }
    // The edit is IN the export, verbatim, separable by its kind and session.
    expect(fixture.recordsText).toContain('"kind":"policy-edit"')
    expect(fixture.recordsText).toContain(`"sessionId":"${POLICY_EDIT_SESSION_ID}"`)
    expect(fixture.recordsText).toContain(HASH_BEFORE)
    expect(fixture.recordsText).toContain(HASH_AFTER)
  })

  test('the report never counts a policy edit as a decision or an unparsable row', async () => {
    const fixture = await buildExport(mixedRows())
    const counts = fixture.manifest.counts
    expect(counts.records).toBe(4)
    expect(counts.decisions).toBe(0)
    // RED before `kind: 'policy-edit'` existed: an unknown kind fails
    // `parseJournalLine` and lands in `unparsableRows` — an edit must not.
    expect(counts.unparsableRows).toBe(0)
    // An edit that SETS `deny` is not a `deny` decision.
    expect(Object.keys(counts.byOutcome)).toEqual([])
    expect(fixture.summaryMarkdown).toContain('This export holds no decision records.')
  })

  test('summary attributes agent decisions and NOT edits: only the decision row is listed', async () => {
    const decision = buildDecisionRecord({
      sessionId: 'session-1',
      decision: {
        outcome: 'allow',
        rule: 'allow-read',
        serverName: 'github',
        toolName: 'get_issue',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: 'c'.repeat(64),
        agentName: 'ci-agent',
        policyHash: HASH_AFTER,
      },
      clock: () => FIXED_NOW_MS,
    })
    const fixture = await buildExport([...mixedRows(), rowOf(JSON.stringify(decision))])
    expect(fixture.manifest.counts.decisions).toBe(1)
    expect(fixture.manifest.counts.byOutcome).toEqual({ allow: 1 })
    const decisionsSection = fixture.summaryMarkdown.slice(
      fixture.summaryMarkdown.indexOf('## Decisions'),
    )
    expect(decisionsSection).toContain('Session session-1')
    expect(decisionsSection).not.toContain(POLICY_EDIT_SESSION_ID)
  })

  test('a stored policy-edit line reads back as a record (not a skipped row)', async () => {
    await openWithRows(mixedRows())
    const result = await readSessionWithStats(POLICY_EDIT_SESSION_ID, { dir: journalDir })
    expect(result.skippedLineCount).toBe(0)
    expect(result.records).toHaveLength(2)
    expect(result.records[0]?.kind).toBe('policy-edit')
  })

  test('a hand-written policy-edit doc parses as a journal line', () => {
    const record = parseJournalLine(
      JSON.stringify({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ts: '2026-08-25T00:00:00.000Z',
        sessionId: POLICY_EDIT_SESSION_ID,
        direction: 'client→server',
        kind: 'policy-edit',
        payload: { serverName: 'github', toolName: 'create_issue', rule: 'deny' },
      }),
    )
    expect(record).not.toBeNull()
    expect(record?.kind).toBe('policy-edit')
  })

  test('the CLI --kind validator accepts the new kind', () => {
    expect(isValidJournalKind('policy-edit')).toBe(true)
  })
})

// --- Search filters and UI journal ------------------------------------------

describe('policy-edit records in search and the UI journal', () => {
  test('kind/text filters match an edit record; decision filters never do', () => {
    const record = denyEditRecord()
    expect(matchesFilters(record, { kind: 'policy-edit' })).toBe(true)
    expect(matchesFilters(record, { kind: 'decision' })).toBe(false)
    expect(matchesFilters(record, { text: 'create_issue' })).toBe(true)
    expect(matchesFilters(record, { text: 'alice' })).toBe(true)
    expect(matchesFilters(record, { text: HASH_AFTER })).toBe(true)
    // An edit that sets `deny` must never surface under the decision-only
    // outcome/tool filters: nothing was denied, a rule was written.
    expect(matchesFilters(record, { outcome: 'deny' })).toBe(false)
    expect(matchesFilters(record, { toolName: 'create_issue' })).toBe(false)
  })

  test('the journal row renderer shows an edit record readably', () => {
    const rendered = render(
      renderRecordRow(denyEditRecord(), { hasLatency: true, withSession: false }),
    )
    expect(rendered).toContain('policy-edit')
    expect(rendered).toContain('github')
    expect(rendered).toContain('create_issue')
    expect(rendered).toContain('deny')
    expect(rendered).toContain('alice')
  })

  test('a hostile source path is escaped by the journal renderer', () => {
    const record = buildPolicyEditRecord({
      edit: editOf({ sourcePath: '/tmp/<script>alert(1)</script>/policy.json' }),
      clock: () => FIXED_NOW_MS,
    })
    const rendered = render(renderRecordRow(record, { hasLatency: false, withSession: false }))
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
  })
})

// --- The reserved session id -------------------------------------------------

describe('the policy-edit session id', () => {
  test('is a legal session id but can never be a registry server name', () => {
    expect(SESSION_ID_PATTERN.test(POLICY_EDIT_SESSION_ID)).toBe(true)
    expect(REGISTRY_SERVER_NAME_PATTERN.test(POLICY_EDIT_SESSION_ID)).toBe(false)
  })

  test('is distinct from the probe session id', () => {
    expect(POLICY_EDIT_SESSION_ID).not.toBe(PROBE_SESSION_ID)
  })
})

// --- The builder --------------------------------------------------------------

describe('buildPolicyEditRecord', () => {
  test('a rule edit carries actor, names, rule, both hashes and the source path', () => {
    const record = denyEditRecord()
    expect(record.kind).toBe('policy-edit')
    expect(record.sessionId).toBe(POLICY_EDIT_SESSION_ID)
    expect(record.direction).toBe('client→server')
    expect(record.ts).toBe(new Date(FIXED_NOW_MS).toISOString())
    expect(record.method).toBeUndefined()
    expect(record.durationMs).toBeUndefined()
    expect(record.decision).toBeUndefined()
    expect(record.payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      serverName: 'github',
      toolName: 'create_issue',
      rule: 'deny',
      policyHashBefore: HASH_BEFORE,
      policyHashAfter: HASH_AFTER,
      sourcePath: SOURCE_PATH,
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('a reset keeps rule: null verbatim — "cleared" is a fact, not a gap', () => {
    const record = resetEditRecord()
    const payload = record.payload as Record<string, unknown>
    expect(payload['rule']).toBeNull()
    expect(Object.hasOwn(payload, 'rule')).toBe(true)
    expect(payload['actor']).toEqual({ adminName: 'bob', role: 'owner', via: 'cli' })
  })

  test('a first-ever write keeps policyHashBefore: null verbatim', () => {
    const record = buildPolicyEditRecord({
      edit: editOf({ policyHashBefore: null }),
      clock: () => FIXED_NOW_MS,
    })
    const payload = record.payload as Record<string, unknown>
    expect(payload['policyHashBefore']).toBeNull()
    expect(Object.hasOwn(payload, 'policyHashBefore')).toBe(true)
  })

  test('every string field passes the standard redaction', () => {
    const record = buildPolicyEditRecord({
      edit: editOf({ sourcePath: '/tmp/Bearer sk-live-abcdef1234567890abcd/policy.json' }),
      clock: () => FIXED_NOW_MS,
    })
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('sk-live-abcdef1234567890abcd')
    expect(serialized).toContain(REDACTED_PLACEHOLDER)
  })
})
