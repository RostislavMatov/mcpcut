import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { checkRecentApproval, createGrantRegistry } from '../../../src/policy/approvals/grants.js'
import { openApprovalsDb } from '../../../src/policy/approvals/queue-db.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'

describe('createGrantRegistry', () => {
  test('isGranted is false before any grant is recorded', () => {
    const registry = createGrantRegistry()
    expect(registry.isGranted({ serverName: 'github', toolName: 'create_issue', argsHash: 'abc' })).toBe(
      false,
    )
  })

  test('isGranted is true immediately after grant()', () => {
    const registry = createGrantRegistry()
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key, 5000)

    expect(registry.isGranted(key)).toBe(true)
  })

  test('a grant does not apply to a different argsHash (different call, same tool)', () => {
    const registry = createGrantRegistry()
    registry.grant({ serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }, 5000)

    expect(registry.isGranted({ serverName: 'github', toolName: 'create_issue', argsHash: 'xyz' })).toBe(
      false,
    )
  })

  test('a grant expires after ttlMs, per the injected clock', () => {
    let nowMs = 0
    const registry = createGrantRegistry({ clock: () => nowMs })
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key, 1000)
    expect(registry.isGranted(key)).toBe(true)

    nowMs = 1001
    expect(registry.isGranted(key)).toBe(false)
  })

  test('grant() uses DEFAULT_GRANT_TTL_MS when ttlMs is omitted', () => {
    let nowMs = 0
    const registry = createGrantRegistry({ clock: () => nowMs })
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key)
    nowMs = 60_000 // well under DEFAULT_GRANT_TTL_MS (5 min)
    expect(registry.isGranted(key)).toBe(true)
  })
})

describe('checkRecentApproval', () => {
  let journalDir: string
  /** The queue's contract: `<journalDir>/approvals`, with `state.db` in the parent. */
  let baseDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-grants-test-'))
    baseDir = join(journalDir, 'approvals')
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  /**
   * Writes one resolved record straight into the queue's table. The fields a
   * grant is decided on come from `doc`, so a test can shape them freely —
   * including combinations `resolve()` itself would never produce.
   */
  async function writeResolvedRecord(
    approvalId: string,
    fields: {
      serverName?: string
      toolName?: string
      argsHash?: string
      outcome?: string
      resolvedAt?: string
      doc?: string
    } = {},
  ): Promise<void> {
    const serverName = fields.serverName ?? 'github'
    const toolName = fields.toolName ?? 'create_issue'
    const argsHash = fields.argsHash ?? 'hash-1'
    const resolvedAt = fields.resolvedAt ?? new Date().toISOString()
    const doc =
      fields.doc ??
      JSON.stringify({
        approvalId,
        serverName,
        toolName,
        toolClass: 'write',
        argsRedacted: {},
        argsHash,
        sessionId: 'session-1',
        requestedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        resolution: { outcome: fields.outcome ?? 'approved' },
        resolvedAt,
      })

    const db = await openApprovalsDb(baseDir)
    db.handle.db
      .prepare(
        'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
          "requested_at, expires_at, outcome, resolved_at, change_seq) VALUES (?, 'resolved', " +
          '?, ?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(
        approvalId,
        doc,
        serverName,
        toolName,
        argsHash,
        resolvedAt,
        resolvedAt,
        fields.outcome ?? 'approved',
        resolvedAt,
      )
  }

  test('finds a recent approved resolution matching the triple', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { resolvedAt: new Date(nowMs - 1000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(true)
  })

  test('ignores a resolution with a different argsHash', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { argsHash: 'other-hash', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a resolution that is expired-by-ttl', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { resolvedAt: new Date(nowMs - 120_000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a denied resolution', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { outcome: 'denied', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores an expired-outcome resolution (session teardown), not just denied', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { outcome: 'expired', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a resolution for a different server or tool', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { serverName: 'other-server' })
    await writeResolvedRecord('01BBB', { toolName: 'other_tool' })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('skips a malformed record instead of throwing', async () => {
    await writeResolvedRecord('01AAA', { doc: 'not json' })

    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBe(false)
  })

  test('returns false when nothing has ever been queued', async () => {
    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBe(false)
  })

  test('grants a late approval recorded through the queue itself', async () => {
    const nowMs = Date.now()
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId, argsHash } = await queue.enqueue({
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      args: { title: 'hello' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash,
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(true)
  })

  test('retention deletes a bounded batch of long-settled records and keeps fresh ones', async () => {
    const nowMs = Date.now()
    const staleAt = new Date(nowMs - 48 * 60 * 60_000).toISOString() // past the 24h retention
    // Two more than one cleanup batch (200), so the bound itself is observable.
    for (let index = 0; index < 202; index++) {
      await writeResolvedRecord(`01OLD${String(index).padStart(3, '0')}`, { resolvedAt: staleAt })
    }
    await writeResolvedRecord('01FRESH', { resolvedAt: new Date(nowMs - 1000).toISOString() })

    await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    const db = await openApprovalsDb(baseDir)
    const ids = (
      db.handle.db.prepare('SELECT approval_id FROM approvals ORDER BY approval_id').all() as {
        approval_id: string
      }[]
    ).map((row) => row.approval_id)
    expect(ids).toHaveLength(3) // 202 stale - 200 deleted, plus the fresh one
    expect(ids).toContain('01FRESH')
  })

  test('M7: a future-dated resolvedAt does NOT grant (forged/backdated clock)', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { resolvedAt: new Date(nowMs + 3_600_000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  // REMOVED (M4.5 wave 3): "a resolved file whose approvalId does not match its
  // filename is ignored". That test guarded a file-based identity — a record
  // could be renamed into place under a foreign name. Records now live in a
  // table whose PRIMARY KEY *is* the approval id, so the mismatch it described
  // cannot be expressed; the property is enforced by the schema, not by a check.
  // The one place file names still exist — the legacy import (queue-import.ts) —
  // keeps the binding and has its own test.
})
