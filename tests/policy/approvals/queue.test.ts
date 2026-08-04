import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { canonicalJson, sha256Hex } from '../../../src/policy/hash.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-queue-test-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
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

describe('createApprovalQueue: enqueue', () => {
  test('writes a pending file with redacted args; the raw secret never lands on disk', async () => {
    const queue = createApprovalQueue({ baseDir })

    const { approvalId, argsHash } = await queue.enqueue(baseRequest())

    const filePath = join(baseDir, 'pending', `${approvalId}.json`)
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain(SECRET_MARKER)

    const parsed = JSON.parse(raw)
    expect(parsed.approvalId).toBe(approvalId)
    expect(parsed.serverName).toBe('github')
    expect(parsed.toolName).toBe('create_issue')
    expect(parsed.toolClass).toBe('write')
    expect(parsed.sessionId).toBe('session-1')
    expect(parsed.argsRedacted.title).toBe('hello')
    expect(parsed.argsRedacted.apiKey).toBe('[REDACTED]')
    expect(parsed.argsHash).toBe(argsHash)
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

    const parsed = JSON.parse(await readFile(join(baseDir, 'pending', `${approvalId}.json`), 'utf8'))
    expect(parsed.requestedAt).toBe(new Date(startMs).toISOString())
    expect(parsed.expiresAt).toBe(new Date(startMs + 30_000).toISOString())
  })

  test('does not leave a .tmp file behind after a successful enqueue', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    await expect(access(join(baseDir, 'pending', `${approvalId}.json.tmp`))).rejects.toThrow()
  })

  test.skipIf(process.platform === 'win32')(
    'creates pending/ with mode 0700 and the pending file with mode 0600',
    async () => {
      const queue = createApprovalQueue({ baseDir })
      await queue.enqueue(baseRequest())

      const dirStat = await stat(join(baseDir, 'pending'))
      expect(dirStat.mode & 0o777).toBe(0o700)

      const files = await import('node:fs/promises').then((fs) => fs.readdir(join(baseDir, 'pending')))
      const fileStat = await stat(join(baseDir, 'pending', files[0] as string))
      expect(fileStat.mode & 0o777).toBe(0o600)
    },
  )
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

  test('skips malformed files instead of throwing', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(baseRequest())

    await mkdir(join(baseDir, 'pending'), { recursive: true })
    await writeFile(join(baseDir, 'pending', 'garbage.json'), 'not json at all', 'utf8')
    await writeFile(
      join(baseDir, 'pending', 'wrong-shape.json'),
      JSON.stringify({ unrelated: true }),
      'utf8',
    )

    const listed = await queue.list()
    expect(listed).toHaveLength(1)
  })

  test('returns an empty array when the pending directory does not exist yet', async () => {
    const queue = createApprovalQueue({ baseDir })
    await expect(queue.list()).resolves.toEqual([])
  })
})

describe('createApprovalQueue: resolve', () => {
  test('moves the pending file to resolved/ and attaches the resolution', async () => {
    const nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest())

    const result = await queue.resolve(approvalId, { outcome: 'approved', actor: 'alice' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution).toEqual({ outcome: 'approved', actor: 'alice' })
    expect(result.record.resolvedAt).toBe(new Date(nowMs).toISOString())

    await expect(access(join(baseDir, 'pending', `${approvalId}.json`))).rejects.toThrow()
    const resolvedRaw = await readFile(join(baseDir, 'resolved', `${approvalId}.json`), 'utf8')
    expect(JSON.parse(resolvedRaw).resolution.outcome).toBe('approved')
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

  test('markExpired moves the pending file to resolved/ with outcome "expired"', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const result = await queue.markExpired(approvalId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.record.resolution).toEqual({ outcome: 'expired' })
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

    // No 'approved' resolution reached disk (so checkRecentApproval cannot mint a grant).
    const resolvedRaw = await readFile(join(baseDir, 'resolved', `${approvalId}.json`), 'utf8')
    expect(JSON.parse(resolvedRaw).resolution.outcome).toBe('expired')
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

  test('returns null (never throws) for a malformed resolved file', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    await queue.resolve(approvalId, { outcome: 'approved' })

    await writeFile(join(baseDir, 'resolved', `${approvalId}.json`), 'not json', 'utf8')

    await expect(queue.readResolution(approvalId)).resolves.toBeNull()
  })
})
