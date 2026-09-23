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
import { POOL_NAMING_NOTE } from '../../src/journal/report-summary-pools.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * The pool half of `summary.md` (ADR-0015, phase 5, R1-R4): the "Pool
 * sessions" section, the pool note on a child session's heading, and the
 * `server` column. Rows go through the real journal database and the real
 * export, and every pool row is built by the product's own `buildPoolRecord`.
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

const ONE_POOL: readonly JournalRecordRow[] = [
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'open', members: ['everything', 'memory'] }),
  decisionRow('child-1', 'echo', 'everything'),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'attach', serverName: 'everything', childSessionId: 'child-1' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'attach', serverName: 'memory', childSessionId: 'child-2' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'attach-refused', serverName: 'http', reason: 'handshake-failed' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'detach', serverName: 'memory', reason: 'ungranted' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'attach', serverName: 'memory', childSessionId: 'child-5' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'dropped', reason: 'name-too-long' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'dropped', reason: 'name-too-long' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'dropped', reason: 'unsupported-method' }),
  poolRow('pool-p', { agentName: 'smoke-bot', event: 'close' }),
]

describe('summary.md: the Pool sessions section', () => {
  test('sits between the counts and the decisions', async () => {
    const summary = await summaryFor(ONE_POOL)

    expect(summary.indexOf('## Counts')).toBeLessThan(summary.indexOf('## Pool sessions'))
    expect(summary.indexOf('## Pool sessions')).toBeLessThan(summary.indexOf('## Decisions'))
  })

  test('explains what a pool session is, in the code own words', async () => {
    const summary = await summaryFor(ONE_POOL)

    expect(sectionOf(summary)).toContain(POOL_NAMING_NOTE)
  })

  test('names the agent, the children, the refusals, the departures and the refused frames', async () => {
    const section = sectionOf(await summaryFor(ONE_POOL))

    expect(section).toContain('### Pool session pool-p — agent smoke-bot')
    expect(section).toMatch(/- Opened: 2026-09-23T\S+Z · Closed: 2026-09-23T\S+Z/)
    expect(section).toContain(
      '- Attached (server → child session): everything → child-1; memory → child-2; memory → child-5',
    )
    expect(section).toContain('- Did not attach: http (handshake-failed)')
    expect(section).toContain('- Left the pool: memory (ungranted)')
    expect(section).toContain('- Frames the pool refused: name-too-long ×2; unsupported-method ×1')
    expect(section).not.toContain('Not in this export')
  })

  test('says an open or close record is missing instead of leaving a gap', async () => {
    const section = sectionOf(
      await summaryFor([
        poolRow('pool-p', { agentName: 'bot', event: 'attach', serverName: 'a', childSessionId: 'c' }),
      ]),
    )

    expect(section).toContain('- Opened: no open record in this export · Closed: no close record in this export')
    expect(section).not.toContain('Did not attach')
    expect(section).not.toContain('Left the pool')
    expect(section).not.toContain('Frames the pool refused')
  })

  test('says (none) when a pool session attached nothing', async () => {
    const section = sectionOf(await summaryFor([poolRow('pool-p', { agentName: 'bot', event: 'open' })]))

    expect(section).toContain('- Attached (server → child session): (none)')
  })

  test('lists every agent name a forged session carried', async () => {
    const section = sectionOf(
      await summaryFor([
        poolRow('pool-p', { agentName: 'bot', event: 'open' }),
        poolRow('pool-p', { agentName: 'mallory', event: 'close' }),
      ]),
    )

    expect(section).toContain('### Pool session pool-p — agent bot, mallory')
  })

  test('says so plainly when the export holds no pool records', async () => {
    const summary = await summaryFor([decisionRow('s-1', 'echo', 'files')])

    expect(sectionOf(summary)).toContain('This export holds no pool session records.')
    expect(sectionOf(summary)).not.toContain(POOL_NAMING_NOTE)
  })

  test('counts pool records it could not read, pointing at records.jsonl', async () => {
    const unreadable = { ...buildPoolRecord({ sessionId: 'pool-p', pool: { agentName: 'bot', event: 'open' } }), payload: [] }

    const section = sectionOf(await summaryFor([rowOfRecord(unreadable)]))

    expect(section).toContain('1 pool record(s) could not be read; they are in records.jsonl verbatim.')
  })

  test('marks a reason-less refusal and departure as absent', async () => {
    const section = sectionOf(
      await summaryFor([
        poolRow('pool-p', { agentName: 'bot', event: 'attach-refused', serverName: 'http' }),
        poolRow('pool-p', { agentName: 'bot', event: 'detach', serverName: 'memory' }),
      ]),
    )

    expect(section).toContain('- Did not attach: http ((absent))')
    expect(section).toContain('- Left the pool: memory ((absent))')
  })

  test('keeps the as-of contract verbatim', async () => {
    expect(await summaryFor(ONE_POOL)).toContain(AS_OF_CONTRACT)
  })
})

