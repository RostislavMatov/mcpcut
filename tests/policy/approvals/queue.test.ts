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

/**
 * Inserts a row directly, for records no current writer would produce.
 *
 * `expiresAtColumn` overrides the denormalized `expires_at` COLUMN while the
 * `doc` keeps its own `expiresAt`: that is how a row reaches the queue with the
 * indexed copy disagreeing with the record (a hand-written row, a foreign
 * writer, a legacy import of a differently formatted timestamp).
 */
async function insertRawRow(
  doc: Record<string, unknown>,
  status = 'pending',
  expiresAtColumn?: string,
): Promise<void> {
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
      expiresAtColumn ?? String(doc['expiresAt']),
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

describe('createApprovalQueue: M5 rule provenance (policyHash, grantsHash)', () => {
  const POLICY_HASH = 'a'.repeat(64)
  const GRANTS_HASH = 'b'.repeat(64)

  /** A record exactly as a pre-M5 writer produced it: neither provenance field. */
  const PRE_M5_RECORD = {
    approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    serverName: 'github',
    toolName: 'legacy_tool',
    toolClass: 'write',
    argsRedacted: null,
    argsHash: 'abc',
    sessionId: 'session-pre-m5',
    requestedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
    expiresAt: new Date(Date.UTC(2027, 0, 1)).toISOString(),
  } as const

  test('persists both fingerprints, pinning the rules the request was made under', async () => {
    const queue = createApprovalQueue({ baseDir })

    const { approvalId } = await queue.enqueue(
      baseRequest({ policyHash: POLICY_HASH, grantsHash: GRANTS_HASH }),
    )

    const parsed = await storedDoc(approvalId)
    expect(parsed['policyHash']).toBe(POLICY_HASH)
    expect(parsed['grantsHash']).toBe(GRANTS_HASH)
  })

  test('a request with no agent persists policyHash and no grantsHash key at all', async () => {
    // The `wrap` path: absent, not null and not undefined -- the same
    // "absent means there was no agent" convention `agentName` follows.
    const queue = createApprovalQueue({ baseDir })

    const { approvalId } = await queue.enqueue(baseRequest({ policyHash: POLICY_HASH }))

    const parsed = await storedDoc(approvalId)
    expect(parsed['policyHash']).toBe(POLICY_HASH)
    expect(Object.hasOwn(parsed, 'grantsHash')).toBe(false)
  })

  test('a pre-M5 record with neither field still lists and still resolves', async () => {
    // Why both fields are optional: a request enqueued by an older version
    // must keep parsing forever, so an operator can still settle it.
    const queue = createApprovalQueue({ baseDir })
    await insertRawRow({ ...PRE_M5_RECORD })

    const listed = await queue.list()
    expect(listed.map((entry) => entry.approvalId)).toEqual([PRE_M5_RECORD.approvalId])
    expect(Object.hasOwn(listed[0]!, 'policyHash')).toBe(false)
    expect(Object.hasOwn(listed[0]!, 'grantsHash')).toBe(false)

    const result = await queue.resolve(PRE_M5_RECORD.approvalId, {
      outcome: 'approved',
      actor: 'operator',
    })
    expect(result.ok).toBe(true)
  })

  test.each(['policyHash', 'grantsHash'])(
    'a pending record whose %s is not a string is skipped as malformed',
    async (field) => {
      // Consistent with every other malformed field: a hand-edited row is
      // rejected whole rather than read past.
      const queue = createApprovalQueue({ baseDir })
      const { approvalId } = await queue.enqueue(baseRequest())
      const parsed = await storedDoc(approvalId)
      await overwriteDoc(approvalId, JSON.stringify({ ...parsed, [field]: 42 }))

      await expect(queue.list()).resolves.toEqual([])
    },
  )

  test.each([
    ['a 10 MB string', 'x'.repeat(10 * 1024 * 1024)],
    ['markup', '<script>alert(1)</script>'],
    ['an uppercase digest', 'A'.repeat(64)],
    ['a truncated digest', 'a'.repeat(63)],
    ['an over-long digest', 'a'.repeat(65)],
    ['an empty string', ''],
  ])(
    'a pending record whose policyHash is %s is skipped as malformed',
    async (_label, value) => {
      // "Any string is a valid fingerprint" is the wrong default for a field
      // waves 3-5 will chain and sign: every other digest in the codebase is
      // regex-pinned (`TOKEN_HASH_PATTERN`), and a row written out of band
      // must not be able to smuggle arbitrary text in as evidence (SEC-L2).
      const queue = createApprovalQueue({ baseDir })
      const { approvalId } = await queue.enqueue(baseRequest())
      const parsed = await storedDoc(approvalId)
      await overwriteDoc(approvalId, JSON.stringify({ ...parsed, policyHash: value }))

      await expect(queue.list()).resolves.toEqual([])
    },
  )

  test('a well-formed lowercase sha256 digest is still accepted', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const parsed = await storedDoc(approvalId)
    await overwriteDoc(approvalId, JSON.stringify({ ...parsed, grantsHash: GRANTS_HASH }))

    const listed = await queue.list()
    expect(listed[0]?.grantsHash).toBe(GRANTS_HASH)
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

  test('an entry past expiresAt is settled by the sweep instead of being listed as live work', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })

    await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000

    // Expiry no longer waits for session teardown (see the sweep block at the
    // end of this file): `list()` offers only requests a decision can still
    // act on. The `expired` flag it derives now covers the rows a bounded
    // sweep pass has not reached — asserted there.
    await expect(queue.list()).resolves.toEqual([])
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

  test('H2: resolving exactly at expiresAt is already expired (the >= boundary of the resolve path)', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    nowMs += 60_000 // exactly the expiry instant

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution.outcome).toBe('expired')
  })

  test('H2: at exactly expiresAt the list agrees with resolve — it settles the request, never offers it', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    nowMs += 60_000 // exactly the expiry instant

    // Both paths read `isExpiredAt` (`queue-file.ts`), so an operator can never
    // see as live what the resolve path would refuse — and what the sweep
    // persists on that instant is the same verdict: expired, never approved.
    await expect(queue.list()).resolves.toEqual([])
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'expired' })
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

