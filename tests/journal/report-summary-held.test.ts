import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { buildPoolRecord, type PoolRecordInfo } from '../../src/journal/pool-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { AS_OF_CONTRACT, buildJournalReport, type ReportRecordSink } from '../../src/journal/report.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * `summary.md` for held sessions and for a child exported ALONE (ADR-0015
 * amendment 2026-09-23, D2, EX2-EX3): the export names the pool the child
 * belonged to from records outside it — and says so — and one held session
 * attached by one agent's pools in turn reads as the norm, not a forgery.
 * Real journal database, real export, rows built by the product's own
 * `buildPoolRecord`.
 */

const AS_OF = '2026-09-23T12:00:00.000Z'
const ESC = String.fromCharCode(0x1b)

let journalDir: string
let tick = 0

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-report-pools-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const nullSink: ReportRecordSink = { writeLine: () => undefined }
const clock = (): number => Date.parse('2026-09-23T10:00:00.000Z') + tick++ * 1000

function rowOfRecord(record: JournalRecord): JournalRecordRow {
  return {
    sessionId: record.sessionId,
    recordId: record.id,
    ts: record.ts,
    direction: record.direction,
    kind: record.kind,
    method: record.method ?? null,
    doc: JSON.stringify(record),
  }
}

function poolRow(sessionId: string, pool: PoolRecordInfo): JournalRecordRow {
  return rowOfRecord(buildPoolRecord({ sessionId, pool, clock }))
}

function decisionRow(sessionId: string, toolName: string, serverName?: string): JournalRecordRow {
  const record: JournalRecord = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ts: new Date(clock()).toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'decision',
    method: 'tools/call',
    payload: null,
    decision: {
      outcome: 'allow',
      rule: 'default-allow',
      toolName,
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'a'.repeat(64),
      ...(serverName === undefined ? {} : { serverName }),
    } as JournalRecord['decision'] & object,
  }
  return rowOfRecord(record)
}

async function summaryFor(rows: readonly JournalRecordRow[], session?: string): Promise<string> {
  const handle: SqliteHandle = await openJournalDbShared(journalDbPathFor(journalDir))
  if (rows.length > 0) handle.transaction((db) => insertRecordRows(db, rows))
  const now = (): string => AS_OF
  const report = await buildJournalReport(handle, session === undefined ? { now } : { now, session }, nullSink)
  return report.summaryMarkdown
}

function sectionOf(summary: string): string {
  const start = summary.indexOf('## Pool sessions')
  const end = summary.indexOf('## Decisions')
  return summary.slice(start, end)
}

const RESIDENT_JOURNAL: readonly JournalRecordRow[] = [
  poolRow('pool-a', { agentName: 'bot', event: 'open', members: ['memory'] }),
  poolRow('pool-a', { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'held-1', lifetime: 'resident' }),
  decisionRow('held-1', 'store', 'memory'),
  poolRow('pool-a', { agentName: 'bot', event: 'close' }),
  poolRow('pool-b', { agentName: 'bot', event: 'open', members: ['memory'] }),
  poolRow('pool-b', { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'held-1', lifetime: 'resident' }),
  decisionRow('held-1', 'recall', 'memory'),
  poolRow('pool-b', { agentName: 'bot', event: 'close' }),
]

describe('a held session attached by several pool sessions (EX3)', () => {
  test('reads as one agent’s pools in turn, not as a forgery', async () => {
    const summary = await summaryFor(RESIDENT_JOURNAL)

    expect(summary).toContain('### Session held-1 — server memory, agent bot, attached by 2 pool sessions: pool-a, pool-b')
    expect(summary).not.toContain('claimed by')
  })

  test('marks a held child in the Attached line', async () => {
    const summary = await summaryFor(RESIDENT_JOURNAL)

    expect(sectionOf(summary)).toContain('- Attached (server → child session): memory → held-1 (resident)')
  })

  test('claims from two agents are still named as a forgery or a bug', async () => {
    const summary = await summaryFor([
      poolRow('pool-a', { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'held-1' }),
      poolRow('pool-b', { agentName: 'intruder', event: 'attach', serverName: 'memory', childSessionId: 'held-1' }),
      decisionRow('held-1', 'store', 'memory'),
    ])

    expect(summary).toContain('### Session held-1 — claimed by 2 pool sessions: pool-a, pool-b')
  })

  test('a long run of attaches names eight pool sessions and counts the rest', async () => {
    const rows = Array.from({ length: 11 }, (_, index) =>
      poolRow(`pool-${String(index).padStart(2, '0')}`, { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'held-1' }),
    )

    const summary = await summaryFor([...rows, decisionRow('held-1', 'store', 'memory')])

    expect(summary).toContain('attached by 11 pool sessions: pool-00, pool-01, pool-02, pool-03, pool-04, pool-05, pool-06, pool-07, … (+3 more)')
  })
})

describe('a child exported alone (D2, EX2)', () => {
  test('names its pool sessions, agent and server — from records outside the export, and says so', async () => {
    // Act
    const summary = await summaryFor(RESIDENT_JOURNAL, 'held-1')
    const section = sectionOf(summary)

    // Assert
    expect(section).toContain('This export holds no pool session records of its own.')
    expect(section).toContain('### Pool membership of session held-1 (from records outside this export)')
    expect(section).toMatch(/- pool session pool-a — agent bot, server memory, attached at \S+ \(record seq 2\) \(resident\)/)
    expect(section).toMatch(/- pool session pool-b — agent bot, server memory, attached at \S+ \(record seq 6\) \(resident\)/)
    expect(section).toContain('These records are NOT in records.jsonl: neither its digest nor the chain covers them.')
  })

  test('the decision heading says where its pool claims came from', async () => {
    const summary = await summaryFor(RESIDENT_JOURNAL, 'held-1')

    expect(summary).toContain(
      '### Session held-1 — server memory, agent bot, attached by 2 pool sessions: pool-a, pool-b; from records outside this export',
    )
  })

  test('a session no pool attached gets no such block', async () => {
    const summary = await summaryFor([decisionRow('lonely', 'echo', 'files')], 'lonely')

    expect(summary).not.toContain('Pool membership')
    expect(sectionOf(summary)).toContain('This export holds no pool session records.')
  })

  test('a pool session exported alone is not looked up as somebody’s child', async () => {
    const summary = await summaryFor(RESIDENT_JOURNAL, 'pool-a')

    expect(summary).not.toContain('Pool membership')
  })

  test('escapes every value read from the outside records', async () => {
    const summary = await summaryFor(
      [
        poolRow('pool-|x', { agentName: `bot${ESC}[31m`, event: 'attach', serverName: 'mem|ory', childSessionId: 'held-1' }),
        decisionRow('held-1', 'store', 'memory'),
      ],
      'held-1',
    )

    expect(summary).not.toContain(ESC)
    expect(summary).toContain('pool-\\|x')
  })
})
