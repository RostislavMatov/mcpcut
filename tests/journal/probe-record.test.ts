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
import { buildProbeRecord } from '../../src/journal/probe-record.js'
import { readSessionWithStats } from '../../src/journal/reader.js'
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
 * `kind: 'probe'` journal records (M5.5 п.1, Task 5; ADR-0008 §6): the fact
 * and outcome of one server probe, written through the SAME journal path as
 * everything else. The compatibility half of this suite was written BEFORE
 * the kind existed (план: не ломать закрытый M5): chain `verify`, `export` +
 * offline `verify --report`, the report summary, search filters and the UI
 * journal renderer must all digest a probe record without ever attributing
 * it to an agent.
 */

const AS_OF = '2026-08-24T12:00:00.000Z'
const FIXED_NOW_MS = Date.parse('2026-08-24T10:00:00.000Z')

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-probe-record-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

// --- Fixtures ---------------------------------------------------------------

function aliveProbeRecord(serverName = 'github-live'): JournalRecord {
  return buildProbeRecord({
    sessionId: PROBE_SESSION_ID,
    probe: {
      serverName,
      initiator: { trigger: 'lazy', adminName: 'alice' },
      outcome: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 34,
    },
    clock: () => FIXED_NOW_MS,
  })
}

function failedProbeRecord(error: string): JournalRecord {
  return buildProbeRecord({
    sessionId: PROBE_SESSION_ID,
    probe: {
      serverName: 'github-live',
      initiator: { trigger: 'refresh', adminName: 'alice' },
      outcome: 'unreachable',
      error,
    },
    clock: () => FIXED_NOW_MS,
  })
}

