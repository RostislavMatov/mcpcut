import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { insertRecordRows, journalDbPathFor, openJournalDbShared, type JournalRecordRow } from '../../src/journal/db.js'
import { buildPoolRecord, type PoolRecordInfo } from '../../src/journal/pool-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  MAX_POOL_LINK_SCAN_ROWS,
  MAX_POOL_LINKS_PER_SESSION,
  poolLinksOutsideExport,
  SELECT_POOL_ROWS_NAMING_SESSION,
} from '../../src/journal/report-pool-links.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * The pool sessions that attached a child exported alone (D2, EX1), read from
 * a REAL journal database: only an `attach` naming the child counts, through
 * the same payload reader as the export's own pool ledger, by index.
 */

const CHILD = '01CHILD0000000000000000000'

let journalDir: string
let handle: SqliteHandle

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-pool-links-'))
  handle = await openJournalDbShared(journalDbPathFor(journalDir))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

let tick = 0
function poolRecord(sessionId: string, pool: PoolRecordInfo): JournalRecord {
  return buildPoolRecord({ sessionId, pool, clock: () => Date.parse('2026-09-23T10:00:00.000Z') + tick++ * 1000 })
}

function rowOf(record: JournalRecord, doc = JSON.stringify(record)): JournalRecordRow {
  return {
    sessionId: record.sessionId,
    recordId: record.id,
    ts: record.ts,
    direction: record.direction,
    kind: record.kind,
    method: null,
    doc,
  }
}

function insert(rows: readonly JournalRecordRow[]): void {
  handle.transaction((db) => insertRecordRows(db, rows))
}

function attach(pool: string, child = CHILD, extra: Partial<PoolRecordInfo> = {}): JournalRecord {
  return poolRecord(pool, { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: child, ...extra })
}

describe('poolLinksOutsideExport', () => {
  test('names the pool session, agent, server and time of the one attach', () => {
    // Arrange
    const record = attach('01POOLA', CHILD, { lifetime: 'resident' })
    insert([rowOf(record)])

    // Act
    const found = poolLinksOutsideExport(handle, CHILD)

    // Assert
    expect(found.links).toEqual([
      {
        poolSessionId: '01POOLA',
        agentName: 'bot',
        serverName: 'memory',
        attachedAt: record.ts,
        seq: 1,
        lifetime: 'resident',
      },
    ])
    expect(found.omittedCount).toBe(0)
    expect(found.isScanCapped).toBe(false)
  })

  test('finds every pool session of a resident that was attached again and again', () => {
    insert([rowOf(attach('01POOLA')), rowOf(attach('01POOLB'))])

    const found = poolLinksOutsideExport(handle, CHILD)

    expect(found.links.map((link) => link.poolSessionId)).toEqual(['01POOLA', '01POOLB'])
  })

  test('never counts the exported session itself, nor another child’s attach', () => {
    insert([rowOf(attach(CHILD)), rowOf(attach('01POOLA', '01OTHERCHILD0000000000000'))])

    expect(poolLinksOutsideExport(handle, CHILD).links).toEqual([])
  })

  test('counts only an attach: a detach naming the child states no membership', () => {
    insert([rowOf(poolRecord('01POOLA', { agentName: 'bot', event: 'detach', serverName: 'memory', reason: CHILD }))])

    expect(poolLinksOutsideExport(handle, CHILD).links).toEqual([])
  })

  test('a `reason` that happens to hold the id is not a link', () => {
    insert([
      rowOf(poolRecord('01POOLA', { agentName: 'bot', event: 'attach-refused', serverName: 'memory', reason: `x ${CHILD}` })),
    ])

    const found = poolLinksOutsideExport(handle, CHILD)

    expect(found.links).toEqual([])
    expect(found.unreadableCount).toBe(0)
  })

  test('a row that does not read is counted, never guessed at', () => {
    const record = attach('01POOLA')
    insert([rowOf(record, `{"not a record": "${CHILD}"}`)])

    const found = poolLinksOutsideExport(handle, CHILD)

    expect(found.links).toEqual([])
    expect(found.unreadableCount).toBe(1)
  })

  test('keeps a bounded number of links, and counts the rest', () => {
    const pools = Array.from({ length: MAX_POOL_LINKS_PER_SESSION + 3 }, (_, index) => `01POOL${String(index).padStart(3, '0')}`)
    insert(pools.map((pool) => rowOf(attach(pool))))

    const found = poolLinksOutsideExport(handle, CHILD)

    expect(found.links).toHaveLength(MAX_POOL_LINKS_PER_SESSION)
    expect(found.omittedCount).toBe(3)
  })

  test('stops looking after a bounded number of rows, and says so', () => {
    const noise = Array.from({ length: MAX_POOL_LINK_SCAN_ROWS + 1 }, () =>
      rowOf(poolRecord('01NOISE', { agentName: 'bot', event: 'detach', serverName: 'memory', reason: CHILD })),
    )
    insert(noise)

    const found = poolLinksOutsideExport(handle, CHILD)

    expect(found.isScanCapped).toBe(true)
    expect(found.links).toEqual([])
  })

  test('query plan: walks sessions and seeks pool rows by index, never a full scan', () => {
    const plan = (handle.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_POOL_ROWS_NAMING_SESSION}`).all('x', 'x', 1) as {
      detail: string
    }[])
      .map((row) => row.detail)
      .join(' | ')

    expect(plan).toContain('idx_journal_session_kind')
    expect(plan).not.toMatch(/SCAN journal_records(?! USING)/)
  })
})
