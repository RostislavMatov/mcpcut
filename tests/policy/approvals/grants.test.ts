import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_APPROVAL_ACTOR_CHARS } from '../../../src/policy/constants.js'
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
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-grants-test-'))
    baseDir = join(journalDir, 'approvals')
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  /** The fields a test can shape on a stored resolved record. */
  interface ResolvedRecordFields {
    serverName?: string
    toolName?: string
    argsHash?: string
    outcome?: string
    actor?: unknown
    resolvedAt?: string
    /** The requester the record is bound to (security audit 2026-09-02, F1). */
    sessionId?: string
    agentName?: unknown
    doc?: string
  }

  /**
   * The stored document as `resolve()` would shape it, returned as an object
   * so a test can reshape it (drop a key) before handing it to
   * `writeResolvedRecord` as `doc`.
   */
  function resolvedDocOf(approvalId: string, fields: ResolvedRecordFields): Record<string, unknown> {
    return {
      approvalId,
      serverName: fields.serverName ?? 'github',
      toolName: fields.toolName ?? 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: fields.argsHash ?? 'hash-1',
      sessionId: fields.sessionId ?? 'session-1',
      ...(fields.agentName !== undefined ? { agentName: fields.agentName } : {}),
      requestedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      resolution: {
        outcome: fields.outcome ?? 'approved',
        ...(fields.actor !== undefined ? { actor: fields.actor } : {}),
      },
      resolvedAt: fields.resolvedAt ?? new Date().toISOString(),
    }
  }

  /**
   * Writes one resolved record straight into the queue's table. The fields a
   * grant is decided on come from `doc`, so a test can shape them freely —
   * including combinations `resolve()` itself would never produce.
   */
  async function writeResolvedRecord(approvalId: string, fields: ResolvedRecordFields = {}): Promise<void> {
    const serverName = fields.serverName ?? 'github'
    const toolName = fields.toolName ?? 'create_issue'
    const argsHash = fields.argsHash ?? 'hash-1'
    const resolvedAt = fields.resolvedAt ?? new Date().toISOString()
    const doc = fields.doc ?? JSON.stringify(resolvedDocOf(approvalId, { ...fields, resolvedAt }))

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
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).not.toBeNull()
  })

  test('ignores a resolution with a different argsHash', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { argsHash: 'other-hash', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('ignores a resolution that is expired-by-ttl', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { resolvedAt: new Date(nowMs - 120_000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('ignores a denied resolution', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { outcome: 'denied', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('ignores an expired-outcome resolution (session teardown), not just denied', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { outcome: 'expired', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('ignores a resolution for a different server or tool', async () => {
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { serverName: 'other-server' })
    await writeResolvedRecord('01BBB', { toolName: 'other_tool' })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('skips a malformed record instead of throwing', async () => {
    await writeResolvedRecord('01AAA', { doc: 'not json' })

    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        sessionId: 'session-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBeNull()
  })

  test('returns null when nothing has ever been queued', async () => {
    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        sessionId: 'session-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBeNull()
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
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).not.toBeNull()
  })

  test('returns the approval id and the actor of the matching resolution', async () => {
    // The identifying facts, not merely "yes": the retry this grant admits
    // writes an `allow` record, and without them that record shows a
    // destructive call simply succeeding, with the human approval that
    // authorized it recorded nowhere (M5 wave 2).
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', {
      actor: 'ui:alice',
      resolvedAt: new Date(nowMs - 1000).toISOString(),
    })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toEqual({ approvalId: '01AAA', actor: 'ui:alice' })
  })

  test('a matching resolution with no actor grants with NO actor key', async () => {
    // Pre-M5 records (and every resolution recorded without one) carry no
    // actor. Attribution is not a condition of the grant, and absence stays
    // an absent key: `actor: undefined` would be indistinguishable from a
    // named operator once the record is serialized.
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', { resolvedAt: new Date(nowMs - 1000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toEqual({ approvalId: '01AAA' })
    expect(Object.hasOwn(granted!, 'actor')).toBe(false)
  })

  test('a record whose actor is not a string is skipped whole, and grants nothing', async () => {
    // Not "granted without an actor": the document failed validation, so
    // nothing about it is trusted — the same skip-whole discipline every
    // other field here follows.
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', {
      actor: { name: 'alice' },
      resolvedAt: new Date(nowMs - 1000).toISOString(),
    })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('a record with an over-cap actor is skipped whole', async () => {
    // A foreign row could otherwise push megabytes of attacker-chosen text
    // onto a journal record that waves 3-4 chain and sign.
    const nowMs = Date.now()
    await writeResolvedRecord('01AAA', {
      actor: 'a'.repeat(MAX_APPROVAL_ACTOR_CHARS + 1),
      resolvedAt: new Date(nowMs - 1000).toISOString(),
    })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  test('an actor exactly at the cap still grants (the bound is inclusive)', async () => {
    const nowMs = Date.now()
    const actor = 'a'.repeat(MAX_APPROVAL_ACTOR_CHARS)
    await writeResolvedRecord('01AAA', { actor, resolvedAt: new Date(nowMs - 1000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toEqual({ approvalId: '01AAA', actor })
  })

  test('unopenable storage yields no grant, and does not throw', async () => {
    // The contract this function exists under: a failure to READ must fall
    // back to asking a human, never to granting, and never to failing the
    // decision. A directory where the database file belongs is unopenable.
    await mkdir(join(journalDir, 'state.db'), { recursive: true })

    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        sessionId: 'session-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBeNull()
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
      sessionId: 'session-1',
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
      sessionId: 'session-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBeNull()
  })

  describe('requester binding (security audit 2026-09-02, F1)', () => {
    /**
     * A resolved approval is a human's answer to ONE requester's question.
     * Before this binding the fallback matched on the call triple alone, so
     * within `grantTtlMs` any other agent sending the byte-identical call
     * consumed that answer with no human ever seeing ITS request.
     */
    const TRIPLE = { serverName: 'github', toolName: 'create_issue', argsHash: 'hash-1' } as const

    test('a resolution recorded for agent alpha does not grant agent beta the identical call', async () => {
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', { agentName: 'alpha', resolvedAt: new Date(nowMs - 1000).toISOString() })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-2',
        agentName: 'beta',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })

    test('the same agent retrying from a DIFFERENT session is granted: the late-approval case', async () => {
      // The whole point of the fallback: the first attempt timed out and the
      // agent came back later — from a new proxy session — with the same call.
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', {
        agentName: 'alpha',
        sessionId: 'session-1',
        resolvedAt: new Date(nowMs - 1000).toISOString(),
      })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-2',
        agentName: 'alpha',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toEqual({ approvalId: '01AAA' })
    })

    test('a wrap-path resolution (no agentName) grants a retry from the same session', async () => {
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', { sessionId: 'session-1', resolvedAt: new Date(nowMs - 1000).toISOString() })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-1',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toEqual({ approvalId: '01AAA' })
    })

    test('a wrap-path resolution (no agentName) does not grant a retry from a different session', async () => {
      // Without an agent the session is the only identity a requester has.
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', { sessionId: 'session-1', resolvedAt: new Date(nowMs - 1000).toISOString() })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-2',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })

    test('a wrap-path resolution never grants an authenticated agent, even in the same session', async () => {
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', { sessionId: 'session-1', resolvedAt: new Date(nowMs - 1000).toISOString() })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-1',
        agentName: 'alpha',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })

    test('an agent resolution never grants a wrap-path retry, even in the same session', async () => {
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', {
        agentName: 'alpha',
        sessionId: 'session-1',
        resolvedAt: new Date(nowMs - 1000).toISOString(),
      })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-1',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })

    test('a record with no sessionId at all is skipped whole, and grants nothing', async () => {
      // Not "granted to whoever asks": a record that cannot say who asked
      // failed validation, so nothing about it is trusted.
      const nowMs = Date.now()
      const resolvedAt = new Date(nowMs - 1000).toISOString()
      const withoutSession = Object.fromEntries(
        Object.entries(resolvedDocOf('01AAA', { resolvedAt })).filter(([key]) => key !== 'sessionId'),
      )
      await writeResolvedRecord('01AAA', { doc: JSON.stringify(withoutSession), resolvedAt })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-1',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })

    test('a record whose agentName is not a string is skipped whole, and grants nothing', async () => {
      const nowMs = Date.now()
      await writeResolvedRecord('01AAA', { agentName: 42, resolvedAt: new Date(nowMs - 1000).toISOString() })

      const granted = await checkRecentApproval(baseDir, {
        ...TRIPLE,
        sessionId: 'session-1',
        ttlMs: 60_000,
        clock: () => nowMs,
      })

      expect(granted).toBeNull()
    })
  })

  // REMOVED (M4.5 wave 3): "a resolved file whose approvalId does not match its
  // filename is ignored". That test guarded a file-based identity — a record
  // could be renamed into place under a foreign name. Records now live in a
  // table whose PRIMARY KEY *is* the approval id, so the mismatch it described
  // cannot be expressed; the property is enforced by the schema, not by a check.
  // The one place file names still exist — the legacy import (queue-import.ts) —
  // keeps the binding and has its own test.
})
