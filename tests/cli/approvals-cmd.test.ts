import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { APPROVALS_LIST_MAX_ROWS } from '../../src/config.js'
import { DEFAULT_GRANT_TTL_MS } from '../../src/policy/constants.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type EnqueueRequest,
  type PendingApproval,
} from '../../src/policy/approvals/queue.js'
import { runApprovals } from '../../src/cli/approvals-cmd.js'

let tempDir: string
let baseDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-cmd-test-'))
  baseDir = join(tempDir, 'approvals')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): { stdout: { write: (chunk: string) => void }; stderr: { write: (chunk: string) => void }; out: () => string; err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const SECRET_MARKER = 'sk-live-abcdefghijklmnopqrstuvwx'

function baseRequest(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    args: { title: 'hello', apiKey: SECRET_MARKER },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

/**
 * Minimal fake satisfying `ApprovalQueue`, for exercising the truncation path
 * without seeding hundreds of real rows through the on-disk queue. Only
 * `list`/`countPending` are exercised by the `list` subcommand; every other
 * member throws if a test path reaches it unexpectedly.
 */
function fakeQueue(entries: PendingApproval[], totalPending: number): ApprovalQueue {
  const notImplemented = (method: string) => (): never => {
    throw new Error(`fakeQueue.${method} should not be called by this test`)
  }
  return {
    enqueue: notImplemented('enqueue'),
    list: async () => entries,
    countPending: async () => totalPending,
    resolve: notImplemented('resolve'),
    markExpired: notImplemented('markExpired'),
    readResolution: notImplemented('readResolution'),
    listResolved: notImplemented('listResolved'),
    changesSince: notImplemented('changesSince'),
  }
}

function fakePendingEntry(index: number): PendingApproval {
  return {
    approvalId: `01ARZ3NDEKTSV4RRFFQ69G5FA${String(index).padStart(2, '0')}`,
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    argsRedacted: { title: `entry-${index}` },
    argsHash: 'hash',
    sessionId: 'session-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
    expired: false,
  }
}

/**
 * A read that actually hit its bound. Truncation is derived from THIS, not from
 * `totalPending > entries.length`: `list()` and `countPending()` are separate
 * transactions, so a request committing between them once reported truncation
 * on a queue of one — which flipped the JSON shape and broke a consumer.
 */
function fakeBoundedPage(): PendingApproval[] {
  return Array.from({ length: APPROVALS_LIST_MAX_ROWS }, (_unused, index) => fakePendingEntry(index + 1))
}

describe('runApprovals: list, bounded-read truncation', () => {
  test('readable mode: a queue larger than the bound states what is shown vs. what exists', async () => {
    const queue = fakeQueue(fakeBoundedPage(), 900)
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(`${APPROVALS_LIST_MAX_ROWS} of 900 pending`)
    expect(out).toContain('showing the oldest')
  })

  test('--json mode: a queue larger than the bound reports truncated alongside the bounded page', async () => {
    const entries = fakeBoundedPage()
    const queue = fakeQueue(entries, 900)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.truncated).toBe(true)
    expect(parsed.totalPending).toBe(900)
    expect(parsed.approvals).toHaveLength(APPROVALS_LIST_MAX_ROWS)
    expect(parsed.approvals[0].approvalId).toBe(entries[0]?.approvalId)
  })

  test('a short page is never truncated, even if countPending() raced ahead of list()', async () => {
    // The exact race that broke `policy-integration`: one entry listed, a
    // second request committed between the two reads.
    const queue = fakeQueue([fakePendingEntry(1)], 2)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.truncated).toBe(false)
    expect(parsed.approvals).toHaveLength(1)
  })

  test('readable mode: a queue at/under the bound prints no truncation note (pins existing behaviour)', async () => {
    const entries = [fakePendingEntry(1)]
    const queue = fakeQueue(entries, 1)
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).not.toContain('showing the oldest')
    expect(out).not.toMatch(/\bof\b.*\bpending\b/)
  })

  test('--json mode: the envelope shape is the same whether or not the read was truncated', async () => {
    const queue = fakeQueue([fakePendingEntry(1)], 1)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed).toEqual({
      truncated: false,
      totalPending: 1,
      approvals: [fakePendingEntry(1)],
    })
  })

  test('an empty queue is unchanged in both modes', async () => {
    const queue = fakeQueue([], 0)
    const readableIo = fakeIo()
    const jsonIo = fakeIo()

    const readableExit = await runApprovals(['list'], readableIo, { baseDir, queue })
    const jsonExit = await runApprovals(['list', '--json'], jsonIo, { baseDir, queue })

    expect(readableExit).toBe(0)
    expect(readableIo.out()).toBe('no pending approvals\n')
    expect(jsonExit).toBe(0)
    expect(JSON.parse(jsonIo.out())).toEqual({ truncated: false, totalPending: 0, approvals: [] })
  })
})