describe('bounded reads (availability: an unbounded pending set made every UI poll a full scan)', () => {
  test('list() is capped, returning the OLDEST requests — the ones an operator must act on first', async () => {
    const queue = createApprovalQueue({ baseDir })
    for (let i = 0; i < 12; i += 1) {
      await queue.enqueue(baseRequest({ sessionId: `session-${i}` }))
    }

    const all = await queue.list()
    const listed = await queue.list({ limit: 5 })

    expect(listed).toHaveLength(5)
    // `list()` orders oldest-first, and truncation keeps that end: dropping the
    // oldest would hide exactly the requests closest to timing out. Compared
    // against the unbounded read rather than against insertion order, because
    // requests enqueued within one millisecond tie on `requested_at` and are
    // ordered by their ULID — which is the query's contract, not a detail.
    expect(listed.map((entry) => entry.approvalId)).toEqual(
      all.slice(0, 5).map((entry) => entry.approvalId),
    )
  })

  test('countPending() reports the true total so a caller can say how much it is not showing', async () => {
    const queue = createApprovalQueue({ baseDir })
    for (let i = 0; i < 7; i += 1) await queue.enqueue(baseRequest({ sessionId: `session-${i}` }))

    expect(await queue.countPending()).toBe(7)
    expect(await queue.list({ limit: 3 })).toHaveLength(3)
  })

  test('a resolved request leaves the pending count', async () => {
    const queue = createApprovalQueue({ baseDir })
    const first = await queue.enqueue(baseRequest())
    await queue.enqueue(baseRequest({ sessionId: 'session-2' }))

    await queue.resolve(first.approvalId, { outcome: 'denied' })

    expect(await queue.countPending()).toBe(1)
  })

  test('changesSince() is capped and reports the truncation', async () => {
    const queue = createApprovalQueue({ baseDir })
    const baseline = await queue.changesSince(null)
    for (let i = 0; i < 10; i += 1) await queue.enqueue(baseRequest({ sessionId: `session-${i}` }))

    const page = await queue.changesSince(baseline.latestSeq, { limit: 4 })

    expect(page.newPending).toHaveLength(4)
    expect(page.truncated).toBe(true)
  })

  test('a truncated page moves the watermark only as far as it actually delivered', async () => {
    const queue = createApprovalQueue({ baseDir })
    const baseline = await queue.changesSince(null)
    for (let i = 0; i < 10; i += 1) await queue.enqueue(baseRequest({ sessionId: `session-${i}` }))

    // Draining in pages must lose nothing: reporting the GLOBAL watermark on a
    // truncated read would silently skip every change the page left behind,
    // breaking the queue's at-least-once contract.
    const seen: string[] = []
    let watermark = baseline.latestSeq
    for (let page = 0; page < 5; page += 1) {
      const changes = await queue.changesSince(watermark, { limit: 4 })
      seen.push(...changes.newPending.map((entry) => entry.sessionId))
      watermark = changes.latestSeq
      if (!changes.truncated) break
    }

    expect(new Set(seen).size).toBe(10)
  })

  test('an untruncated page reports no truncation and the global watermark', async () => {
    const queue = createApprovalQueue({ baseDir })
    const baseline = await queue.changesSince(null)
    await queue.enqueue(baseRequest())

    const page = await queue.changesSince(baseline.latestSeq, { limit: 100 })

    expect(page.truncated).toBe(false)
    expect(page.newPending).toHaveLength(1)
  })
})

