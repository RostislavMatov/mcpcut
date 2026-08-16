import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { APPROVALS_IMPORT_BATCH_ROWS } from '../../../src/config.js'
import { checkRecentApproval } from '../../../src/policy/approvals/grants.js'
import {
  APPROVALS_QUEUE_MARKER,
  importLegacyApprovals,
} from '../../../src/policy/approvals/queue-import.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'
import {
  approvalsDbPath,
  bumpChangeSeq,
  openApprovalsDb,
  type ApprovalsDb,
} from '../../../src/policy/approvals/queue-db.js'
import { createJsonStore } from '../../../src/policy/store.js'

/**
 * The storage substrate of the approvals queue: the tables live in the SAME
 * `state.db` the document stores use (ADR-0006: two databases, not three), so
 * these tests assert both the schema and its coexistence with `documents`.
 *
 * `baseDir` is always a SUBDIRECTORY of the journal directory (that is the
 * queue's contract — `<journalDir>/approvals`), because the database path is
 * derived from its parent.
 */

let journalDir: string
let baseDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-db-test-'))
  baseDir = join(journalDir, 'approvals')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function tableNames(db: ApprovalsDb): string[] {
  const rows = db.handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}

function enqueueRequest(overrides: Record<string, unknown> = {}) {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write' as const,
    args: { title: 'hello' },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

/** Writes a row the queue's own code would never produce (malformed content, legacy shapes). */
function insertRawRow(
  db: ApprovalsDb,
  row: { approvalId: string; status: string; doc: string; changeSeq: number },
): void {
  db.handle.db
    .prepare(
      'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
        'requested_at, expires_at, change_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.approvalId,
      row.status,
      row.doc,
      'github',
      'create_issue',
      'hash-1',
      new Date(0).toISOString(),
      new Date(0).toISOString(),
      row.changeSeq,
    )
}

function metaRows(db: ApprovalsDb): { id: number; change_seq: number }[] {
  return db.handle.db.prepare('SELECT id, change_seq FROM approvals_meta').all() as {
    id: number
    change_seq: number
  }[]
}

describe('openApprovalsDb: schema', () => {
  test('creates the approvals tables in state.db next to the queue directory', async () => {
    const db = await openApprovalsDb(baseDir)

    expect(db.dbPath).toBe(join(journalDir, 'state.db'))
    expect(approvalsDbPath(baseDir)).toBe(join(journalDir, 'state.db'))
    await expect(stat(join(journalDir, 'state.db'))).resolves.toBeDefined()
    expect(tableNames(db)).toEqual(expect.arrayContaining(['approvals', 'approvals_meta']))
  })

  test('seeds approvals_meta with exactly one zeroed row', async () => {
    const db = await openApprovalsDb(baseDir)

    expect(metaRows(db)).toEqual([{ id: 1, change_seq: 0 }])
  })

  test('the approvals table is STRICT and rejects an unknown status', async () => {
    const db = await openApprovalsDb(baseDir)

    expect(() =>
      db.handle.db
        .prepare(
          'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, ' +
            'args_hash, requested_at, expires_at, change_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'bogus', '{}', 's', 't', 'h', 'a', 'b', 1),
    ).toThrow()
  })

  test('reopening is idempotent and preserves the sequence', async () => {
    const first = await openApprovalsDb(baseDir)
    const bumped = first.handle.transaction((database) => bumpChangeSeq(database))

    const second = await openApprovalsDb(baseDir)

    expect(bumped).toBe(1)
    expect(metaRows(second)).toEqual([{ id: 1, change_seq: 1 }])
    expect(tableNames(second)).toEqual(expect.arrayContaining(['approvals', 'approvals_meta']))
  })

  test('coexists with the document stores in the same database', async () => {
    const store = createJsonStore<{ version: 1; count: number }>(join(journalDir, 'agents.json'), {
      validate: (raw) => raw as { version: 1; count: number },
      defaultValue: { version: 1, count: 0 },
    })
    await store.update((current) => ({ ...current, count: 7 }))

    const db = await openApprovalsDb(baseDir)
    await createApprovalQueue({ baseDir }).enqueue({
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      args: { title: 'hello' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['approvals', 'approvals_meta', 'documents', 'migrated_documents']),
    )
    // Neither store trampled the other's rows.
    await expect(store.read()).resolves.toEqual({ version: 1, count: 7 })
    await expect(createApprovalQueue({ baseDir }).list()).resolves.toHaveLength(1)
  })
})

describe('bumpChangeSeq', () => {
  test('returns a strictly increasing sequence', async () => {
    const db = await openApprovalsDb(baseDir)

    const seqs = [1, 2, 3].map(() => db.handle.transaction((database) => bumpChangeSeq(database)))

    expect(seqs).toEqual([1, 2, 3])
  })

  test('the queue stamps every write with a fresh sequence', async () => {
    const queue = createApprovalQueue({ baseDir })
    const db = await openApprovalsDb(baseDir)

    const { approvalId } = await queue.enqueue({
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      args: null,
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })
    const afterEnqueue = metaRows(db)[0]?.change_seq
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })
    const afterResolve = metaRows(db)[0]?.change_seq

    expect(afterEnqueue).toBe(1)
    expect(afterResolve).toBe(2)
    const row = db.handle.db
      .prepare('SELECT status, change_seq FROM approvals WHERE approval_id = ?')
      .get(approvalId) as { status: string; change_seq: number }
    expect(row.status).toBe('resolved')
    expect(row.change_seq).toBe(2)
  })
})

describe('importLegacyApprovals: the file queue an M4 build left behind', () => {
  const LEGACY_IDS = {
    pending: ['01AAAAAAAAAAAAAAAAAAAAAAAA', '01BBBBBBBBBBBBBBBBBBBBBBBB'],
    resolved: ['01CCCCCCCCCCCCCCCCCCCCCCCC'],
  }

  function legacyDoc(approvalId: string, resolvedAtIso?: string): string {
    const iso = new Date().toISOString()
    return JSON.stringify({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: { title: 'hello' },
      argsHash: 'hash-1',
      sessionId: 'session-1',
      requestedAt: iso,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...(resolvedAtIso === undefined
        ? {}
        : { resolution: { outcome: 'approved', actor: 'alice' }, resolvedAt: resolvedAtIso }),
    })
  }

  async function writeLegacyFile(subdir: string, name: string, content: string): Promise<void> {
    await mkdir(join(baseDir, subdir), { recursive: true })
    await writeFile(join(baseDir, subdir, name), content, 'utf8')
  }

  async function seedLegacyQueue(resolvedAtIso = new Date().toISOString()): Promise<void> {
    for (const id of LEGACY_IDS.pending) {
      await writeLegacyFile('pending', `${id}.json`, legacyDoc(id))
    }
    for (const id of LEGACY_IDS.resolved) {
      await writeLegacyFile('resolved', `${id}.json`, legacyDoc(id, resolvedAtIso))
    }
  }

  function rows(db: ApprovalsDb): { approval_id: string; status: string; change_seq: number }[] {
    return db.handle.db
      .prepare('SELECT approval_id, status, change_seq FROM approvals ORDER BY change_seq')
      .all() as { approval_id: string; status: string; change_seq: number }[]
  }

  test('the first open imports every pending and resolved file, in ULID order', async () => {
    await seedLegacyQueue()

    const db = await openApprovalsDb(baseDir)

    expect(rows(db).map((row) => [row.approval_id, row.status])).toEqual([
      [LEGACY_IDS.pending[0], 'pending'],
      [LEGACY_IDS.pending[1], 'pending'],
      [LEGACY_IDS.resolved[0], 'resolved'],
    ])
    expect(rows(db).map((row) => row.change_seq)).toEqual([1, 2, 3])
    // The files stay on disk: they are a cold backup until wave 5.
    await expect(readFile(join(baseDir, 'pending', `${LEGACY_IDS.pending[0]}.json`))).resolves
      .toBeDefined()
  })

  test('a second import of the same directories creates no duplicates', async () => {
    await seedLegacyQueue()
    const db = await openApprovalsDb(baseDir)

    const secondPass = await importLegacyApprovals(db)

    expect(secondPass).toBe(0)
    expect(rows(db)).toHaveLength(3)
  })

  test('two concurrent imports of the same directories create no duplicates', async () => {
    await seedLegacyQueue()
    // A database opened with the import already done cannot show the race, so
    // the marker is cleared to put both callers back at the starting line.
    const db = await openApprovalsDb(baseDir)
    db.handle.db.prepare('DELETE FROM approvals').run()
    db.handle.db.prepare("DELETE FROM migrated_documents WHERE name = 'approvals-queue'").run()

    const counts = await Promise.all([importLegacyApprovals(db), importLegacyApprovals(db)])

    expect(counts.filter((count) => count > 0)).toEqual([3])
    expect(rows(db)).toHaveLength(3)
  })

  test('malformed and misnamed files are skipped, the rest still import', async () => {
    await seedLegacyQueue()
    await writeLegacyFile('pending', '01DDDDDDDDDDDDDDDDDDDDDDDD.json', 'not json')
    await writeLegacyFile('pending', '01EEEEEEEEEEEEEEEEEEEEEEEE.json', JSON.stringify({ nope: 1 }))
    await writeLegacyFile('pending', 'notes.txt', 'ignored')
    // Carries somebody else's approvalId: forged or moved, must not be imported.
    await writeLegacyFile(
      'resolved',
      '01FFFFFFFFFFFFFFFFFFFFFFFF.json',
      legacyDoc('01CCCCCCCCCCCCCCCCCCCCCCCC', new Date().toISOString()),
    )

    const db = await openApprovalsDb(baseDir)

    expect(rows(db)).toHaveLength(3)
  })

  test('a marker without rows is legitimate: retention empties the table', async () => {
    await seedLegacyQueue()
    const db = await openApprovalsDb(baseDir)
    db.handle.db.prepare('DELETE FROM approvals').run()

    // Re-running the import must stay quiet — NOT the loud refusal the document
    // stores raise, because an emptied queue is the normal end state here.
    await expect(importLegacyApprovals(db)).resolves.toBe(0)
    expect(rows(db)).toEqual([])
  })

  test('imported records are usable: a legacy pending resolves, a legacy approval grants', async () => {
    const nowMs = Date.now()
    await seedLegacyQueue(new Date(nowMs - 1000).toISOString())
    const queue = createApprovalQueue({ baseDir })

    const resolved = await queue.resolve(LEGACY_IDS.pending[0] as string, {
      outcome: 'approved',
      actor: 'alice',
    })
    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(resolved.ok).toBe(true)
    expect(granted).toBe(true)
    await expect(queue.list()).resolves.toHaveLength(1) // the other legacy pending
  })

  /** Zero-padded so ascending file/approvalId order is also ascending string order. */
  function legacyId(index: number): string {
    return `LEG${String(index).padStart(6, '0')}`
  }

  async function seedManyPending(count: number): Promise<void> {
    await Promise.all(
      Array.from({ length: count }, (_, index) => {
        const id = legacyId(index)
        return writeLegacyFile('pending', `${id}.json`, legacyDoc(id))
      }),
    )
  }

  function markerRow(db: ApprovalsDb): unknown {
    return db.handle.db
      .prepare('SELECT 1 FROM migrated_documents WHERE name = ?')
      .get(APPROVALS_QUEUE_MARKER)
  }

  test('a backlog larger than one batch imports across multiple chunked transactions', async () => {
    // Open first (no legacy files yet) so the automatic first-touch import
    // sees nothing and never runs a transaction the spy would have to discount.
    const db = await openApprovalsDb(baseDir)
    const total = APPROVALS_IMPORT_BATCH_ROWS * 2 + 88 // -> chunks of 256, 256, 88
    await seedManyPending(total)
    const transactionSpy = vi.spyOn(db.handle, 'transaction')

    const imported = await importLegacyApprovals(db)

    expect(imported).toBe(total)
    expect(transactionSpy).toHaveBeenCalledTimes(3)
    expect(rows(db)).toHaveLength(total)
    expect(markerRow(db)).toBeDefined()
  })

  test('a marker planted between chunks (simulated concurrent import) stops the run without double-insert', async () => {
    const db = await openApprovalsDb(baseDir)
    const total = APPROVALS_IMPORT_BATCH_ROWS + 44 // -> two chunks: 256, then 44
    await seedManyPending(total)
    // Captured before spying: the real implementation, called directly so the
    // spy's own call counter is not re-entered.
    const originalTransaction = db.handle.transaction
    let chunkCalls = 0
    vi.spyOn(db.handle, 'transaction').mockImplementation((fn) => {
      chunkCalls += 1
      const result = originalTransaction(fn)
      if (chunkCalls === 1) {
        // Another process finishes the same import right after our first
        // chunk commits — the exact race `insertLegacyChunk` re-checks for.
        db.handle.db
          .prepare('INSERT OR IGNORE INTO migrated_documents (name) VALUES (?)')
          .run(APPROVALS_QUEUE_MARKER)
      }
      return result
    })

    const imported = await importLegacyApprovals(db)

    expect(imported).toBe(APPROVALS_IMPORT_BATCH_ROWS) // only the first chunk landed
    expect(chunkCalls).toBe(2) // second chunk ran, saw the marker, and stopped
    expect(rows(db)).toHaveLength(APPROVALS_IMPORT_BATCH_ROWS) // no double insert
  })
})

describe('changesSince', () => {
  test('a null baseline reports the current sequence and announces nothing', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(enqueueRequest())

    const baseline = await queue.changesSince(null)

    // The seed must never replay what is already there (the watcher contract).
    expect(baseline).toEqual({ latestSeq: 1, newPending: [], resolvedIds: [] })
  })

  test('an enqueue after the baseline surfaces as a new pending entry', async () => {
    const queue = createApprovalQueue({ baseDir })
    const baseline = await queue.changesSince(null)

    const { approvalId } = await queue.enqueue(enqueueRequest())
    const changes = await queue.changesSince(baseline.latestSeq)

    expect(changes.latestSeq).toBeGreaterThan(baseline.latestSeq)
    expect(changes.resolvedIds).toEqual([])
    expect(changes.newPending).toHaveLength(1)
    expect(changes.newPending[0]).toMatchObject({
      approvalId,
      toolName: 'create_issue',
      expired: false,
    })
  })

  test('a resolve reports the id in resolvedIds and never as pending', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(enqueueRequest())
    const baseline = await queue.changesSince(null)

    await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })
    const changes = await queue.changesSince(baseline.latestSeq)

    expect(changes.resolvedIds).toEqual([approvalId])
    expect(changes.newPending).toEqual([])
  })

  test('an entry enqueued and resolved within one window is only ever resolved', async () => {
    const queue = createApprovalQueue({ baseDir })
    const baseline = await queue.changesSince(null)

    const { approvalId } = await queue.enqueue(enqueueRequest())
    await queue.resolve(approvalId, { outcome: 'denied' })
    const changes = await queue.changesSince(baseline.latestSeq)

    // One row, one status: the watcher must not announce a request that is
    // already settled (the parity case with the old snapshot diff).
    expect(changes.newPending).toEqual([])
    expect(changes.resolvedIds).toEqual([approvalId])
  })

  test('the reported sequence grows strictly and never re-reports a seen change', async () => {
    const queue = createApprovalQueue({ baseDir })

    const first = await queue.changesSince(null)
    await queue.enqueue(enqueueRequest())
    const second = await queue.changesSince(first.latestSeq)
    const third = await queue.changesSince(second.latestSeq)

    expect(second.latestSeq).toBeGreaterThan(first.latestSeq)
    expect(third.latestSeq).toBe(second.latestSeq)
    expect(third).toEqual({ latestSeq: second.latestSeq, newPending: [], resolvedIds: [] })
  })

  test('a malformed doc row is skipped, not thrown', async () => {
    const db = await openApprovalsDb(baseDir)
    insertRawRow(db, { approvalId: '01AAA', status: 'pending', doc: 'not json', changeSeq: 1 })

    await expect(createApprovalQueue({ baseDir }).changesSince(0)).resolves.toEqual({
      latestSeq: 0,
      newPending: [],
      resolvedIds: [],
    })
  })
})

