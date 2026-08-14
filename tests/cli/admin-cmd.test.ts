import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runAdminCommand, type AdminCliIo } from '../../src/cli/admin-cmd.js'

/**
 * `mcp-journal admin add|list|remove|rotate|role` (M4 Task 16): the CLI half of
 * named admin identities.
 *
 * The load-bearing guarantee these tests exist for is the one-time token: a
 * plaintext admin token must appear EXACTLY once, on stdout, and must never
 * reach `admins.json` (only its sha256 hash does). Every assertion about that
 * scans the real store file rather than trusting the store's API contract.
 *
 * Everything runs against a temp journal dir — the real `~/.mcp-journal` is
 * never touched.
 */

const CLOCK_ISO = '2026-08-11T10:00:00.000Z'
const TOKEN_PATTERN = /mcpa_[A-Za-z0-9_-]+/g

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-admin-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

interface CapturedIo extends AdminCliIo {
  outText(): string
  errText(): string
}

function captureIo(): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    outText: () => out.join(''),
    errText: () => err.join(''),
  }
}

/** Runs one `admin ...` invocation against the temp journal dir. */
async function runAdmin(
  args: readonly string[],
  io: CapturedIo = captureIo(),
): Promise<{ code: number; io: CapturedIo }> {
  const code = await runAdminCommand([...args], io, {
    journalDir,
    clock: () => new Date(CLOCK_ISO),
  })
  return { code, io }
}

/** Raw contents of `admins.json`, or `''` when the file does not exist. */
async function adminsFileText(): Promise<string> {
  return readFile(join(journalDir, ADMINS_FILE_NAME), 'utf8').catch(() => '')
}

function tokensIn(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? []
}

// ---------------------------------------------------------------------------
// admin add
// ---------------------------------------------------------------------------

