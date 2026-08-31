import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runGroupCommand, type GroupCliOptions } from '../../src/cli/group-cmd.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * `group create|remove|list|show|grant|ungrant|join|leave` (plan
 * m55-server-groups, Task 9): the CLI surface of server groups. Mutations run
 * under a personal admin token of role `owner` (G4) and leave both an stderr
 * audit line and an `access-edit` journal record; reads need no token.
 *
 * Every case is driven through `runGroupCommand` with captured io, a temp
 * journal directory and `env` explicitly set, so a real `MCP_ADMIN_TOKEN` in
 * the developer's shell can never leak into a test.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-group-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

/** Options with NO token: the reading subcommands and every refusal case. */
function anonOpts(): GroupCliOptions {
  return { journalDir, env: {} }
}

/** Mints an admin through the production store and returns options carrying its token. */
async function optsForAdmin(name: string, role: AdminRole): Promise<GroupCliOptions> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

async function ownerOpts(): Promise<GroupCliOptions> {
  return optsForAdmin('alice', 'owner')
}

function groups(): ReturnType<typeof createGroupsStore> {
  return createGroupsStore({ journalDir })
}

async function seedGroup(name: string): Promise<void> {
  await groups().createGroup(name)
}

async function seedServer(name: string): Promise<void> {
  await createRegistryStore(journalDir).addServer({ name, transport: 'stdio', command: 'node' })
}

async function seedAgent(name: string, revoke = false): Promise<void> {
  const store = createAgentsStore({ journalDir })
  await store.createAgent(name)
  if (revoke) await store.revokeAgent(name)
}

/** Every `access-edit` payload written under the reserved session, oldest first. */
async function accessRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

describe('group create', () => {
  test('creates the group, prints an audit line and journals the change, exit 0', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain('analytics')
    expect((await groups().getGroup('analytics'))?.name).toBe('analytics')
    expect(io.err()).toContain('[audit] group create by alice (owner): analytics')
    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'group.create',
        group: 'analytics',
      },
    ])
  })

  test('refuses without a token: exit 1, nothing written, nothing journaled', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, anonOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(await groups().listGroups()).toEqual([])
    expect(await accessRecords()).toEqual([])
  })

  test('refuses an unknown token, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, {
      journalDir,
      env: { [ADMIN_TOKEN_ENV_VAR]: 'mcpa_nope' },
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/does not match any active admin/)
    expect(await groups().listGroups()).toEqual([])
  })

  test.each(['operator', 'viewer'] as const)('refuses role %s: owner is required', async (role) => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, await optsForAdmin('bob', role))

    expect(code).toBe(1)
    expect(io.err()).toContain('role "owner"')
    expect(await groups().listGroups()).toEqual([])
    expect(await accessRecords()).toEqual([])
  })

  test('a duplicate name is an expected error, exit 1', async () => {
    await seedGroup('analytics')
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('already exists')
  })

  test('an invalid name is an expected error, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'Bad Name'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toMatch(/group name/i)
    expect(await groups().listGroups()).toEqual([])
  })

  test('a missing positional prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('group create <name>')
  })
})

describe('group dispatch', () => {
  test('an unknown subcommand prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['bogus'], io, anonOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('group create <name>')
  })

  test('no subcommand prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand([], io, anonOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('Usage:')
  })
})

