import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { canonicalJson, sha256Hex } from '../../../src/policy/hash.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'
import { openApprovalsDb } from '../../../src/policy/approvals/queue-db.js'
import { collectPersistedBytes } from '../../support/persisted-bytes.js'

/**
 * `baseDir` is nested inside the temp directory on purpose: the queue keeps
 * its rows in `state.db` beside that directory, and the whole tree (database,
 * -wal, -shm) is what `afterEach` removes.
 */
let journalDir: string
let baseDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-queue-test-'))
  baseDir = join(journalDir, 'approvals')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const SECRET_MARKER = 'sk-live-abcdefghijklmnopqrstuvwx'

function baseRequest(overrides: Partial<Parameters<ReturnType<typeof createApprovalQueue>['enqueue']>[0]> = {}) {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write' as const,
    args: { title: 'hello', apiKey: SECRET_MARKER },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

interface QueueRow {
  readonly approval_id: string
  readonly status: string
  readonly doc: string
}

/** Every stored row, in id order — the SQL counterpart of listing the queue directory. */
async function queueRows(): Promise<QueueRow[]> {
  const db = await openApprovalsDb(baseDir)
  return db.handle.db
    .prepare('SELECT approval_id, status, doc FROM approvals ORDER BY approval_id')
    .all() as QueueRow[]
}

/** The persisted record of one approval, parsed. */
async function storedDoc(approvalId: string): Promise<Record<string, unknown>> {
  const rows = await queueRows()
  const row = rows.find((entry) => entry.approval_id === approvalId)
  if (row === undefined) throw new Error(`no row for ${approvalId}`)
  return JSON.parse(row.doc) as Record<string, unknown>
}

/** Overwrites a row's `doc` — the SQL counterpart of hand-editing a queue file. */
async function overwriteDoc(approvalId: string, doc: string): Promise<void> {
  const db = await openApprovalsDb(baseDir)
  db.handle.db.prepare('UPDATE approvals SET doc = ? WHERE approval_id = ?').run(doc, approvalId)
}

/** Inserts a row directly, for records no current writer would produce. */
async function insertRawRow(doc: Record<string, unknown>, status = 'pending'): Promise<void> {
  const db = await openApprovalsDb(baseDir)
  db.handle.db
    .prepare(
      'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
        'requested_at, expires_at, change_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
    )
    .run(
      String(doc['approvalId']),
      status,
      JSON.stringify(doc),
      String(doc['serverName']),
      String(doc['toolName']),
      String(doc['argsHash']),
      String(doc['requestedAt']),
      String(doc['expiresAt']),
    )
}

describe('createApprovalQueue: enqueue', () => {
  test('stores a pending row with redacted args; the raw secret never lands in storage', async () => {
    const queue = createApprovalQueue({ baseDir })

    const { approvalId, argsHash } = await queue.enqueue(baseRequest())

    const parsed = await storedDoc(approvalId)
    expect(parsed['approvalId']).toBe(approvalId)
    expect(parsed['serverName']).toBe('github')
    expect(parsed['toolName']).toBe('create_issue')
    expect(parsed['toolClass']).toBe('write')
    expect(parsed['sessionId']).toBe('session-1')
    const argsRedacted = parsed['argsRedacted'] as Record<string, unknown>
    expect(argsRedacted['title']).toBe('hello')
    expect(argsRedacted['apiKey']).toBe('[REDACTED]')
    expect(parsed['argsHash']).toBe(argsHash)

    // Sweep every byte the queue persisted (state.db and its -wal sidecar).
    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    expect(fileNames).toContain('state.db') // positive sentinel: the sweep reached the store
    for (const rendering of renderings) expect(rendering).not.toContain(SECRET_MARKER)
  })

  test('argsHash is sha256Hex(canonicalJson(args))', async () => {
    const queue = createApprovalQueue({ baseDir })
    const args = { b: 2, a: 1 }

    const { argsHash } = await queue.enqueue(baseRequest({ args }))

    expect(argsHash).toBe(sha256Hex(canonicalJson(args)))
  })

  test('requestedAt and expiresAt are derived from the injected clock and timeoutMs', async () => {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const queue = createApprovalQueue({ baseDir, clock: () => startMs })

    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 30_000 }))

    const parsed = await storedDoc(approvalId)
    expect(parsed['requestedAt']).toBe(new Date(startMs).toISOString())
    expect(parsed['expiresAt']).toBe(new Date(startMs + 30_000).toISOString())
  })

  test('leaves exactly one pending row and no half-written record behind', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const rows = await queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.approval_id).toBe(approvalId)
    expect(rows[0]?.status).toBe('pending')
  })

  test.skipIf(process.platform === 'win32')(
    'the store keeps the journal ownership model: directory 0700, database 0600',
    async () => {
      const queue = createApprovalQueue({ baseDir })
      await queue.enqueue(baseRequest())

      const dirStat = await stat(journalDir)
      expect(dirStat.mode & 0o777).toBe(0o700)

      const fileStat = await stat(join(journalDir, 'state.db'))
      expect(fileStat.mode & 0o777).toBe(0o600)
    },
  )
})

