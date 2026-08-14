import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_GRANT_TTL_MS } from '../../src/policy/constants.js'
import { createApprovalQueue, type EnqueueRequest } from '../../src/policy/approvals/queue.js'
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

  test('flags an entry whose expiresAt is in the past as expired, using the injected clock', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, clock: () => nowMs })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('expired')
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
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].approvalId).toBe(approvalId)
    expect(parsed[0].argsRedacted.apiKey).toBe('[REDACTED]')
  })

  test('--json on an empty queue prints an empty, parseable array', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.out())).toEqual([])
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
