import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

function request(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    args: { title: 'hello' },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

function opts(env: NodeJS.ProcessEnv = {}): ApprovalsCliOptions {
  return { baseDir, journalDir: tempDir, cwd: tempDir, env }
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
    // The note is said by `approvals list`, not after every decision.
    expect(io.err()).not.toContain('no admins yet')
  })

  test('list says once, on stderr, that no admin exists yet and what adding one changes', async () => {
    await pendingId()
    await createAdminStore({ journalDir: tempDir }).listAdmins()
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('no admins yet')
    expect(io.err()).toContain('mcpcut admin add')
    expect(io.out()).not.toContain('no admins yet')
  })

  test('list stays quiet about admins once one exists', async () => {
    await createAdminStore({ journalDir: tempDir }).createAdmin('me', 'owner')
    await pendingId()
    const io = fakeIo()

    await runApprovals(['list'], io, opts())

    expect(io.err()).not.toContain('no admins yet')
  })

  test('list still prints the queue, without the note, when the admin store cannot be read', async () => {
    const approvalId = await pendingId()
    // A directory where the legacy admins file belongs: the store reports it as corrupt (`unreadable`).
    await mkdir(join(tempDir, ADMINS_FILE_NAME))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(approvalId)
    expect(io.err()).not.toContain('no admins yet')
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

  test('without the token, the refusal names ways out that do not need it', async () => {
    // The owner made in the web UI's first run: the README's click path leaves
    // an admin behind, so a held call then needs a token here.
    await createAdminStore({ journalDir: tempDir }).createAdmin('me', 'owner')
    const io = fakeIo()

    await runApprovals(['approve', await pendingId()], io, opts())

    expect(io.err()).toContain('shown once, when your admin was created')
    expect(io.err()).toContain("Or approve it on the web UI's dashboard while signed in.")
    expect(io.err()).toContain('Lost the token? mcpcut admin rotate <your-name> --recover')
    // `admin add` needs the owner's token itself once an admin exists: a dead end.
    expect(io.err()).not.toContain('admin add')
  })

  test('a token that IS set is still checked: on an empty store it matches nobody and is refused', async () => {
    const approvalId = await pendingId()
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts({ [ADMIN_TOKEN_ENV_VAR]: 'mcpa_stale' }))

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('no admins yet')
    expect(io.err()).toContain('no working token: mcpcut admin rotate <name> --recover')
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

describe('approve says what happens to the call (0.2.3, stranger run of 0.2.2)', () => {
  test('while the agent still waits, the call goes through now -- no retry is involved', async () => {
    const { approvalId } = await createApprovalQueue({ baseDir }).enqueue(request({ waitTimeoutMs: 60_000 }))
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('goes through now')
    expect(io.out()).not.toContain('retry')
  })

  test('no approval promises a retry any more: there is no grant window (M36)', async () => {
    // A row whose recorded wait cap has passed is one the gate has already
    // closed in a live system; even read straight from storage, an approval
    // of it says nothing about a later retry, which would ask again.
    const { approvalId } = await createApprovalQueue({ baseDir }).enqueue(request({ waitTimeoutMs: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).not.toContain('retry')
    expect(io.out()).not.toContain('grant')
  })

  test('the no-admins note comes only with an action that happened, never before an unknown-id error', async () => {
    await pendingId() // an install with a queue and no admin: the note's own precondition
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', '01UNKNOWN'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('no admins yet')
  })
})
