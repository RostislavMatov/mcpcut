import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runAdminCommand, type AdminCliIo } from '../../src/cli/admin-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * `mcp-journal admin add|list|remove|rotate|role` (M4 Task 16): the CLI half of
 * named admin identities.
 *
 * The load-bearing guarantee these tests exist for is the one-time token: a
 * plaintext admin token must appear EXACTLY once, on stdout, and must never
 * reach `admins.json` (only its sha256 hash does) — nor the journal record
 * the change now leaves. Every assertion about that scans the real store file
 * (and the real `journal.db`) rather than trusting an API contract.
 *
 * Since the owner decision of 2026-09-06 every one of these commands needs a
 * personal owner token in `MCP_ADMIN_TOKEN`, with two exemptions the tests
 * below pin: the FIRST admin of an empty store (there is nobody to hold a
 * token yet) and `admin rotate --recover` (the way back in when the last
 * owner lost theirs). Both are recorded with an unattributed actor.
 *
 * Everything runs against a temp journal dir — the real `~/.mcp-journal` is
 * never touched.
 */

const CLOCK_ISO = '2026-08-11T10:00:00.000Z'
const TOKEN_PATTERN = /mcpa_[A-Za-z0-9_-]+/g

let journalDir: string
/** The token of the owner every gated invocation below runs as; `''` until one is seeded. */
let ownerToken: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-admin-cmd-'))
  ownerToken = ''
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

/**
 * Runs one `admin ...` invocation against the temp journal dir, as the owner
 * `seedOwner` minted. The environment is always an object of this test's own
 * making: a token exported in the developer's shell must never reach the
 * command under test.
 */
async function runAdmin(
  args: readonly string[],
  io: CapturedIo = captureIo(),
  env: NodeJS.ProcessEnv = { [ADMIN_TOKEN_ENV_VAR]: ownerToken },
): Promise<{ code: number; io: CapturedIo }> {
  const code = await runAdminCommand([...args], io, {
    journalDir,
    clock: () => new Date(CLOCK_ISO),
    env,
  })
  return { code, io }
}

/**
 * Mints the first owner the way an operator would — `admin add` on an empty
 * store, which needs no token — and remembers its token as the one every
 * later invocation runs as.
 */
async function seedOwner(name = 'alice'): Promise<string> {
  const { code, io } = await runAdmin(['add', name, '--role', 'owner'])
  expect(code, io.errText()).toBe(0)
  ownerToken = tokensIn(io.outText())[0] as string
  return ownerToken
}