describe('createApprovalQueue: M4 UI metadata (agentName, waitExpiresAt, decisionRule)', () => {
  test('persists agentName, decisionRule and waitExpiresAt = requestedAt + waitTimeoutMs', async () => {
    const startMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => startMs })

    const { approvalId } = await queue.enqueue(
      baseRequest({
        timeoutMs: 300_000,
        waitTimeoutMs: 60_000,
        agentName: 'research-bot',
        decisionRule: 'defaultDecision',
      }),
    )

    const parsed = await storedDoc(approvalId)
    expect(parsed['agentName']).toBe('research-bot')
    expect(parsed['decisionRule']).toBe('defaultDecision')
    // waitExpiresAt is the END OF THE AGENT'S WAIT, not the grant window:
    // the two must both be present and differ.
    expect(parsed['waitExpiresAt']).toBe(new Date(startMs + 60_000).toISOString())
    expect(parsed['expiresAt']).toBe(new Date(startMs + 300_000).toISOString())
    expect(parsed['waitExpiresAt']).not.toBe(parsed['expiresAt'])
  })

  test('omits the new fields entirely when not provided (write path stays M2/M3-shaped)', async () => {
    const queue = createApprovalQueue({ baseDir })

    const { approvalId } = await queue.enqueue(baseRequest())

    const parsed = await storedDoc(approvalId)
    expect(parsed).not.toHaveProperty('agentName')
    expect(parsed).not.toHaveProperty('waitExpiresAt')
    expect(parsed).not.toHaveProperty('decisionRule')
  })

  test('list() reads a legacy record without the new fields and surfaces new ones when present', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(
      baseRequest({ agentName: 'research-bot', waitTimeoutMs: 60_000, decisionRule: 'defaultDecision' }),
    )

    // A record exactly as an M2/M3 writer produced it: none of the new fields.
    await insertRawRow({
      approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      serverName: 'github',
      toolName: 'legacy_tool',
      toolClass: 'write',
      argsRedacted: null,
      argsHash: 'abc',
      sessionId: 'session-legacy',
      requestedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      expiresAt: new Date(Date.UTC(2027, 0, 1)).toISOString(),
    })

    const listed = await queue.list()
    expect(listed).toHaveLength(2)
    const legacyEntry = listed.find((entry) => entry.toolName === 'legacy_tool')
    expect(legacyEntry).toBeDefined()
    expect(legacyEntry).not.toHaveProperty('agentName')
    const fresh = listed.find((entry) => entry.toolName === 'create_issue')
    expect(fresh?.agentName).toBe('research-bot')
    expect(fresh?.decisionRule).toBe('defaultDecision')
    expect(fresh?.waitExpiresAt).toBeDefined()
  })

  test('a pending record with a non-string agentName is skipped as malformed', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const parsed = await storedDoc(approvalId)
    await overwriteDoc(approvalId, JSON.stringify({ ...parsed, agentName: 42 }))

    await expect(queue.list()).resolves.toEqual([])
  })

  test('an approval landing after waitExpiresAt but before expiresAt is still recorded approved', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(
      baseRequest({ timeoutMs: 300_000, waitTimeoutMs: 1_000 }),
    )

    nowMs += 60_000 // the agent's wait is long over; the grant window is not
    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    // waitExpiresAt must NOT participate in the expiry downgrade: an approval
    // inside the grant window still mints a grant for the agent's retry.
    expect(result.record.resolution.outcome).toBe('approved')
  })
})