describe('runApprovals: list', () => {
  test('prints "no pending approvals" and returns 0 when the queue is empty', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no pending approvals')
  })

  test('lists pending entries with redacted args, hiding the raw secret', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(approvalId)
    expect(out).toContain('github')
    expect(out).toContain('create_issue')
    expect(out).toContain('write')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(SECRET_MARKER)
  })

  test('an entry whose expiresAt has passed is swept out of the queue, not listed as pending work', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, clock: () => nowMs })

    // `list()` sweeps at the injected clock (`policy/approvals/queue-sweep.ts`),
    // so a request nobody answered settles as `expired` instead of lingering as
    // a dead `expires_in=expired` line for the rest of the session's life.
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no pending approvals')
    expect(io.out()).not.toContain(approvalId)
    // Settled, not silently dropped: the outcome is the one session teardown writes.
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'expired' })
  })

  test('an unexpired entry shows remaining time, not "expired"', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, clock: () => nowMs })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).not.toMatch(/\bexpired\b/)
  })

  test('--json prints parseable JSON describing the pending entries', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.approvals).toHaveLength(1)
    expect(parsed.approvals[0].approvalId).toBe(approvalId)
    expect(parsed.approvals[0].argsRedacted.apiKey).toBe('[REDACTED]')
  })

  test('--json on an empty queue prints an empty, parseable envelope', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.out())).toEqual({ truncated: false, totalPending: 0, approvals: [] })
  })

  test('truncates a long redacted-args preview to roughly 200 characters', async () => {
    const queue = createApprovalQueue({ baseDir })
    const longValue = 'x'.repeat(500)
    await queue.enqueue(baseRequest({ args: { note: longValue } }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out.length).toBeLessThan(600)
  })

  test('neutralizes control characters in toolName in the readable list output', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(baseRequest({ toolName: 'evil\x1b[2Jtool' }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    const withoutLineBreaks = out.replace(/\n/g, '')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(withoutLineBreaks)).toBe(false)
    expect(out).toContain('evil?[2Jtool')
  })
})

describe('runApprovals: approve', () => {
  test('approves a pending request and confirms the retry window', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(approvalId)
    const expectedMinutes = String(Math.round(DEFAULT_GRANT_TTL_MS / 60_000))
    expect(io.out()).toContain(expectedMinutes)

    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe('cli')
  })

  test('accepts --reason and persists it on the resolution', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId, '--reason', 'looks fine'], io, { baseDir })

    expect(exitCode).toBe(0)
    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.reason).toBe('looks fine')
  })

  test('approving the same id twice fails the second time with exit code 1', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const first = await runApprovals(['approve', approvalId], io, { baseDir })
    const second = await runApprovals(['approve', approvalId], io, { baseDir })

    expect(first).toBe(0)
    expect(second).toBe(1)
    expect(io.err()).toMatch(/already resolved or unknown id/)
  })

  test('approving an unknown id returns 1 with a clear message', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/already resolved or unknown id/)
  })

  test('missing <id> prints usage and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['approve'], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('runApprovals: deny', () => {
  test('denies a pending request', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', approvalId, '--reason', 'not authorized'], io, { baseDir })

    expect(exitCode).toBe(0)
    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('denied')
    expect(resolution?.reason).toBe('not authorized')
  })

  test('denying an unknown id returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], io, { baseDir })

    expect(exitCode).toBe(1)
  })
})

describe('runApprovals: unknown/missing subcommand', () => {
  test('no subcommand prints usage and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals([], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('unknown subcommand prints usage and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['bogus'], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})