/** Every `access-edit` record in the temp journal, in commit order. */
async function accessRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
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
    await seedOwner('alice')

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
    await seedOwner('alice')
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
    const rotated = await seedOwner('alice')
    const { io: rotation } = await runAdmin(['rotate', 'alice'])
    // Rotating the owner invalidates the token every later call runs as.
    expect(tokensIn(rotation.outText())[0]).not.toBe(rotated)
    ownerToken = tokensIn(rotation.outText())[0] as string

    const { io } = await runAdmin(['list'])

    expect(io.outText()).toContain('rotated')
  })

  test('an empty store lists nothing rather than failing', async () => {
    const { code, io } = await runAdmin(['list'])

    expect(code).toBe(0)
    expect(io.outText()).toContain('no admins')
  })

  test('revoked admins are not listed', async () => {
    await seedOwner('alice')
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
    await seedOwner('alice')
    await runAdmin(['add', 'bob', '--role', 'operator'])

    const { code, io } = await runAdmin(['remove', 'alice'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('owner')
    const store = createAdminStore({ journalDir })
    expect(await store.getActiveAdmin('alice')).toBeDefined()
  })

  test('removes a non-last owner', async () => {
    await seedOwner('alice')
    await runAdmin(['add', 'carol', '--role', 'owner'])

    const { code } = await runAdmin(['remove', 'carol'])

    expect(code).toBe(0)
    const store = createAdminStore({ journalDir })
    expect(await store.getActiveAdmin('carol')).toBeUndefined()
    expect(await store.getActiveAdmin('alice')).toBeDefined()
  })

  test('an unknown admin is an error, not a silent success', async () => {
    await seedOwner('alice')

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
    const firstToken = await seedOwner('alice')
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
    await seedOwner('alice')

    const { io } = await runAdmin(['rotate', 'alice'])

    expect(io.outText()).toContain("Do not redirect this command's stdout")
  })

  test('an unknown admin is refused', async () => {
    await seedOwner('alice')

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
    await seedOwner('alice')
    await runAdmin(['add', 'bob', '--role', 'viewer'])

    const { code, io } = await runAdmin(['role', 'bob', 'operator'])

    expect(code).toBe(0)
    expect(io.outText()).toContain('operator')
    const store = createAdminStore({ journalDir })
    expect((await store.getActiveAdmin('bob'))?.role).toBe('operator')
  })

  test('refuses to demote the last owner', async () => {
    await seedOwner('alice')

    const { code, io } = await runAdmin(['role', 'alice', 'viewer'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('owner')
    const store = createAdminStore({ journalDir })
    expect((await store.getActiveAdmin('alice'))?.role).toBe('owner')
  })

  test('an invalid role is refused', async () => {
    await seedOwner('alice')

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
      admin: { journalDir, clock: () => new Date(CLOCK_ISO), env: {} },
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

// ---------------------------------------------------------------------------
// The owner gate and the access-edit records (owner decision 2026-09-06)
// ---------------------------------------------------------------------------

describe('the owner gate in front of admin *', () => {
  test('the first admin of an empty store needs no token', async () => {
    const { code, io } = await runAdmin(['add', 'root', '--role', 'owner'], captureIo(), {})

    expect(code, io.errText()).toBe(0)
    expect(tokensIn(io.outText())).toHaveLength(1)
  })

  test('a second admin without a token is refused, and nothing is created', async () => {
    await seedOwner('alice')

    const { code, io } = await runAdmin(['add', 'bob', '--role', 'viewer'], captureIo(), {})

    expect(code).toBe(1)
    expect(io.errText()).toContain('Refusing to change admins: no admin token.')
    expect(io.errText()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(tokensIn(io.outText())).toEqual([])
    expect(await createAdminStore({ journalDir }).getActiveAdmin('bob')).toBeUndefined()
  })

  test('a token that matches no admin is refused', async () => {
    await seedOwner('alice')

    const { code, io } = await runAdmin(['add', 'bob', '--role', 'viewer'], captureIo(), {
      [ADMIN_TOKEN_ENV_VAR]: 'mcpa_not-a-real-token',
    })

    expect(code).toBe(1)
    expect(io.errText()).toContain('does not match any active admin')
  })

  test.each([
    ['add', ['add', 'bob', '--role', 'viewer']],
    ['rotate', ['rotate', 'alice']],
    ['role', ['role', 'alice', 'operator']],
    ['remove', ['remove', 'alice']],
    ['list', ['list']],
  ])('an operator token may not %s', async (_name, args) => {
    await seedOwner('alice')
    const { io: added } = await runAdmin(['add', 'op', '--role', 'operator'])
    const operatorToken = tokensIn(added.outText())[0] as string

    const { code, io } = await runAdmin([...args], captureIo(), {
      [ADMIN_TOKEN_ENV_VAR]: operatorToken,
    })

    expect(code).toBe(1)
    expect(io.errText()).toContain('role "owner" is required')
    expect(io.errText()).toContain('may not manage admins')
  })

  test('list needs a token once the store holds an admin', async () => {
    await seedOwner('alice')

    const refused = await runAdmin(['list'], captureIo(), {})
    const allowed = await runAdmin(['list'])

    expect(refused.code).toBe(1)
    expect(refused.io.errText()).toContain('Refusing to list admins: no admin token.')
    expect(refused.io.outText()).toBe('')
    expect(allowed.code).toBe(0)
    expect(allowed.io.outText()).toContain('alice')
  })

  test('list on an empty store needs none', async () => {
    const { code, io } = await runAdmin(['list'], captureIo(), {})

    expect(code).toBe(0)
    expect(io.outText()).toContain('no admins')
  })
})

describe('the access-edit record every admin mutation leaves', () => {
  test('the bootstrap add is recorded with an unattributed actor', async () => {
    await runAdmin(['add', 'root', '--role', 'owner'], captureIo(), {})

    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: null, role: null, via: 'cli' },
        action: 'admin.add',
        admin: 'root',
        targetRole: 'owner',
      },
    ])
  })

  test('add names the admin, the role given and the owner who gave it', async () => {
    await seedOwner('alice')

    const { io } = await runAdmin(['add', 'bob', '--role', 'operator'])

    expect(io.errText()).toContain('[audit] admin add by alice (owner): bob')
    expect((await accessRecords())[1]).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'admin.add',
      admin: 'bob',
      targetRole: 'operator',
    })
  })

  test('rotate, role and remove each leave exactly one record', async () => {
    await seedOwner('alice')
    await runAdmin(['add', 'bob', '--role', 'viewer'])

    await runAdmin(['rotate', 'bob'])
    await runAdmin(['role', 'bob', 'operator'])
    await runAdmin(['remove', 'bob'])

    expect((await accessRecords()).slice(2)).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'admin.rotate',
        admin: 'bob',
      },
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'admin.role',
        admin: 'bob',
        targetRole: 'operator',
      },
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'admin.remove',
        admin: 'bob',
      },
    ])
  })

  test('list is read-only: it writes no record', async () => {
    await seedOwner('alice')

    await runAdmin(['list'])

    expect(await accessRecords()).toHaveLength(1)
  })

  test('a refused mutation writes no record at all', async () => {
    await seedOwner('alice')

    await runAdmin(['add', 'bob', '--role', 'viewer'], captureIo(), {})
    await runAdmin(['remove', 'nobody'])

    expect(await accessRecords()).toHaveLength(1)
  })

  test('no record ever carries a plaintext token', async () => {
    await seedOwner('alice')
    await runAdmin(['add', 'bob', '--role', 'viewer'])
    await runAdmin(['rotate', 'bob'])
    await runAdmin(['rotate', 'carol', '--recover'])

    const text = JSON.stringify(await accessRecords())

    expect(tokensIn(text)).toEqual([])
    expect(text).not.toContain('token')
  })
})

