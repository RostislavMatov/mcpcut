import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  APPROVAL_HEARTBEAT_INTERVAL_MS,
  APPROVAL_HEARTBEAT_STALE_MS,
  APPROVAL_REQUEST_MAX_AGE_MS,
} from '../../../src/policy/constants.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'
import { approvalsDbPath, openApprovalsDb } from '../../../src/policy/approvals/queue-db.js'
import { SELECT_STALE_HEARTBEATS } from '../../../src/policy/approvals/queue-heartbeat-db.js'
import {
  WITHDRAW_REASON_PROCESS_LOST,
  cleanWithdrawReason,
} from '../../../src/policy/approvals/withdraw.js'
import { MAX_WITHDRAW_REASON_CHARS } from '../../../src/policy/constants.js'
import { openStateDbShared } from '../../../src/policy/store-backend.js'

/**
 * Decision M36, phase A: the agent that leaves takes its request with it. A
 * request is resolved `withdrawn` when the agent cancels or disconnects (the
 * gate), or when the process holding it stops refreshing its heartbeat (the
 * lazy sweep, a crash backstop). A withdrawn request is no longer pending, and
 * an operator's later approve is refused with what happened instead of the
 * generic "already resolved".
 */

let journalDir: string
let baseDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-withdraw-test-'))
  baseDir = join(journalDir, 'approvals')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function request(overrides: Record<string, unknown> = {}) {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write' as const,
    args: { title: 'hello' },
    sessionId: 'session-1',
    timeoutMs: APPROVAL_REQUEST_MAX_AGE_MS,
    ...overrides,
  }
}

async function heartbeatRows(): Promise<{ approval_id: string; heartbeat_at: string }[]> {
  const db = await openApprovalsDb(baseDir)
  return db.handle.db
    .prepare('SELECT approval_id, heartbeat_at FROM approval_heartbeats ORDER BY approval_id')
    .all() as { approval_id: string; heartbeat_at: string }[]
}

describe('withdraw: the agent stopped waiting', () => {
  test('resolves the request as withdrawn with its reason, and it leaves the list and the count', async () => {
    const nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())

    const result = await queue.withdraw(approvalId, 'AbortError: user-cancel')

    expect(result.ok).toBe(true)
    await expect(queue.list()).resolves.toEqual([])
    await expect(queue.countPending()).resolves.toBe(0)
    await expect(queue.readResolution(approvalId)).resolves.toEqual({
      outcome: 'withdrawn',
      reason: 'AbortError: user-cancel',
      resolvedAt: new Date(nowMs).toISOString(),
    })
  })

  test('an approve after the withdrawal is refused with when and why the agent left', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())
    await queue.withdraw(approvalId, 'disconnected')
    nowMs += 5_000

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'cli:alice' })

    expect(result).toEqual({
      ok: false,
      reason: 'withdrawn',
      withdrawnAt: new Date(Date.UTC(2026, 9, 8, 12)).toISOString(),
      withdrawnReason: 'disconnected',
    })
    // The refusal changed nothing: the record still says withdrawn.
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'withdrawn' })
  })

  test('a withdrawal after an approval loses: the human decision stands', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(request())
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'cli:alice' })

    const result = await queue.withdraw(approvalId, 'AbortError: user-cancel')

    expect(result).toEqual({ ok: false, reason: 'not-found-or-already-resolved' })
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'approved' })
  })

  test('an approve racing a withdrawal: exactly one of them wins', async () => {
    const queue = createApprovalQueue({ baseDir })
    const other = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(request())

    const [approved, withdrawn] = await Promise.all([
      queue.resolve(approvalId, { outcome: 'approved', actor: 'cli:alice' }),
      other.withdraw(approvalId, 'AbortError: user-cancel'),
    ])

    expect([approved.ok, withdrawn.ok].filter(Boolean)).toHaveLength(1)
    const outcome = (await queue.readResolution(approvalId))?.outcome
    expect(outcome).toBe(approved.ok ? 'approved' : 'withdrawn')
  })

  test('withdrawing an unknown id is refused like any unresolvable id', async () => {
    const queue = createApprovalQueue({ baseDir })

    await expect(queue.withdraw('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'disconnected')).resolves.toEqual({
      ok: false,
      reason: 'not-found-or-already-resolved',
    })
  })

  test('a deny after the withdrawal is refused the same way as an approve', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(request())
    await queue.withdraw(approvalId, 'SdkError: Request timed out')

    const result = await queue.resolve(approvalId, { outcome: 'denied', actor: 'cli:alice' })

    expect(result).toMatchObject({ ok: false, reason: 'withdrawn', withdrawnReason: 'SdkError: Request timed out' })
  })
})

