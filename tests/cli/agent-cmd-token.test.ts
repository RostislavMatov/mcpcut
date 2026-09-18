import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { runAgentCommand, type AgentCliOptions } from '../../src/cli/agent-cmd.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decisions T4 and T1 (2026-09-01): every `agent` MUTATION needs a
 * personal admin token of role `owner` in `MCP_ADMIN_TOKEN`, and each one
 * leaves both an stderr audit line and an `access-edit` journal record.
 * `agent list` stays token-free.
 *
 * The rationale is G2: a personal grant SHADOWS the agent's groups for that
 * server wholesale, so removing one WIDENS effective access — the narrowing
 * instrument of the model must not be editable anonymously.
 *
 * Every case sets `env` explicitly, so a real `MCP_ADMIN_TOKEN` in the
 * developer's shell can never leak into a test.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agent-token-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

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

/** Options with NO token: the reading subcommand and every refusal case. */
function anonOpts(): AgentCliOptions {
  return { journalDir, env: {} }
}

/** Mints an admin through the production store and returns options carrying its token. */
async function optsForAdmin(name: string, role: AdminRole): Promise<AgentCliOptions> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

async function ownerOpts(): Promise<AgentCliOptions> {
  return optsForAdmin('alice', 'owner')
}

function agents(): ReturnType<typeof createAgentsStore> {
  return createAgentsStore({ journalDir })
}

/** Registers a stdio server so `agent grant` may name it (owner decision S1, 2026-09-03). */
async function seedServer(name: string): Promise<void> {
  await createRegistryStore(journalDir).addServer({ name, transport: 'stdio', command: 'node' })
}

/** Every `access-edit` payload written under the reserved session, oldest first. */
async function accessRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

/** The four mutations, each with the state it needs and the store fact it would change. */
const MUTATIONS = [
  { name: 'create', argv: ['create', 'new-bot'] },
  { name: 'grant', argv: ['grant', 'research-bot', 'github'] },
  { name: 'ungrant', argv: ['ungrant', 'research-bot', 'github'] },
  { name: 'revoke', argv: ['revoke', 'research-bot'] },
] as const

/** An agent that already exists and already holds a grant, for the three non-create cases. */
async function seedGrantedAgent(): Promise<void> {
  const store = agents()
  await store.createAgent('research-bot')
  await store.grantServer('research-bot', 'github', ['read_file'])
}