describe('admin rotate --recover', () => {
  test('mints a fresh token with no admin token at all', async () => {
    const firstToken = await seedOwner('alice')

    const { code, io } = await runAdmin(['rotate', 'alice', '--recover'], captureIo(), {})

    expect(code, io.errText()).toBe(0)
    const tokens = tokensIn(io.outText())
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).not.toBe(firstToken)
  })

  test('is recorded as an unattributed recovery', async () => {
    await seedOwner('alice')

    const { io } = await runAdmin(['rotate', 'alice', '--recover'], captureIo(), {})

    expect(io.errText()).toContain('[audit] admin rotate by unattributed: alice')
    expect((await accessRecords())[1]).toEqual({
      actor: { adminName: null, role: null, via: 'cli' },
      action: 'admin.rotate',
      admin: 'alice',
      recovery: true,
    })
  })

  test('an ordinary rotate carries no recovery flag', async () => {
    await seedOwner('alice')
    await runAdmin(['add', 'bob', '--role', 'viewer'])

    await runAdmin(['rotate', 'bob'])

    expect((await accessRecords())[2]).not.toHaveProperty('recovery')
  })

  test('an unknown admin is still refused, and nothing is recorded', async () => {
    await seedOwner('alice')

    const { code, io } = await runAdmin(['rotate', 'nobody', '--recover'], captureIo(), {})

    expect(code).toBe(1)
    expect(tokensIn(io.outText())).toEqual([])
    expect(await accessRecords()).toHaveLength(1)
  })

  test('the usage block names the flag and the token rule', async () => {
    const { io } = await runAdmin(['frobnicate'])

    expect(io.errText()).toContain('--recover')
    expect(io.errText()).toContain(ADMIN_TOKEN_ENV_VAR)
  })

  test('--recover is not a flag of the other subcommands', async () => {
    await seedOwner('alice')

    const { code, io } = await runAdmin(['remove', 'alice', '--recover'])

    expect(code).toBe(1)
    expect(io.errText()).toContain('Usage')
  })
})

describe('admin list: the refusal explains a read, not a change', () => {
  test('without a token the refusal names the owner rule of the listing itself', async () => {
    await seedOwner()
    const io = captureIo()

    const code = await runAdminCommand(['list'], io, { journalDir, env: {} })

    expect(code).toBe(1)
    expect(io.errText()).toContain('Refusing to list admins')
    expect(io.errText()).toContain('the list of admins is for owners')
    expect(io.errText()).not.toContain('records which admin made it')
  })
})