/**
 * Expiry used to depend on session lifetime: a request nobody resolved was
 * only taken out of `pending` by `cancelPending()` at teardown (`gate-core.ts`),
 * so in a `wrap`/`connect` session that lives for hours the dead requests piled
 * up in `pending` — and `countPending()`, which feeds the UI badge and the
 * "N of M pending" line, counted requests that could never yield a grant.
 *
 * The sweep runs lazily on the two reads whose truthfulness is at stake
 * (`list()` and `countPending()`), never on a timer, and it goes through the
 * SAME `markExpired()` teardown uses — so a swept row is byte-identical to a
 * torn-down one and the one-outcome-per-id invariant is the conditional
 * `UPDATE … WHERE status = 'pending'` it already rests on.
 */
describe('lazy expiry sweep (a request nobody answers must not outlive its own expiry)', () => {
  test('countPending() stops counting a request whose expiry has passed', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    expect(await queue.countPending()).toBe(1)

    nowMs += 5000 // past expiresAt, with no session teardown in sight

    expect(await queue.countPending()).toBe(0)
    const rows = await queueRows()
    expect(rows).toHaveLength(1) // swept, not deleted
    expect(rows[0]?.status).toBe('resolved')
  })

  test('list() drops a swept request, and it keeps its trace as a resolved "expired" record', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))

    nowMs += 5000
    await expect(queue.list()).resolves.toEqual([])

    // Not "vanished": the record survives with the same outcome session
    // teardown writes, so `readResolution`, `listResolved` and every export
    // still show what happened to the request.
    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('expired')
    expect(resolution?.resolvedAt).toBe(new Date(nowMs).toISOString())
    expect(await queue.listResolved({ limit: 5 })).toHaveLength(1)
  })

  test('a request that has not expired yet is untouched by the sweep', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    nowMs += 59_999 // one millisecond short of the expiry instant

    expect(await queue.countPending()).toBe(1)
    const listed = await queue.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.expired).toBe(false)
    await expect(queue.readResolution(approvalId)).resolves.toBeNull()
  })

  test('a request a human already resolved is never rewritten by the sweep', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })
    const decidedAt = new Date(nowMs).toISOString()

    nowMs += 5000 // the grant window elapses; the sweep now looks at the table
    await queue.countPending()
    await queue.list()

    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('approved') // a real decision, not an expiry
    expect(resolution?.actor).toBe('alice')
    expect(resolution?.resolvedAt).toBe(decidedAt)
  })

  test('two concurrent sweeps of the same request produce exactly one outcome', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    // Two queue instances over one directory: the shape two processes (a CLI
    // `approvals list` and a UI page render) have on the same `state.db`.
    const first = createApprovalQueue({ baseDir, clock: () => nowMs })
    const second = createApprovalQueue({ baseDir, clock: () => nowMs })
    await first.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000

    const before = (await first.changesSince(null)).latestSeq
    await Promise.all([first.countPending(), second.countPending(), first.list(), second.list()])
    const after = (await first.changesSince(null)).latestSeq

    // Every write transaction bumps the change sequence exactly once, so a
    // second outcome for the same row would show up as a second bump.
    expect(after).toBe(before + 1)
    const rows = await queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('resolved')
  })

  test('a resolve landing after the sweep is refused and leaves no reusable grant', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))

    nowMs += 5000
    await queue.countPending() // the sweep expires it

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'late-operator' })

    expect(result).toEqual({ ok: false, reason: 'not-found-or-already-resolved' })
    // The same refusal `markExpired()` at teardown produces: no `approved`
    // resolution reached storage, so `checkRecentApproval` cannot mint a grant.
    const parsed = await storedDoc(approvalId)
    expect((parsed['resolution'] as Record<string, unknown>)['outcome']).toBe('expired')
  })

  test('a row the sweep cannot reach is still listed as expired: the flag is derived, never stored', async () => {
    // The `expires_at` COLUMN only narrows the sweep's candidates; the record
    // is the authority. A row whose column disagrees (hand-written, foreign
    // writer, legacy import) is left pending — and `list()` must still tell the
    // operator the truth about it rather than presenting it as live.
    const nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const approvalId = '01HXXXXXXXXXXXXXXXXXXXXXXX'
    await insertRawRow(
      {
        approvalId,
        serverName: 'github',
        toolName: 'create_issue',
        toolClass: 'write',
        argsRedacted: {},
        argsHash: 'a'.repeat(64),
        sessionId: 'session-1',
        requestedAt: '2025-12-31T23:00:00.000Z',
        expiresAt: '2025-12-31T23:01:00.000Z', // long past `nowMs`
      },
      'pending',
      '2099-01-01T00:00:00.000Z', // …but the indexed column says otherwise
    )

    const listed = await queue.list()

    expect(listed).toHaveLength(1)
    expect(listed[0]?.expired).toBe(true)
    expect((await queueRows())[0]?.status).toBe('pending')
  })

  test('a malformed pending record is left alone by the sweep, exactly as by resolve()', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    await overwriteDoc(approvalId, 'not json at all')

    nowMs += 5000
    await queue.list()

    // Unresolvable is unresolvable: the sweep must not invent a resolution for
    // a record it cannot read (`markExpired` refuses it too).
    expect((await queueRows())[0]?.status).toBe('pending')
  })
})