function trafficDoc(sessionId: string, id: string): string {
  return JSON.stringify({
    id,
    ts: '2026-08-24T00:00:00.000Z',
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

function probeRowOf(record: JournalRecord): JournalRecordRow {
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
    probeRowOf(aliveProbeRecord()),
    rowOf(trafficDoc('session-1', 'b')),
    probeRowOf(failedProbeRecord('no answer to initialize within 10000ms')),
  ]
}

// --- Export fixture (mirrors tests/journal/report-verify.test.ts) -----------

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

/** Same producing-side bridge as report-verify.test.ts; a no-op once the exporter stamps `summary`. */
function withSummary(manifest: ReportManifest, summaryMarkdown: string): ReportManifest {
  if ((manifest as { summary?: unknown }).summary !== undefined) return manifest
  return {
    ...manifest,
    summary: { file: REPORT_FILES.summary, sha256: sha256Hex(summaryMarkdown) },
  } as ReportManifest
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

// --- Compatibility: the closed M5 tract digests probe records ----------------

describe('probe records and the M5 journal tract', () => {
  test('verify walks a journal holding probe records without finding a break', async () => {
    const handle = await openWithRows(mixedRows())
    const result = verifyChain(handle)
    expect(result.break).toBeNull()
    expect(result.totalRowCount).toBe(4)
    expect(result.attestedCount).toBe(4)
    expect(result.intactThroughSeq).not.toBeNull()
  })

  test('export + offline verify --report pass every check over probe records', async () => {
    const fixture = await buildExport(mixedRows())
    const result = await verifyExport(fixture)
    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(0)
    for (const check of result.checks) {
      expect(check.status).toBe('passed')
    }
    // The probe record is IN the export, verbatim, separable by its kind.
    expect(fixture.recordsText).toContain('"kind":"probe"')
    expect(fixture.recordsText).toContain(`"sessionId":"${PROBE_SESSION_ID}"`)
  })

  test('the report never counts a probe as a decision or an unparsable row', async () => {
    const fixture = await buildExport(mixedRows())
    const counts = fixture.manifest.counts
    expect(counts.records).toBe(4)
    expect(counts.decisions).toBe(0)
    // RED before `kind: 'probe'` existed: an unknown kind fails
    // `parseJournalLine` and lands in `unparsableRows` — a probe must not.
    expect(counts.unparsableRows).toBe(0)
    expect(Object.keys(counts.byOutcome)).toEqual([])
    expect(fixture.summaryMarkdown).toContain('This export holds no decision records.')
  })

  test('summary attributes agent decisions and NOT probes: only the decision row is listed', async () => {
    const decision = buildDecisionRecord({
      sessionId: 'session-1',
      decision: {
        outcome: 'allow',
        rule: 'allow-read',
        serverName: 'github-live',
        toolName: 'get_issue',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: 'a'.repeat(64),
        agentName: 'ci-agent',
        policyHash: 'b'.repeat(64),
      },
      clock: () => FIXED_NOW_MS,
    })
    const fixture = await buildExport([...mixedRows(), rowOf(JSON.stringify(decision))])
    expect(fixture.manifest.counts.decisions).toBe(1)
    expect(fixture.manifest.counts.byOutcome).toEqual({ allow: 1 })
    // The Decisions section names only the agent session, never the probe session.
    const decisionsSection = fixture.summaryMarkdown.slice(
      fixture.summaryMarkdown.indexOf('## Decisions'),
    )
    expect(decisionsSection).toContain('Session session-1')
    expect(decisionsSection).not.toContain(PROBE_SESSION_ID)
  })

  test('a stored probe line reads back as a record (not a skipped row)', async () => {
    await openWithRows(mixedRows())
    const result = await readSessionWithStats(PROBE_SESSION_ID, { dir: journalDir })
    expect(result.skippedLineCount).toBe(0)
    expect(result.records).toHaveLength(2)
    expect(result.records[0]?.kind).toBe('probe')
  })

  test('a hand-written probe doc parses as a journal line', () => {
    // Read-compat guard independent of the builder: journal docs can come
    // from another writer or a hand edit and still must parse by shape.
    const record = parseJournalLine(
      JSON.stringify({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ts: '2026-08-24T00:00:00.000Z',
        sessionId: PROBE_SESSION_ID,
        direction: 'client→server',
        kind: 'probe',
        method: 'initialize',
        payload: { serverName: 'github-live', outcome: 'alive' },
      }),
    )
    expect(record).not.toBeNull()
    expect(record?.kind).toBe('probe')
  })
})

// --- Search filters and UI journal ------------------------------------------

describe('probe records in search and the UI journal', () => {
  test('kind/text filters match a probe record; decision filters never do', () => {
    const record = aliveProbeRecord('github-live')
    expect(matchesFilters(record, { kind: 'probe' })).toBe(true)
    expect(matchesFilters(record, { kind: 'decision' })).toBe(false)
    expect(matchesFilters(record, { text: 'github-live' })).toBe(true)
    expect(matchesFilters(record, { text: 'alive' })).toBe(true)
    // A probe is not a decision: the outcome/tool filters (decision fields)
    // must not claim it.
    expect(matchesFilters(record, { outcome: 'alive' })).toBe(false)
    expect(matchesFilters(record, { toolName: 'github-live' })).toBe(false)
  })

  test('the journal row renderer shows a probe record readably', () => {
    const rendered = render(
      renderRecordRow(aliveProbeRecord('github-live'), { hasLatency: true, withSession: false }),
    )
    expect(rendered).toContain('probe')
    expect(rendered).toContain('github-live')
    expect(rendered).toContain('initialize')
    expect(rendered).toContain('34 ms')
  })

  test('a hostile error message is escaped by the journal renderer', () => {
    const rendered = render(
      renderRecordRow(failedProbeRecord('<script>alert(1)</script> refused'), {
        hasLatency: false,
        withSession: false,
      }),
    )
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
  })
})

// --- The reserved session id -------------------------------------------------

describe('the probe session id', () => {
  test('is a legal session id but can never be a registry server name', () => {
    expect(SESSION_ID_PATTERN.test(PROBE_SESSION_ID)).toBe(true)
    expect(REGISTRY_SERVER_NAME_PATTERN.test(PROBE_SESSION_ID)).toBe(false)
  })
})

// --- The builder --------------------------------------------------------------

describe('buildProbeRecord', () => {
  test('an alive probe carries initiator, outcome, via and latency', () => {
    const record = aliveProbeRecord()
    expect(record.kind).toBe('probe')
    expect(record.sessionId).toBe(PROBE_SESSION_ID)
    expect(record.direction).toBe('client→server')
    expect(record.ts).toBe(new Date(FIXED_NOW_MS).toISOString())
    expect(record.method).toBe('initialize')
    expect(record.durationMs).toBe(34)
    expect(record.payload).toEqual({
      serverName: 'github-live',
      initiator: { trigger: 'lazy', adminName: 'alice' },
      outcome: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 34,
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('a failed probe carries the error and omits latency/method', () => {
    const record = failedProbeRecord('no answer to initialize within 10000ms')
    expect(record.method).toBeUndefined()
    expect(record.durationMs).toBeUndefined()
    expect(record.payload).toEqual({
      serverName: 'github-live',
      initiator: { trigger: 'refresh', adminName: 'alice' },
      outcome: 'unreachable',
      error: 'no answer to initialize within 10000ms',
    })
  })

  test('the error string passes the standard redaction even though it arrives pre-redacted', () => {
    const record = failedProbeRecord('upstream said: Bearer sk-live-abcdef1234567890abcd')
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('sk-live-abcdef1234567890abcd')
    expect(serialized).toContain(REDACTED_PLACEHOLDER)
  })

  test('known secrets are scrubbed from every probe field', () => {
    const secret = 'plaintext-header-value-123'
    const record = buildProbeRecord({
      sessionId: PROBE_SESSION_ID,
      probe: {
        serverName: 'github-live',
        initiator: { trigger: 'registration' },
        outcome: 'error',
        error: `the server echoed ${secret} in its failure`,
      },
      knownSecrets: [secret],
      clock: () => FIXED_NOW_MS,
    })
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain(REDACTED_PLACEHOLDER)
  })
})