describe('resolve under contention: exactly one winner', () => {
  test('two queue instances racing the same id produce exactly one ok result', async () => {
    const a = createApprovalQueue({ baseDir })
    const b = createApprovalQueue({ baseDir })
    const { approvalId } = await a.enqueue({
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      args: { title: 'hello' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })

    const [first, second] = await Promise.all([
      a.resolve(approvalId, { outcome: 'approved', actor: 'alice' }),
      b.resolve(approvalId, { outcome: 'denied', actor: 'bob' }),
    ])

    expect([first, second].filter((result) => result.ok)).toHaveLength(1)
    // The loser reports the shared not-found reason and nothing was written twice.
    const loser = first.ok ? second : first
    expect(loser).toEqual({ ok: false, reason: 'not-found-or-already-resolved' })

    const db = await openApprovalsDb(baseDir)
    const rows = db.handle.db
      .prepare('SELECT approval_id, status FROM approvals')
      .all() as { approval_id: string; status: string }[]
    expect(rows).toEqual([{ approval_id: approvalId, status: 'resolved' }])

    // The winner's outcome is the one an agent reads back.
    const winner = first.ok ? first : second
    if (!winner.ok) throw new Error('expected one ok result')
    await expect(a.readResolution(approvalId)).resolves.toMatchObject({
      outcome: winner.record.resolution.outcome,
    })
  })

  test('a markExpired racing a resolve also yields exactly one winner', async () => {
    const a = createApprovalQueue({ baseDir })
    const b = createApprovalQueue({ baseDir })
    const { approvalId } = await a.enqueue({
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      args: null,
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })

    const results = await Promise.all([
      a.resolve(approvalId, { outcome: 'approved' }),
      b.markExpired(approvalId),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })
})
