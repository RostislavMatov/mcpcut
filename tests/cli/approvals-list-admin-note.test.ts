import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runApprovals } from '../../src/cli/approvals-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'

/**
 * The "no admins yet" note on `approvals list` is advice next to the list,
 * not part of it: a failure the admin store did not classify (a bug, not a
 * corrupt or locked store) must not take the pending calls off the screen.
 * `approve`/`deny` ask the store again and refuse there.
 */
vi.mock('../../src/cli/admin-token.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/admin-token.js')>()),
  adminStoreEmptiness: vi.fn(async () => {
    throw new Error('unclassified admin store failure')
  }),
}))

let tempDir: string
let baseDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-list-note-'))
  baseDir = join(tempDir, 'approvals')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('approvals list: the no-admins note', () => {
  test('an unexpected admin store error leaves the list printed and the exit code 0', async () => {
    const { approvalId } = await createApprovalQueue({ baseDir }).enqueue({
      serverName: 'fs',
      toolName: 'write_file',
      toolClass: 'write',
      args: { path: 'notes.txt' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }

    const exitCode = await runApprovals(['list'], io, { baseDir, journalDir: tempDir, cwd: tempDir, env: {} })

    expect(exitCode).toBe(0)
    expect(out.join('')).toContain(approvalId)
    expect(err.join('')).not.toContain('no admins yet')
  })
})
