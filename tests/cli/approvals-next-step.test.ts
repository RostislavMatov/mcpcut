import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runApprovals, type ApprovalsCliOptions } from '../../src/cli/approvals-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'

/**
 * `approvals` ends with the next command (owner's rule 2026-09-29): an empty
 * queue says what puts a call there, a pending call gets ready approve and
 * deny commands with its id, and an unknown id points back at the list.
 * Hints go to stderr, so `list` output and `--json` stay as they were.
 */

let tempDir: string
let opts: ApprovalsCliOptions

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-next-step-'))
  opts = { baseDir: join(tempDir, 'approvals'), journalDir: tempDir, cwd: tempDir, env: {} }
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempDir, { recursive: true, force: true })
})

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

async function enqueueOne(): Promise<string> {
  const queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
  const { approvalId } = await queue.enqueue({
    serverName: 'fs',
    toolName: 'write_file',
    toolClass: 'write',
    args: { path: '/tmp/x' },
    sessionId: 'session-1',
    timeoutMs: 60_000,
  })
  return approvalId
}

describe('approvals: the next command', () => {
  test('an empty queue says what puts a call there', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, opts)

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('no pending approvals\n')
    expect(io.err()).toContain('require-approval')
    expect(io.err()).toContain('mcpcut wrap --policy')
  })

  test('a pending call gets approve and deny commands with its id', async () => {
    const approvalId = await enqueueOne()
    const io = fakeIo()

    await runApprovals(['list'], io, opts)

    expect(io.err()).toContain(`mcpcut approvals approve ${approvalId}`)
    expect(io.err()).toContain(`mcpcut approvals deny ${approvalId}`)
  })

  test('--json stays one JSON document with no hint', async () => {
    await enqueueOne()
    const io = fakeIo()

    await runApprovals(['list', '--json'], io, opts)

    expect(() => JSON.parse(io.out())).not.toThrow()
    expect(io.err()).toBe('')
  })

  test('an unknown id points back at the pending list', async () => {
    const { token } = await createAdminStore({ journalDir: tempDir }).createAdmin('ops', 'operator')
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', 'nope'], io, { ...opts, env: { [ADMIN_TOKEN_ENV_VAR]: token } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('already resolved or unknown id')
    expect(io.err()).toContain('mcpcut approvals list')
  })
})