describe('group remove', () => {
  test('removes an empty group and journals it, exit 0', async () => {
    await seedGroup('analytics')
    const io = fakeIo()

    const code = await runGroupCommand(['remove', 'analytics'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(await groups().getGroup('analytics')).toBeUndefined()
    expect(io.err()).toContain('[audit] group remove by alice (owner): analytics')
    expect((await accessRecords())[0]?.['action']).toBe('group.remove')
  })

  test('refuses a group that still has members, naming them, exit 1', async () => {
    await seedGroup('analytics')
    await groups().addMember('analytics', 'bot-a')
    await groups().addMember('analytics', 'bot-b')
    const io = fakeIo()

    const code = await runGroupCommand(['remove', 'analytics'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('still has members: bot-a, bot-b')
    expect(await groups().getGroup('analytics')).toBeDefined()
    expect(await accessRecords()).toEqual([])
  })

  test('an unknown group is an error, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['remove', 'ghost'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('ghost')
    expect(await accessRecords()).toEqual([])
  })
})

describe('group list', () => {
  test('reports an empty store without needing a token, exit 0', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['list'], io, anonOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain('(no groups)')
  })

  test('prints a padded NAME/SERVERS/MEMBERS table sorted by name', async () => {
    await seedGroup('analytics')
    await seedGroup('billing')
    await groups().grantServer('analytics', 'github', '*')
    await groups().addMember('analytics', 'bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['list'], io, anonOpts())

    expect(code).toBe(0)
    const lines = io.out().trimEnd().split('\n')
    expect(lines[0]).toMatch(/^NAME\s+SERVERS\s+MEMBERS$/)
    expect(lines[1]).toMatch(/^analytics\s+1\s+1$/)
    expect(lines[2]).toMatch(/^billing\s+0\s+0$/)
  })
})

describe('group show', () => {
  test('prints name, creation date, grants and members without a token', async () => {
    await seedGroup('analytics')
    await groups().grantServer('analytics', 'github', ['list_issues'], { resources: '*' })
    await groups().addMember('analytics', 'bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['show', 'analytics'], io, anonOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain('name: analytics')
    expect(io.out()).toContain('created:')
    expect(io.out()).toContain('github: list_issues')
    expect(io.out()).toContain('resources: * (all resources)')
    expect(io.out()).toContain('members: bot-a')
  })

  test('a group without grants or members says so', async () => {
    await seedGroup('analytics')
    const io = fakeIo()

    await runGroupCommand(['show', 'analytics'], io, anonOpts())

    expect(io.out()).toContain('(no grants)')
    expect(io.out()).toContain('members: (none)')
  })

  test('an unknown group is an error, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['show', 'ghost'], io, anonOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('ghost')
  })
})

describe('group grant', () => {
  test('grants a registered server with explicit tools and journals the grant, exit 0', async () => {
    await seedGroup('analytics')
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(
      ['grant', 'analytics', 'github', '--tools', 'list_issues,get_*'],
      io,
      await ownerOpts(),
    )

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.grants['github']).toEqual({
      tools: ['list_issues', 'get_*'],
    })
    expect(io.out()).toContain('granted github to group analytics')
    expect(io.err()).toContain('[audit] group grant by alice (owner): analytics/github')
    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'group.grant',
        group: 'analytics',
        server: 'github',
        grant: { tools: ['list_issues', 'get_*'] },
      },
    ])
  })

  test('omitting --tools grants all tools while resources/prompts stay denied', async () => {
    await seedGroup('analytics')
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(['grant', 'analytics', 'github'], io, await ownerOpts())

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.grants['github']).toEqual({ tools: '*' })
  })

  test('--resources * opens the resource surface explicitly', async () => {
    await seedGroup('analytics')
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(
      ['grant', 'analytics', 'github', '--resources', '*'],
      io,
      await ownerOpts(),
    )

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.grants['github']).toEqual({
      tools: '*',
      resources: '*',
    })
    expect(io.out()).toContain('resources: * (all resources)')
  })

  test('an empty --tools value is refused with a hint, exit 1', async () => {
    await seedGroup('analytics')
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(
      ['grant', 'analytics', 'github', '--tools', ' , '],
      io,
      await ownerOpts(),
    )

    expect(code).toBe(1)
    expect(io.err()).toContain('--tools was given but contains no tool patterns')
    expect((await groups().getGroup('analytics'))?.grants).toEqual({})
  })

  test('an unregistered server is refused before the write, exit 1', async () => {
    await seedGroup('analytics')
    const io = fakeIo()

    const code = await runGroupCommand(['grant', 'analytics', 'ghost'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('unknown server "ghost"')
    expect((await groups().getGroup('analytics'))?.grants).toEqual({})
    expect(await accessRecords()).toEqual([])
  })

  test('an unknown group is an expected error, exit 1', async () => {
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(['grant', 'ghost', 'github'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('ghost')
    expect(await accessRecords()).toEqual([])
  })

  test('refuses without a token before touching the registry or the store', async () => {
    await seedGroup('analytics')
    await seedServer('github')
    const io = fakeIo()

    const code = await runGroupCommand(['grant', 'analytics', 'github'], io, anonOpts())

    expect(code).toBe(1)
    expect((await groups().getGroup('analytics'))?.grants).toEqual({})
  })

  test('a wrong positional count prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['grant', 'analytics'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('group grant <group> <server>')
  })
})

describe('group ungrant', () => {
  test('removes the grant and journals it, exit 0', async () => {
    await seedGroup('analytics')
    await groups().grantServer('analytics', 'github', '*')
    const io = fakeIo()

    const code = await runGroupCommand(['ungrant', 'analytics', 'github'], io, await ownerOpts())

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.grants).toEqual({})
    expect(io.err()).toContain('[audit] group ungrant by alice (owner): analytics/github')
    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'group.ungrant',
        group: 'analytics',
        server: 'github',
      },
    ])
  })

  test('refuses without a token, exit 1', async () => {
    await seedGroup('analytics')
    await groups().grantServer('analytics', 'github', '*')
    const io = fakeIo()

    const code = await runGroupCommand(['ungrant', 'analytics', 'github'], io, anonOpts())

    expect(code).toBe(1)
    expect((await groups().getGroup('analytics'))?.grants['github']).toBeDefined()
  })
})