describe('createApprovalQueue: listResolved', () => {
  async function seedResolved(queue: ReturnType<typeof createApprovalQueue>, count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i += 1) {
      const { approvalId } = await queue.enqueue(baseRequest({ toolName: `tool_${i}` }))
      await queue.resolve(approvalId, { outcome: 'denied', actor: 'operator' })
      ids.push(approvalId)
    }
    return ids
  }

  test('returns the limit newest entries by ULID, newest first, with their resolutions', async () => {
    const queue = createApprovalQueue({ baseDir })
    const ids = await seedResolved(queue, 15)
    const expected = [...ids].sort().reverse().slice(0, 10)

    const listed = await queue.listResolved({ limit: 10 })

    expect(listed.map((entry) => entry.approvalId)).toEqual(expected)
    expect(listed[0]?.resolution.outcome).toBe('denied')
    expect(listed[0]?.resolvedAt).toBeDefined()
  })

  test('the query is bounded by limit: older entries are never returned', async () => {
    const queue = createApprovalQueue({ baseDir })
    const ids = await seedResolved(queue, 15)
    const oldest = [...ids].sort().slice(0, 5)

    const listed = await queue.listResolved({ limit: 10 })

    expect(listed).toHaveLength(10)
    expect(listed.map((entry) => entry.approvalId)).not.toEqual(expect.arrayContaining(oldest))
  })

  test('returns everything newest-first when fewer entries than limit exist', async () => {
    const queue = createApprovalQueue({ baseDir })
    const ids = await seedResolved(queue, 3)

    const listed = await queue.listResolved({ limit: 10 })

    expect(listed.map((entry) => entry.approvalId)).toEqual([...ids].sort().reverse())
  })

  test('returns an empty array when nothing has been resolved yet', async () => {
    const queue = createApprovalQueue({ baseDir })
    await expect(queue.listResolved({ limit: 10 })).resolves.toEqual([])
  })

  test('skips a malformed record among the newest without reaching for older ones', async () => {
    const queue = createApprovalQueue({ baseDir })
    const ids = await seedResolved(queue, 5)
    const newest = [...ids].sort().reverse()[0] as string
    await overwriteDoc(newest, 'not json at all')

    const listed = await queue.listResolved({ limit: 3 })

    expect(listed).toHaveLength(2) // the corrupted newest is skipped, not backfilled
    expect(listed.map((entry) => entry.approvalId)).toEqual(
      [...ids].sort().reverse().slice(1, 3),
    )
  })

  test('a non-positive or non-integer limit returns []', async () => {
    const queue = createApprovalQueue({ baseDir })
    await seedResolved(queue, 2)

    await expect(queue.listResolved({ limit: 0 })).resolves.toEqual([])
    await expect(queue.listResolved({ limit: -5 })).resolves.toEqual([])
    await expect(queue.listResolved({ limit: 2.5 })).resolves.toEqual([])
  })
})

describe('createApprovalQueue: list', () => {
  test('returns pending approvals sorted oldest first', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })

    const first = await queue.enqueue(baseRequest({ toolName: 'first' }))
    nowMs += 1000
    const second = await queue.enqueue(baseRequest({ toolName: 'second' }))
    nowMs += 1000
    const third = await queue.enqueue(baseRequest({ toolName: 'third' }))

    const listed = await queue.list()
    expect(listed.map((entry) => entry.approvalId)).toEqual([
      first.approvalId,
      second.approvalId,
      third.approvalId,
    ])
  })

  test('marks entries past expiresAt as expired but still lists them', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })

    await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000

    const listed = await queue.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.expired).toBe(true)
  })

  test('unexpired entries are not marked expired', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    const listed = await queue.list()
    expect(listed[0]?.expired).toBe(false)
  })

  test('skips malformed records instead of throwing', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(baseRequest())

    const garbage = await queue.enqueue(baseRequest({ toolName: 'garbage' }))
    await overwriteDoc(garbage.approvalId, 'not json at all')
    const wrongShape = await queue.enqueue(baseRequest({ toolName: 'wrong_shape' }))
    await overwriteDoc(wrongShape.approvalId, JSON.stringify({ unrelated: true }))

    const listed = await queue.list()
    expect(listed).toHaveLength(1)
  })

  test('returns an empty array when nothing has been enqueued yet', async () => {
    const queue = createApprovalQueue({ baseDir })
    await expect(queue.list()).resolves.toEqual([])
  })
})