describe('summary.md: a session-scoped export of a pool session (R3)', () => {
  test('names the child sessions the export leaves out and how to get them', async () => {
    const section = sectionOf(await summaryFor(ONE_POOL, 'pool-p'))

    expect(section).toContain(
      '- Not in this export: child session(s) child-1, child-2, child-5 — their decisions are ' +
        'recorded under those sessions. Export the whole journal (no --session) to include them.',
    )
  })
})

describe('summary.md: decision tables of pool children (R4)', () => {
  test('carries a server column between rule and tool', async () => {
    const summary = await summaryFor(ONE_POOL)

    expect(summary).toContain('| ts | outcome | rule | server | tool | actor | policyHash | grantsHash | argsHash |')
    expect(summary).toContain('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    expect(summary).toMatch(/\| allow \| default-allow \| everything \| echo \|/)
  })

  test('marks a decision with no serverName as absent', async () => {
    const summary = await summaryFor([decisionRow('s-1', 'echo')])

    expect(summary).toMatch(/\| allow \| default-allow \| \(absent\) \| echo \|/)
  })

  test('notes the pool on the heading of a child session, even when its decisions precede the attach (R2)', async () => {
    const summary = await summaryFor(ONE_POOL)

    expect(summary).toContain('### Session child-1 — server everything, pool session pool-p (agent smoke-bot)')
  })

  test('shows every claim on a child two pool sessions named', async () => {
    const summary = await summaryFor([
      poolRow('pool-a', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'child-1' }),
      poolRow('pool-b', { agentName: 'eve', event: 'attach', serverName: 'alpha', childSessionId: 'child-1' }),
      decisionRow('child-1', 'echo', 'alpha'),
    ])

    expect(summary).toContain('### Session child-1 — claimed by 2 pool sessions: pool-a, pool-b')
  })

  test('leaves the heading of a session no pool named alone', async () => {
    const summary = await summaryFor([decisionRow('s-1', 'echo', 'files')])

    expect(summary).toMatch(/^### Session s-1$/m)
  })
})

describe('summary.md: hostile values in pool records', () => {
  test('escapes every value a pool record carries, and strips terminal escapes', async () => {
    const hostileAgent = '<img src=x onerror=alert(1)>'
    const summary = await summaryFor([
      poolRow('pool-p', { agentName: hostileAgent, event: 'open' }),
      poolRow('pool-p', { agentName: hostileAgent, event: 'attach', serverName: 'a|b', childSessionId: `c${ESC}[2J` }),
      poolRow('pool-p', { agentName: hostileAgent, event: 'detach', serverName: 'a|b', reason: '[x](javascript:alert(2))' }),
      poolRow('pool-p', { agentName: hostileAgent, event: 'dropped', reason: '*bold* `code`' }),
      decisionRow(`c${ESC}[2J`, 'echo', 'a|b'),
    ])

    // The naming note is this codebase's own text (with its own code spans),
    // so it is taken out before looking for unescaped markup.
    const pool = sectionOf(summary).replace(POOL_NAMING_NOTE, '')
    expect(summary).not.toContain(ESC)
    expect(pool).not.toMatch(/(?<!\\)[<>[\]`*|]/)
    expect(pool).toContain('\\<img src=x onerror=alert(1)\\>')
    expect(pool).toContain('a\\|b')
    expect(pool).toContain('\\[x\\](javascript:alert(2))')
    const heading = summary.split('\n').find((line) => line.startsWith('### Session c')) ?? ''
    expect(heading).not.toMatch(/(?<!\\)[<>[\]`|]/)
  })
})