describe('group join / leave', () => {
  test('join adds a registered agent and journals it, exit 0', async () => {
    await seedGroup('analytics')
    await seedAgent('bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['join', 'analytics', 'bot-a'], io, await ownerOpts())

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.members).toEqual(['bot-a'])
    expect(io.err()).toContain('[audit] group join by alice (owner): analytics/bot-a')
    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'group.join',
        group: 'analytics',
        agent: 'bot-a',
      },
    ])
  })

  test('join refuses an agent that does not exist, exit 1', async () => {
    await seedGroup('analytics')
    const io = fakeIo()

    const code = await runGroupCommand(['join', 'analytics', 'ghost'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('unknown agent "ghost"')
    expect((await groups().getGroup('analytics'))?.members).toEqual([])
    expect(await accessRecords()).toEqual([])
  })

  test('join refuses a revoked agent (fail closed), exit 1', async () => {
    await seedGroup('analytics')
    await seedAgent('bot-a', true)
    const io = fakeIo()

    const code = await runGroupCommand(['join', 'analytics', 'bot-a'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('agent "bot-a" is revoked')
    expect((await groups().getGroup('analytics'))?.members).toEqual([])
  })

  test('leave removes the member and journals it, exit 0', async () => {
    await seedGroup('analytics')
    await groups().addMember('analytics', 'bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['leave', 'analytics', 'bot-a'], io, await ownerOpts())

    expect(code).toBe(0)
    expect((await groups().getGroup('analytics'))?.members).toEqual([])
    expect((await accessRecords())[0]?.['action']).toBe('group.leave')
  })

  test('leave does NOT require the agent to still exist (a member can be stale)', async () => {
    await seedGroup('analytics')
    await groups().addMember('analytics', 'bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['leave', 'analytics', 'bot-a'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(io.err()).not.toContain('unknown agent')
  })

  test('join refuses without a token, exit 1', async () => {
    await seedGroup('analytics')
    await seedAgent('bot-a')
    const io = fakeIo()

    const code = await runGroupCommand(['join', 'analytics', 'bot-a'], io, anonOpts())

    expect(code).toBe(1)
    expect((await groups().getGroup('analytics'))?.members).toEqual([])
  })
})

describe('group -- journal drop', () => {
  test('a dropped record is said out loud but the change stands, exit 0', async () => {
    const io = fakeIo()

    const code = await runGroupCommand(['create', 'analytics'], io, {
      ...(await ownerOpts()),
      deps: {
        sink: {
          retryDelayMs: 0,
          commitBatchImpl: () => {
            throw new Error('simulated commit failure')
          },
        },
      },
    })

    expect(code).toBe(0)
    expect(io.err()).toMatch(/journal record.*dropped/i)
    expect((await groups().getGroup('analytics'))?.name).toBe('analytics')
  })
})