/**
 * The sweep runs on the RENDER path — `list()` and `countPending()`, i.e. twice
 * per approvals page and once per JSON poll. One write transaction per expired
 * row therefore put N serial `BEGIN IMMEDIATE`/COMMIT pairs (each with its own
 * busy-retry pacing) in front of the first byte an operator returning to an
 * abandoned queue ever sees. The whole bounded pass is now ONE transaction.
 *
 * What must NOT change with it — and is what these cases actually pin:
 *
 *  - one outcome per id: the batch is still the conditional
 *    `UPDATE … WHERE status = 'pending'` under `BEGIN IMMEDIATE`, run per row
 *    inside the shared transaction, so a human decision is never overwritten
 *    and two concurrent sweepers cannot both settle a row;
 *  - `change_seq` bookkeeping: exactly one bump per row actually settled — the
 *    watcher contract `ui/watch.ts` publishes `approval-resolved` off;
 *  - best-effort: an unusable row is skipped, never rolled back onto the rest,
 *    and nothing throws into the read.
 */
describe('the expiry sweep settles a backlog in one write transaction', () => {
  /**
   * Counts `BEGIN IMMEDIATE` transactions taken on the queue's shared
   * connection while `run()` executes. `openStateDbShared` caches one handle
   * per database per process, so wrapping it here observes every writer the
   * queue opens afterwards — reads take no transaction and are invisible.
   */
  async function countWriteTransactions(run: () => Promise<void>): Promise<number> {
    const { handle } = await openApprovalsDb(baseDir)
    const original = handle.transaction
    let taken = 0
    handle.transaction = ((fn: Parameters<typeof original>[0]) => {
      taken += 1
      return original(fn)
    }) as typeof handle.transaction
    try {
      await run()
    } finally {
      handle.transaction = original
    }
    return taken
  }

  /** `count` expired pending requests, and a clock already past their expiry. */
  async function backlog(count: number): Promise<{ readonly queue: ReturnType<typeof createApprovalQueue>; readonly ids: string[] }> {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const ids: string[] = []
    for (let i = 0; i < count; i += 1) {
      const { approvalId } = await queue.enqueue(baseRequest({ sessionId: `session-${i}`, timeoutMs: 1000 }))
      ids.push(approvalId)
    }
    nowMs += 5000
    return { queue, ids }
  }

  test('an abandoned backlog costs the render path one write transaction, not one per row', async () => {
    const { queue } = await backlog(8)

    const taken = await countWriteTransactions(async () => {
      await queue.list()
    })

    expect(taken).toBe(1)
    const rows = await queueRows()
    expect(rows.every((row) => row.status === 'resolved')).toBe(true)
  })

  test('a read that finds nothing to expire takes no write transaction at all', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))

    const taken = await countWriteTransactions(async () => {
      await queue.countPending()
      await queue.list()
    })

    expect(taken).toBe(0)
  })

  test('the batch bumps the change sequence exactly once per row it settles', async () => {
    const { queue } = await backlog(4)
    const before = (await queue.changesSince(null)).latestSeq

    await queue.countPending()

    // One bump per settled row — unchanged from one-transaction-per-row. A
    // watcher replaying `changesSince` sees four resolutions, four sequences.
    expect((await queue.changesSince(null)).latestSeq).toBe(before + 4)
    const page = await queue.changesSince(before)
    expect(page.resolvedIds).toHaveLength(4)
    expect(new Set(page.resolvedIds).size).toBe(4)
  })

  test('a human decision inside the swept range is never overwritten by the batch', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const { approvalId } = await queue.enqueue(baseRequest({ sessionId: `session-${i}`, timeoutMs: 1000 }))
      ids.push(approvalId)
    }
    const decided = ids[2] as string
    await queue.resolve(decided, { outcome: 'approved', actor: 'alice' })
    const decidedAt = new Date(nowMs).toISOString()

    nowMs += 5000
    await queue.list()

    const resolution = await queue.readResolution(decided)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe('alice')
    expect(resolution?.resolvedAt).toBe(decidedAt)
    for (const other of ids.filter((id) => id !== decided)) {
      await expect(queue.readResolution(other)).resolves.toMatchObject({ outcome: 'expired' })
    }
  })

  test('two concurrent sweepers of a whole backlog still produce exactly one outcome per id', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    // Two instances over one directory: a CLI `approvals list` and a UI render.
    const first = createApprovalQueue({ baseDir, clock: () => nowMs })
    const second = createApprovalQueue({ baseDir, clock: () => nowMs })
    for (let i = 0; i < 6; i += 1) {
      await first.enqueue(baseRequest({ sessionId: `session-${i}`, timeoutMs: 1000 }))
    }
    nowMs += 5000

    const before = (await first.changesSince(null)).latestSeq
    await Promise.all([first.countPending(), second.countPending(), first.list(), second.list()])
    const after = (await first.changesSince(null)).latestSeq

    // Six rows, six bumps: a second outcome for any row would show as a
    // seventh. The loser of the race writes nothing and bumps nothing.
    expect(after).toBe(before + 6)
    const rows = await queueRows()
    expect(rows).toHaveLength(6)
    expect(rows.every((row) => row.status === 'resolved')).toBe(true)
  })

  test('an unusable row in the middle of a batch does not cost the rest their outcome', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const { approvalId } = await queue.enqueue(baseRequest({ sessionId: `session-${i}`, timeoutMs: 1000 }))
      ids.push(approvalId)
    }
    await overwriteDoc(ids[1] as string, 'not json at all')

    nowMs += 5000
    await queue.list()

    // Batching must not turn one unreadable record into a rollback of the pass.
    const rows = await queueRows()
    const byStatus = rows.map((row) => row.status)
    expect(byStatus.filter((status) => status === 'resolved')).toHaveLength(2)
    expect(byStatus.filter((status) => status === 'pending')).toHaveLength(1)
  })
})