describe('cleanWithdrawReason: the client chose the text', () => {
  test('strips control and invisible characters and caps the length', () => {
    const raw = `AbortError:\u001b[31m user​-cancel\n${'x'.repeat(500)}`

    const cleaned = cleanWithdrawReason(raw)

    expect(cleaned.startsWith('AbortError:[31m user-cancel')).toBe(true)
    expect(cleaned).not.toMatch(/[\u0000-\u001f​]/u)
    expect(cleaned.length).toBe(MAX_WITHDRAW_REASON_CHARS)
  })

  test('a missing, empty or non-string reason reads as "cancelled"', () => {
    expect(cleanWithdrawReason(undefined)).toBe('cancelled')
    expect(cleanWithdrawReason('')).toBe('cancelled')
    expect(cleanWithdrawReason('\u0007\u0007')).toBe('cancelled')
    expect(cleanWithdrawReason({ reason: 'x' })).toBe('cancelled')
  })
})

describe('heartbeat: the crash backstop', () => {
  test('enqueue starts a heartbeat, and a listed request says its agent is connected', async () => {
    const nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())

    const [listed] = await queue.list()

    expect(listed?.agentConnected).toBe(true)
    expect(await heartbeatRows()).toEqual([
      { approval_id: approvalId, heartbeat_at: new Date(nowMs).toISOString() },
    ])
  })

  test('a request whose heartbeat went stale is withdrawn as process-lost by the next read', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())

    nowMs += APPROVAL_HEARTBEAT_STALE_MS + 1

    await expect(queue.countPending()).resolves.toBe(0)
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({
      outcome: 'withdrawn',
      reason: WITHDRAW_REASON_PROCESS_LOST,
    })
    // The resolution cleans its heartbeat up with it.
    expect(await heartbeatRows()).toEqual([])
  })

  test('a heartbeat refreshed on schedule keeps the request live for as long as it is held', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())

    for (let tick = 0; tick < 40; tick += 1) {
      nowMs += APPROVAL_HEARTBEAT_INTERVAL_MS
      await queue.heartbeat(approvalId)
      expect(await queue.countPending()).toBe(1)
    }

    const [listed] = await queue.list()
    expect(listed?.approvalId).toBe(approvalId)
    expect(listed?.agentConnected).toBe(true)
  })

  test('the stale boundary is exclusive: a heartbeat exactly at the limit is still live', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(request())

    nowMs += APPROVAL_HEARTBEAT_STALE_MS

    await expect(queue.countPending()).resolves.toBe(1)
  })

  test('a heartbeat of a resolved request is a no-op and never resurrects it', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(request())
    await queue.resolve(approvalId, { outcome: 'denied', actor: 'cli:alice' })

    await expect(queue.heartbeat(approvalId)).resolves.toBeUndefined()

    expect(await heartbeatRows()).toEqual([])
    await expect(queue.list()).resolves.toEqual([])
  })

  test('a request past its own expiry is expired, not process-lost, even with a stale heartbeat', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request({ timeoutMs: 60_000 }))

    nowMs += APPROVAL_HEARTBEAT_STALE_MS + 1

    await queue.countPending()
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'expired' })
  })

  test('a row an older build enqueued has no heartbeat: only its own expiry settles it', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(request())
    const db = await openApprovalsDb(baseDir)
    db.handle.db.prepare('DELETE FROM approval_heartbeats WHERE approval_id = ?').run(approvalId)

    nowMs += APPROVAL_HEARTBEAT_STALE_MS * 10

    const [listed] = await queue.list()
    expect(listed?.approvalId).toBe(approvalId)
    // Unknown, not "connected": nothing refreshes a row like this.
    expect(listed).not.toHaveProperty('agentConnected')
  })

  test('the stale-heartbeat candidate query is index-served, with no scan and no temp sort', async () => {
    const db = await openApprovalsDb(baseDir)

    const plan = (db.handle.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_STALE_HEARTBEATS}`).all() as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')

    expect(plan).toContain('idx_approval_heartbeats_at')
    expect(plan).not.toContain('SCAN')
    expect(plan).not.toContain('TEMP B-TREE')
  })

  test('a database from before the heartbeat gains its side table and keeps its rows readable', async () => {
    const legacy = await openStateDbShared(approvalsDbPath(baseDir))
    legacy.db.exec(
      'CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, ' +
        "status TEXT NOT NULL CHECK (status IN ('pending','resolved')), doc TEXT NOT NULL, " +
        'server_name TEXT NOT NULL, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, ' +
        'requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, outcome TEXT, ' +
        'resolved_at TEXT, change_seq INTEGER NOT NULL) STRICT',
    )
    const doc = {
      approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: 'a'.repeat(64),
      sessionId: 'session-1',
      requestedAt: '2026-10-08T12:00:00.000Z',
      expiresAt: '2026-10-09T12:00:00.000Z',
    }
    legacy.db
      .prepare(
        'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
          'requested_at, expires_at, change_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(doc.approvalId, 'pending', JSON.stringify(doc), doc.serverName, doc.toolName, doc.argsHash, doc.requestedAt, doc.expiresAt)

    const queue = createApprovalQueue({ baseDir, clock: () => Date.UTC(2026, 9, 8, 13) })

    const listed = await queue.list()
    expect(listed.map((entry) => entry.approvalId)).toEqual([doc.approvalId])
    expect(await heartbeatRows()).toEqual([])
  })
})

describe('retention: resolved history does not grow without bound', () => {
  /** One resolved row straight into the table, settled at `resolvedAt`. */
  async function insertResolved(approvalId: string, resolvedAt: string): Promise<void> {
    const doc = {
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: 'hash-1',
      sessionId: 'session-1',
      requestedAt: resolvedAt,
      expiresAt: resolvedAt,
      resolution: { outcome: 'approved' },
      resolvedAt,
    }
    const db = await openApprovalsDb(baseDir)
    db.handle.db
      .prepare(
        'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
          "requested_at, expires_at, outcome, resolved_at, change_seq) VALUES (?, 'resolved', ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(approvalId, JSON.stringify(doc), 'github', 'create_issue', 'hash-1', resolvedAt, resolvedAt, 'approved', resolvedAt)
  }

  test('an enqueue deletes a bounded batch of long-settled records and keeps fresh ones', async () => {
    const nowMs = Date.UTC(2026, 9, 8, 12)
    const staleAt = new Date(nowMs - 48 * 60 * 60_000).toISOString() // past the 24 h retention
    // Two more than one cleanup batch (200), so the bound itself is observable.
    for (let index = 0; index < 202; index++) {
      await insertResolved(`01OLD${String(index).padStart(3, '0')}`, staleAt)
    }
    await insertResolved('01FRESH', new Date(nowMs - 1000).toISOString())
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })

    const { approvalId } = await queue.enqueue(request())

    const db = await openApprovalsDb(baseDir)
    const ids = (
      db.handle.db.prepare('SELECT approval_id FROM approvals ORDER BY approval_id').all() as { approval_id: string }[]
    ).map((row) => row.approval_id)
    expect(ids).toHaveLength(4) // 202 stale - 200 deleted, the fresh one, the new request
    expect(ids).toEqual(expect.arrayContaining(['01FRESH', approvalId]))
  })
})