describe('admin add', () => {
  test('prints the token exactly once on stdout and never writes it to disk', async () => {
    const { code, io } = await runAdmin(['add', 'alice', '--role', 'owner'])

    expect(code).toBe(0)
    const tokens = tokensIn(io.outText())
    expect(tokens).toHaveLength(1)
    const token = tokens[0] as string

    // The one guarantee that matters: only the hash lands in the store.
    const store = createAdminStore({ journalDir })
    const admin = await store.getActiveAdmin('alice')
    expect(admin?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(admin?.tokenHash).not.toContain(token)
    // Nor does the token leak to the diagnostics channel.
    expect(tokensIn(io.errText())).toEqual([])
  })

  test('warns against redirecting stdout, on the same stream as the token', async () => {
    const { io } = await runAdmin(['add', 'alice', '--role', 'owner'])

    expect(io.outText()).toContain("Do not redirect this command's stdout")
  })

  test('records the name, role and creation time in the store', async () => {
    await runAdmin(['add', 'alice', '--role', 'operator'])

    const store = createAdminStore({ journalDir })
    const admin = await store.getActiveAdmin('alice')
    expect(admin?.role).toBe('operator')
    expect(admin?.createdAt).toBe(CLOCK_ISO)
    expect(admin?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a duplicate name is refused with exit 1 and no second token', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])

    const { code, io } = await runAdmin(['add', 'alice', '--role', 'viewer'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('alice')
    expect(tokensIn(io.outText())).toEqual([])
    // The original record is untouched.
    const store = createAdminStore({ journalDir })
    expect((await store.getActiveAdmin('alice'))?.role).toBe('owner')
  })

  test('an invalid role is refused before anything is created', async () => {
    const { code, io } = await runAdmin(['add', 'alice', '--role', 'superuser'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('superuser')
    expect(await adminsFileText()).toBe('')
  })

  test('a missing --role is a usage error', async () => {
    const { code, io } = await runAdmin(['add', 'alice'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('--role')
    expect(await adminsFileText()).toBe('')
  })

  test('an invalid admin name is refused', async () => {
    const { code, io } = await runAdmin(['add', 'Alice!', '--role', 'owner'])

    expect(code).toBe(1)
    expect(io.errText().length).toBeGreaterThan(0)
    expect(await adminsFileText()).toBe('')
  })

  test('a missing name is a usage error', async () => {
    const { code, io } = await runAdmin(['add', '--role', 'owner'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })

  test('an unknown flag fails with usage on stderr', async () => {
    const { code, io } = await runAdmin(['add', 'alice', '--role', 'owner', '--nope'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
    expect(io.outText()).toBe('')
    expect(await adminsFileText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// admin list
// ---------------------------------------------------------------------------

describe('admin list', () => {
  test('shows name, role and dates but never a token hash', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['add', 'bob', '--role', 'viewer'])
    const store = createAdminStore({ journalDir })
    const hash = (await store.getActiveAdmin('alice'))?.tokenHash as string

    const { code, io } = await runAdmin(['list'])

    expect(code).toBe(0)
    const text = io.outText()
    expect(text).toContain('alice')
    expect(text).toContain('owner')
    expect(text).toContain('bob')
    expect(text).toContain('viewer')
    expect(text).toContain(CLOCK_ISO)
    expect(text).not.toContain(hash)
    expect(text).not.toContain('tokenHash')
    expect(tokensIn(text)).toEqual([])
  })

  test('shows the rotation date once an admin has been rotated', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['rotate', 'alice'])

    const { io } = await runAdmin(['list'])

    expect(io.outText()).toContain('rotated')
  })

  test('an empty store lists nothing rather than failing', async () => {
    const { code, io } = await runAdmin(['list'])

    expect(code).toBe(0)
    expect(io.outText()).toContain('no admins')
  })

  test('revoked admins are not listed', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['add', 'bob', '--role', 'viewer'])
    await runAdmin(['remove', 'bob'])

    const { io } = await runAdmin(['list'])

    expect(io.outText()).toContain('alice')
    expect(io.outText()).not.toContain('bob')
  })
})

// ---------------------------------------------------------------------------
// admin remove
// ---------------------------------------------------------------------------

describe('admin remove', () => {
  test('refuses to remove the last remaining owner', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['add', 'bob', '--role', 'operator'])

    const { code, io } = await runAdmin(['remove', 'alice'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('owner')
    const store = createAdminStore({ journalDir })
    expect(await store.getActiveAdmin('alice')).toBeDefined()
  })

  test('removes a non-last owner', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['add', 'carol', '--role', 'owner'])

    const { code } = await runAdmin(['remove', 'carol'])

    expect(code).toBe(0)
    const store = createAdminStore({ journalDir })
    expect(await store.getActiveAdmin('carol')).toBeUndefined()
    expect(await store.getActiveAdmin('alice')).toBeDefined()
  })

  test('an unknown admin is an error, not a silent success', async () => {
    const { code, io } = await runAdmin(['remove', 'nobody'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('nobody')
  })

  test('a missing name is a usage error', async () => {
    const { code, io } = await runAdmin(['remove'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })
})

// ---------------------------------------------------------------------------
// admin rotate
// ---------------------------------------------------------------------------

describe('admin rotate', () => {
  test('prints a fresh token once and replaces the stored hash', async () => {
    const first = await runAdmin(['add', 'alice', '--role', 'owner'])
    const firstToken = tokensIn(first.io.outText())[0] as string
    const store = createAdminStore({ journalDir })
    const firstHash = (await store.getActiveAdmin('alice'))?.tokenHash as string

    const { code, io } = await runAdmin(['rotate', 'alice'])

    expect(code).toBe(0)
    const tokens = tokensIn(io.outText())
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).not.toBe(firstToken)

    const admin = await store.getActiveAdmin('alice')
    expect(admin?.tokenHash).not.toContain(tokens[0] as string)
    expect(admin?.tokenHash).not.toContain(firstToken)
    expect(admin?.tokenHash).not.toBe(firstHash)
    expect(admin?.rotatedAt).toBe(CLOCK_ISO)
  })

  test('warns against redirecting stdout, on the same stream as the fresh token', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])

    const { io } = await runAdmin(['rotate', 'alice'])

    expect(io.outText()).toContain("Do not redirect this command's stdout")
  })

  test('an unknown admin is refused', async () => {
    const { code, io } = await runAdmin(['rotate', 'nobody'])

    expect(code).toBe(1)
    expect(tokensIn(io.outText())).toEqual([])
  })

  test('a missing name is a usage error', async () => {
    const { code, io } = await runAdmin(['rotate'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })
})

// ---------------------------------------------------------------------------
// admin role
// ---------------------------------------------------------------------------

describe('admin role', () => {
  test('changes an admin role', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])
    await runAdmin(['add', 'bob', '--role', 'viewer'])

    const { code, io } = await runAdmin(['role', 'bob', 'operator'])

    expect(code).toBe(0)
    expect(io.outText()).toContain('operator')
    const store = createAdminStore({ journalDir })
    expect((await store.getActiveAdmin('bob'))?.role).toBe('operator')
  })

  test('refuses to demote the last owner', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])

    const { code, io } = await runAdmin(['role', 'alice', 'viewer'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('owner')
    const store = createAdminStore({ journalDir })
    expect((await store.getActiveAdmin('alice'))?.role).toBe('owner')
  })

  test('an invalid role is refused', async () => {
    await runAdmin(['add', 'alice', '--role', 'owner'])

    const { code, io } = await runAdmin(['role', 'alice', 'root'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('root')
  })

  test('missing arguments are a usage error', async () => {
    const { code, io } = await runAdmin(['role', 'alice'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })
})

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('admin subcommand dispatch', () => {
  test('an unknown subcommand prints usage and exits 1', async () => {
    const { code, io } = await runAdmin(['frobnicate'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
    expect(io.outText()).toBe('')
  })

  test('a missing subcommand prints usage and exits 1', async () => {
    const { code, io } = await runAdmin([])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })

  test('the top-level dispatcher routes `admin` here', async () => {
    const { dispatch } = await import('../../src/cli.js')
    const io = captureIo()

    const code = await dispatch(['admin', 'add', 'alice', '--role', 'owner'], io, {
      admin: { journalDir, clock: () => new Date(CLOCK_ISO) },
    })

    expect(code).toBe(0)
    expect(tokensIn(io.outText())).toHaveLength(1)
  })

  test('a corrupt admins file fails loudly with exit 1, not a crash', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{ not json', 'utf8')

    const { code, io } = await runAdmin(['list'])

    expect(code).toBe(1)
    expect(io.errText().length).toBeGreaterThan(0)
  })
})