describe('createApprovalQueue: resolve', () => {
  test('flips the row to resolved and attaches the resolution', async () => {
    const nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest())

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution).toEqual({ outcome: 'approved', actor: 'alice' })
    expect(result.record.resolvedAt).toBe(new Date(nowMs).toISOString())

    await expect(queue.list()).resolves.toEqual([]) // no longer pending
    const rows = await queueRows()
    expect(rows).toHaveLength(1) // resolving moves a row, never duplicates it
    expect(rows[0]?.status).toBe('resolved')
    const parsed = await storedDoc(approvalId)
    expect((parsed['resolution'] as Record<string, unknown>)['outcome']).toBe('approved')
  })

  test('resolve with denied + reason persists the reason', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const result = await queue.resolve(approvalId, { outcome: 'denied', reason: 'not authorized' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution).toEqual({ outcome: 'denied', reason: 'not authorized' })
  })

  test('resolving an unknown id returns not-found-or-already-resolved', async () => {
    const queue = createApprovalQueue({ baseDir })

    const result = await queue.resolve('01ARZ3NDEKTSV4RRFFQ69G5FAV', { outcome: 'approved' })

    expect(result).toEqual({ ok: false, reason: 'not-found-or-already-resolved' })
  })

  test('two concurrent resolves of the same id: exactly one succeeds', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const [first, second] = await Promise.all([
      queue.resolve(approvalId, { outcome: 'approved' }),
      queue.resolve(approvalId, { outcome: 'denied' }),
    ])

    const okCount = [first, second].filter((r) => r.ok).length
    expect(okCount).toBe(1)
  })

  test('markExpired resolves the request with outcome "expired"', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const result = await queue.markExpired(approvalId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution).toEqual({ outcome: 'expired' })
  })

  test('H2: a pending record with an unparseable expiresAt can never be resolved to approved', async () => {
    // These records are hand-editable; Date.parse(garbage) is NaN and every
    // NaN comparison is false, which used to fail OPEN in resolve().
    const queue = createApprovalQueue({ baseDir })
    const approvalId = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
    await insertRawRow({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: 'a'.repeat(64),
      sessionId: 'session-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: 'not-a-timestamp',
    })

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })

    expect(result.ok).toBe(false)
    // No resolution reached storage (so checkRecentApproval cannot mint a grant).
    expect((await queueRows())[0]?.status).toBe('pending')
    await expect(queue.readResolution(approvalId)).resolves.toBeNull()
    // ...and list() does not present it as an actionable pending request either.
    await expect(queue.list()).resolves.toEqual([])
  })

  test('H2: a pending record with an unparseable waitExpiresAt is rejected too', async () => {
    const queue = createApprovalQueue({ baseDir })
    const approvalId = '01HYYYYYYYYYYYYYYYYYYYYYYY'
    await insertRawRow({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: 'a'.repeat(64),
      sessionId: 'session-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:01:00.000Z',
      waitExpiresAt: 'garbage',
    })

    await expect(queue.list()).resolves.toEqual([])
    const result = await queue.resolve(approvalId, { outcome: 'approved' })
    expect(result.ok).toBe(false)
  })

  test('H2: resolving exactly at expiresAt is already expired (list and resolve agree on >= )', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    nowMs += 60_000 // exactly the expiry instant

    const listed = await queue.list()
    expect(listed[0]?.expired).toBe(true)

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution.outcome).toBe('expired')
  })

  test('an approval id with path-traversal characters is rejected, not resolved', async () => {
    const queue = createApprovalQueue({ baseDir });
    const result = await queue.resolve('../../etc/passwd', { outcome: 'approved' })

    expect(result).toEqual({ ok: false, reason: 'not-found-or-already-resolved' })
  })

  test('H6: approving a request past its expiresAt is downgraded to expired, never approved', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))

    nowMs += 60_000 // well past expiresAt
    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'late-operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution.outcome).toBe('expired')

    // No 'approved' resolution was persisted (so checkRecentApproval cannot mint a grant).
    const parsed = await storedDoc(approvalId)
    expect((parsed['resolution'] as Record<string, unknown>)['outcome']).toBe('expired')
  })

  test('H6: approving before expiry still records approved', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    nowMs += 1000 // still within the window
    const result = await queue.resolve(approvalId, { outcome: 'approved' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution.outcome).toBe('approved')
  })
})

describe('createApprovalQueue: readResolution', () => {
  test('returns null while the approval is still pending', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    await expect(queue.readResolution(approvalId)).resolves.toBeNull()
  })

  test('returns the resolution once resolved', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })

    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe('alice')
  });

  test('returns null for an unknown id', async () => {
    const queue = createApprovalQueue({ baseDir })
    await expect(queue.readResolution('01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeNull()
  })

  test('returns null (never throws) for a malformed resolved record', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    await queue.resolve(approvalId, { outcome: 'approved' })

    await overwriteDoc(approvalId, 'not json')

    await expect(queue.readResolution(approvalId)).resolves.toBeNull()
  })
})
