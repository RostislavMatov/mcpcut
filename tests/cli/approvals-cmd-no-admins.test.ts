import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { NO_ADMINS_YET_ACTOR } from '../../src/cli/admin-token.js'
import { runApprovals, type ApprovalsCliOptions } from '../../src/cli/approvals-cmd.js'
import { createApprovalQueue, type EnqueueRequest } from '../../src/policy/approvals/queue.js'

/**
 * Owner decision 2026-09-25 (first-minute friction): on an install where NO
 * admin exists yet, `approvals approve|deny` need no `MCP_ADMIN_TOKEN`. That
 * grants nothing new — on such an install the first `admin add` is token-free
 * already (ADR-0004) — and the resolution still carries a subject (ADR-0007
 * O3): `cli:_unattributed`, which no admin name can spell.
 *
 * The moment an admin exists the token is required again, a token that IS set
 * is checked as before, and an admin store that cannot be read refuses —
 * "cannot tell whether anyone exists" is never read as "nobody does".
 */

let tempDir: string
let baseDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-no-admins-'))
  baseDir = join(tempDir, 'approvals')
})

afterEach(async () => {
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

function request(): EnqueueRequest {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    args: { title: 'hello' },
    sessionId: 'session-1',
    timeoutMs: 60_000,
  }
}

function opts(env: NodeJS.ProcessEnv = {}): ApprovalsCliOptions {
  return { baseDir, journalDir: tempDir, env }
}

async function pendingId(): Promise<string> {
  return (await createApprovalQueue({ baseDir }).enqueue(request())).approvalId
}

describe('approvals approve|deny on an install with no admins yet', () => {
  test('approve needs no token, and the resolution names the shell, not a person', async () => {
    const approvalId = await pendingId()
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts())

    expect(exitCode).toBe(0)
    const resolution = await createApprovalQueue({ baseDir }).readResolution(approvalId)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe(NO_ADMINS_YET_ACTOR)
    expect(NO_ADMINS_YET_ACTOR).toBe('cli:_unattributed')
    expect(io.err()).toContain('no admins yet')
    expect(io.err()).toContain('mcpcut admin add')
  })

  test('deny works the same way', async () => {
    const approvalId = await pendingId()

    const exitCode = await runApprovals(['deny', approvalId], fakeIo(), opts())

    expect(exitCode).toBe(0)
    expect((await createApprovalQueue({ baseDir }).readResolution(approvalId))?.actor).toBe(NO_ADMINS_YET_ACTOR)
  })

  test('once an admin exists, the token is required again and nothing is resolved without it', async () => {
    await createAdminStore({ journalDir: tempDir }).createAdmin('me', 'owner')
    const approvalId = await pendingId()
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(await createApprovalQueue({ baseDir }).readResolution(approvalId)).toBeNull()
  })

  test('a token that IS set is still checked: on an empty store it matches nobody and is refused', async () => {
    const approvalId = await pendingId()
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts({ [ADMIN_TOKEN_ENV_VAR]: 'mcpa_stale' }))

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('no admins yet')
    expect(await createApprovalQueue({ baseDir }).readResolution(approvalId)).toBeNull()
  })

  test('an admin store that cannot be read refuses: unknown is never taken for empty', async () => {
    await writeFile(join(tempDir, ADMINS_FILE_NAME), '{ not json', 'utf8')
    const approvalId = await pendingId()
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('no admins yet')
    expect(io.err()).not.toContain('    at ')
    expect(await createApprovalQueue({ baseDir }).readResolution(approvalId)).toBeNull()
  })

  test('a data directory with no state.db (a wrong MCPCUT_DATA_DIR, say) is not a fresh install: refused', async () => {
    const approvalId = await pendingId()
    const elsewhere = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-elsewhere-'))
    const io = fakeIo()

    try {
      const exitCode = await runApprovals(['approve', approvalId], io, { baseDir, journalDir: elsewhere, env: {} })

      expect(exitCode).toBe(1)
      expect(io.err()).not.toContain('no admins yet')
      expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