describe('agent mutations require an owner token (T4)', () => {
  for (const mutation of MUTATIONS) {
    test(`${mutation.name} without a token → exit 1, store untouched, nothing journalled`, async () => {
      // Arrange
      await seedGrantedAgent()
      const io = fakeIo()

      // Act
      const code = await runAgentCommand([...mutation.argv], io, anonOpts())

      // Assert
      expect(code).toBe(1)
      expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
      expect(io.err()).toContain('owner')
      expect(await agents().getAgent('new-bot')).toBeUndefined()
      const research = await agents().getAgent('research-bot')
      expect(research?.grants['github']).toEqual({ tools: ['read_file'] })
      expect(research?.revokedAt).toBeUndefined()
      expect(await accessRecords()).toHaveLength(0)
    })

    test(`${mutation.name} with an unknown token → exit 1 and nothing changes`, async () => {
      await seedGrantedAgent()
      const io = fakeIo()

      const code = await runAgentCommand([...mutation.argv], io, {
        journalDir,
        env: { [ADMIN_TOKEN_ENV_VAR]: 'mcpj_not-a-real-token' },
      })

      expect(code).toBe(1)
      expect(io.err()).toContain('does not match any active admin')
      expect(await agents().getAgent('new-bot')).toBeUndefined()
      expect((await agents().getAgent('research-bot'))?.grants['github']).toEqual({
        tools: ['read_file'],
      })
      expect(await accessRecords()).toHaveLength(0)
    })

    for (const role of ['viewer', 'operator'] as const) {
      test(`${mutation.name} as ${role} → exit 1, the refusal names the owner role`, async () => {
        await seedGrantedAgent()
        const opts = await optsForAdmin(`${role}-admin`, role)
        const io = fakeIo()

        const code = await runAgentCommand([...mutation.argv], io, opts)

        expect(code).toBe(1)
        expect(io.err()).toContain('"owner" is required')
        expect(await agents().getAgent('new-bot')).toBeUndefined()
        const research = await agents().getAgent('research-bot')
        expect(research?.grants['github']).toEqual({ tools: ['read_file'] })
        expect(research?.revokedAt).toBeUndefined()
        expect(await accessRecords()).toHaveLength(0)
      })
    }
  }

  test('a bad admin store refuses BEFORE the write instead of crashing', async () => {
    // Arrange — an admin token that cannot be resolved at all: the refusal must
    // still be a refusal, never an unattributed write (fail closed).
    await seedGrantedAgent()
    const io = fakeIo()

    const code = await runAgentCommand(['grant', 'research-bot', 'jira'], io, {
      journalDir,
      env: { [ADMIN_TOKEN_ENV_VAR]: '' },
    })

    expect(code).toBe(1)
    expect((await agents().getAgent('research-bot'))?.grants['jira']).toBeUndefined()
  })

  test('agent list needs no token at all', async () => {
    await seedGrantedAgent()
    const io = fakeIo()

    const code = await runAgentCommand(['list'], io, anonOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain('research-bot')
  })
})

describe('agent mutations are attributed and journalled (T4/T1)', () => {
  test('create: audit line, an agent.create record, and NO token in either', async () => {
    // Arrange
    const opts = await ownerOpts()
    const io = fakeIo()

    // Act
    const code = await runAgentCommand(['create', 'research-bot'], io, opts)

    // Assert — the token is printed exactly once, on stdout, and reaches
    // neither the audit line nor the journal: the record has no field for a
    // secret and must never grow one.
    expect(code).toBe(0)
    const token = /^token: (\S+)$/m.exec(io.out())?.[1]
    expect(token).toMatch(/^mcpj_/)
    expect(io.err()).toContain('[audit] agent create by alice (owner): research-bot')
    expect(io.err()).not.toContain(token as string)
    const records = await accessRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'agent.create',
      agent: 'research-bot',
    })
    expect(JSON.stringify(records[0])).not.toContain(token as string)
  })

  test('grant: the record carries the grant that was written', async () => {
    const opts = await ownerOpts()
    await seedServer('github')
    await runAgentCommand(['create', 'research-bot'], fakeIo(), opts)
    const io = fakeIo()

    const code = await runAgentCommand(
      ['grant', 'research-bot', 'github', '--tools', 'read_file', '--prompts', '*'],
      io,
      opts,
    )

    expect(code).toBe(0)
    expect(io.err()).toContain('[audit] agent grant by alice (owner): research-bot/github')
    const records = await accessRecords()
    expect(records.at(-1)).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'agent.grant',
      agent: 'research-bot',
      server: 'github',
      grant: { tools: ['read_file'], prompts: '*' },
    })
  })

  test('ungrant: an ordinary agent.ungrant record, even when it WIDENS access', async () => {
    // Arrange — the T1 tail: removing a personal grant hands the agent its
    // groups' (wider) grant back. The warning says so; the record stays the
    // plain `agent.ungrant`.
    const opts = await ownerOpts()
    await seedServer('github')
    await runAgentCommand(['create', 'research-bot'], fakeIo(), opts)
    await runAgentCommand(['grant', 'research-bot', 'github', '--tools', 'read_file'], fakeIo(), opts)
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', '*')
    await groups.addMember('analytics', 'research-bot')
    const io = fakeIo()

    // Act
    const code = await runAgentCommand(['ungrant', 'research-bot', 'github'], io, opts)

    // Assert
    expect(code).toBe(0)
    expect(io.err()).toContain('effective access WIDENED')
    expect(io.err()).toContain('[audit] agent ungrant by alice (owner): research-bot/github')
    expect(await accessRecords()).toContainEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'agent.ungrant',
      agent: 'research-bot',
      server: 'github',
    })
  })

  test('revoke: audit line and an agent.revoke record', async () => {
    const opts = await ownerOpts()
    await runAgentCommand(['create', 'research-bot'], fakeIo(), opts)
    const io = fakeIo()

    const code = await runAgentCommand(['revoke', 'research-bot'], io, opts)

    expect(code).toBe(0)
    expect(io.err()).toContain('[audit] agent revoke by alice (owner): research-bot')
    expect(await accessRecords()).toContainEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'agent.revoke',
      agent: 'research-bot',
    })
  })

  test('a failed change writes NO record: the refusal comes from the store', async () => {
    // Arrange — a grant for an agent nobody created never lands, so an
    // `agent.grant` record would show an auditor a change that never happened.
    const opts = await ownerOpts()
    await seedServer('github')
    const io = fakeIo()

    const code = await runAgentCommand(['grant', 'nobody', 'github'], io, opts)

    expect(code).toBe(1)
    expect(await accessRecords()).toHaveLength(0)
  })

  test('a grant to an unregistered server writes NO record and NO audit line (S1)', async () => {
    // Arrange — the agent exists; the server does not. The refusal comes
    // before the write, so there is no change to attribute.
    const opts = await ownerOpts()
    await runAgentCommand(['create', 'research-bot'], fakeIo(), opts)
    const io = fakeIo()

    // Act
    const code = await runAgentCommand(['grant', 'research-bot', 'ghost'], io, opts)

    // Assert
    expect(code).toBe(1)
    expect(io.err()).toContain('unknown server "ghost"')
    expect(io.err()).not.toContain('[audit]')
    expect((await agents().getAgent('research-bot'))?.grants).toEqual({})
    // Only the `agent.create` of the Arrange step is in the journal.
    expect((await accessRecords()).map((record) => record.action)).toEqual(['agent.create'])
  })

  test('a dropped journal record is said out loud but keeps exit 0', async () => {
    // Arrange — the change is already in the store when the journal is asked;
    // a sink that cannot commit must not fake a failed command.
    const opts = await ownerOpts()
    const io = fakeIo()

    const code = await runAgentCommand(['create', 'research-bot'], io, {
      ...opts,
      deps: {
        sink: {
          retryDelayMs: 0,
          commitBatchImpl: () => {
            throw new Error('journal is down')
          },
        },
      },
    })

    expect(code).toBe(0)
    expect((await agents().getAgent('research-bot'))?.name).toBe('research-bot')
    expect(io.err()).toContain('[journal]')
  })
})