/**
 * The watermark contract of `changesSince` is "a change may be delivered twice,
 * never skipped". A TRUNCATED page therefore stops the watermark at the last
 * change it delivered — but when every row of that page was dropped as
 * malformed there is no last delivered change, and falling back to the GLOBAL
 * sequence skips everything between the page and the head. `sinceSeq` is the
 * only fallback that keeps the contract: the caller re-asks from where it was.
 *
 * Malformed rows cannot come from the STRICT schema, so the setup here is the
 * case the reader guards against explicitly: a FOREIGN table of the same name.
 */
describe('changesSince watermark: a page that delivered nothing never skips ahead', () => {
  /** Replaces the queue's table with an untyped (foreign) one of the same name. */
  async function useForeignApprovalsTable(): Promise<void> {
    const db = await openApprovalsDb(baseDir)
    db.handle.db.exec('DROP TABLE approvals')
    db.handle.db.exec(
      'CREATE TABLE approvals (approval_id, status, doc, server_name, tool_name, ' +
        'args_hash, requested_at, expires_at, outcome, resolved_at, change_seq)',
    )
  }

  async function insertForeignRow(approvalId: unknown, changeSeq: number, doc: string): Promise<void> {
    const db = await openApprovalsDb(baseDir)
    db.handle.db
      .prepare(
        'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
          'requested_at, expires_at, change_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        approvalId as string,
        'pending',
        doc,
        'github',
        'create_issue',
        'a'.repeat(64),
        '2026-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z',
        changeSeq,
      )
  }

  /** A record the pending validator accepts, so the row is delivered rather than dropped. */
  function pendingDoc(approvalId: string): string {
    return JSON.stringify({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: 'a'.repeat(64),
      sessionId: 'session-good',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
  }

  test('a truncated page whose every row was dropped keeps the watermark at the caller sequence', async () => {
    await useForeignApprovalsTable()
    // Two rows the change reader cannot use (a non-text primary key), then a
    // perfectly good change behind them.
    await insertForeignRow(1, 1, '{}')
    await insertForeignRow(2, 2, '{}')
    await insertForeignRow('01ARZ3NDEKTSV4RRFFQ69G5FAV', 3, pendingDoc('01ARZ3NDEKTSV4RRFFQ69G5FAV'))
    const db = await openApprovalsDb(baseDir)
    db.handle.db.prepare('UPDATE approvals_meta SET change_seq = ? WHERE id = 1').run(9)
    const queue = createApprovalQueue({ baseDir })

    const page = await queue.changesSince(0, { limit: 1 })

    expect(page.truncated).toBe(true)
    expect(page.newPending).toEqual([])
    // NOT the global 9: that would skip the good change at sequence 3 forever.
    expect(page.latestSeq).toBe(0)
  })

  test('an UNtruncated page still drops the malformed rows and reports the global watermark', async () => {
    // The guard for the fix above: only the truncated-and-empty case changes.
    // A page that fits its bound has seen everything up to the head, so the
    // global sequence is exactly the right watermark even when rows were
    // dropped on the way — and the usable change is still delivered.
    await useForeignApprovalsTable()
    await insertForeignRow(1, 1, '{}')
    await insertForeignRow(2, 2, '{}')
    await insertForeignRow('01ARZ3NDEKTSV4RRFFQ69G5FAV', 3, pendingDoc('01ARZ3NDEKTSV4RRFFQ69G5FAV'))
    const db = await openApprovalsDb(baseDir)
    db.handle.db.prepare('UPDATE approvals_meta SET change_seq = ? WHERE id = 1').run(9)
    const queue = createApprovalQueue({ baseDir })

    const page = await queue.changesSince(0, { limit: 10 })

    expect(page.truncated).toBe(false)
    expect(page.newPending.map((entry) => entry.approvalId)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV'])
    expect(page.latestSeq).toBe(9)
  })
})
