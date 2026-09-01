import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runAgentCommand } from '../../src/cli/agent-cmd.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { GROUPS_FILE_NAME } from '../../src/groups/constants.js'
import { createGroupsStore } from '../../src/groups/store.js'

/**
 * M4 Task 6: `agent grant --resources/--prompts`. The pre-M4 CLI surface is
 * pinned by `agent-cmd.test.ts`, which this file does not touch; everything
 * here is the additive grant-dictionary extension.
 */

let journalDir: string
let ownerToken: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-agent-grants-'))
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
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

/**
 * Every mutation runs AS a named owner (owner decision T4, 2026-09-01): the
 * gate itself is covered by `agent-cmd-token.test.ts`, so the behaviour tests
 * here carry a valid token and stay about what the command DOES.
 */
function run(args: string[], io = fakeIo()): Promise<number> {
  return runAgentCommand(args, io, { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken } })
}

describe('agent grant --resources/--prompts', () => {
  test('persists resource and prompt patterns alongside tools', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(
      [
        'grant',
        'research-bot',
        'github',
        '--tools',
        'get_*',
        '--resources',
        'file:///project/*,doc://handbook',
        '--prompts',
        'greet*',
      ],
      io,
    )

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toEqual({
      tools: ['get_*'],
      resources: ['file:///project/*', 'doc://handbook'],
      prompts: ['greet*'],
    })
    expect(io.out()).toContain('resources')
    expect(io.out()).toContain('prompts')
  })

  test("--resources '*' stores the literal wildcard", async () => {
    await run(['create', 'research-bot'])

    const exitCode = await run(['grant', 'research-bot', 'github', '--resources', '*'])

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']?.resources).toBe('*')
    // No --tools flag keeps the existing default: all tools.
    expect(agent?.grants['github']?.tools).toBe('*')
  })

  test('omitting the flags leaves the fields absent (M3-shaped grant)', async () => {
    await run(['create', 'research-bot'])

    await run(['grant', 'research-bot', 'github', '--tools', 'get_*'])

    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toEqual({ tools: ['get_*'] })
  })

  test('an invalid resource pattern (embedded *) → exit 1, nothing stored', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--resources', 'file:///a*b'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('resource')
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toBeUndefined()
  })

  test('an invalid prompt pattern (slash) → exit 1', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--prompts', 'bad/name'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('prompt')
  })

  test('an empty --resources value → exit 1 with a hint', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--resources', ' , '], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--resources')
  })

  test('agent list renders the resources and prompts lines for extended grants', async () => {
    await run(['create', 'research-bot'])
    await run([
      'grant',
      'research-bot',
      'github',
      '--tools',
      'get_*',
      '--resources',
      'file:///project/*',
      '--prompts',
      '*',
    ])
    const io = fakeIo()

    const exitCode = await run(['list'], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github: get_*')
    expect(io.out()).toContain('resources: file:///project/*')
    expect(io.out()).toContain('prompts: * (all prompts)')
  })

  test('ungrant removes the whole grant including resources/prompts', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--resources', 'file:///p/*'])

    const exitCode = await run(['ungrant', 'research-bot', 'github'])

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toBeUndefined()
  })
})

/**
 * U1, CLI half: `agent ungrant` of a personal grant that SHADOWS a group grant
 * (ADR-0010 §2) widens effective access instead of narrowing it. The command
 * still succeeds — the UI is where confirmation lives — but the shell must not
 * be left believing it just took access away.
 */
describe('agent ungrant warns when a group grant is uncovered', () => {
  test('names every group the agent now inherits the server from', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.createGroup('ops')
    await groups.grantServer('analytics', 'github', ['read_file'])
    await groups.grantServer('ops', 'github', '*')
    await groups.addMember('analytics', 'research-bot')
    await groups.addMember('ops', 'research-bot')
    const io = fakeIo()

    const exitCode = await run(['ungrant', 'research-bot', 'github'], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('removed grant github from research-bot')
    expect(io.err()).toContain(
      '[warn] research-bot now inherits github from group:analytics, group:ops — effective access WIDENED',
    )
  })

  test('stays silent when no group of the agent grants that server', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'other', ['x'])
    await groups.addMember('analytics', 'research-bot')
    const io = fakeIo()

    const exitCode = await run(['ungrant', 'research-bot', 'github'], io)

    expect(exitCode).toBe(0)
    // stderr still carries the T4 audit line — what must be absent is the warning.
    expect(io.err()).not.toContain('[warn]')
  })

  test('a group the agent is not a member of raises no warning', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', '*')
    const io = fakeIo()

    await run(['ungrant', 'research-bot', 'github'], io)

    expect(io.err()).not.toContain('[warn]')
  })

  test('an unreadable groups document is reported, not swallowed, and the ungrant still succeeds', async () => {
    // Arrange — the warning is advisory, but "I could not look" must never be
    // indistinguishable from "there is nothing to warn about".
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    await writeFile(join(journalDir, GROUPS_FILE_NAME), '{ not json at all', 'utf8')
    const io = fakeIo()

    // Act
    const exitCode = await run(['ungrant', 'research-bot', 'github'], io)

    // Assert
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('removed grant github from research-bot')
    expect(io.err()).toContain('[warn] could not check group grants for research-bot:')
    expect((await createAgentsStore({ journalDir }).getAgent('research-bot'))?.grants).toEqual({})
  })
})

describe('agent list renders the EFFECTIVE matrix (personal ∪ groups)', () => {
  test('a group-only agent lists the inherited server instead of "(no grants)"', async () => {
    // Arrange
    await run(['create', 'research-bot'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', ['read_file'])
    await groups.addMember('analytics', 'research-bot')
    const io = fakeIo()

    // Act
    const exitCode = await run(['list'], io)

    // Assert
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('  github: read_file (via group:analytics)')
    expect(io.out()).not.toContain('(no grants)')
  })

  test('an inherited row names every contributing group and unions their tools', async () => {
    // Arrange
    await run(['create', 'research-bot'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.createGroup('ops')
    await groups.grantServer('analytics', 'github', ['read_file'])
    await groups.grantServer('ops', 'github', ['list_repos'])
    await groups.addMember('analytics', 'research-bot')
    await groups.addMember('ops', 'research-bot')
    const io = fakeIo()

    // Act
    await run(['list'], io)

    // Assert
    expect(io.out()).toContain('  github: list_repos, read_file (via group:analytics, group:ops)')
  })

  test('a personal grant that shadows a group grant says so, and shows the PERSONAL tools', async () => {
    // Arrange — G2: a personal grant takes the server whole, so the narrower
    // personal list is what the agent actually gets.
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', '*')
    await groups.addMember('analytics', 'research-bot')
    const io = fakeIo()

    // Act
    await run(['list'], io)

    // Assert
    expect(io.out()).toContain('  github: read_file (overrides group:analytics)')
  })

  test('inherited method dimensions are rendered like personal ones', async () => {
    // Arrange
    await run(['create', 'research-bot'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', ['read_file'], {
      resources: ['file:///notes/*'],
      prompts: '*',
    })
    await groups.addMember('analytics', 'research-bot')
    const io = fakeIo()

    // Act
    await run(['list'], io)

    // Assert
    expect(io.out()).toContain('    resources: file:///notes/*')
    expect(io.out()).toContain('    prompts: * (all prompts)')
  })

  test('an agent in no group renders exactly as before — no origin suffix at all', async () => {
    // Arrange
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', '*')
    const io = fakeIo()

    // Act
    await run(['list'], io)

    // Assert
    expect(io.out()).toContain('  github: read_file\n')
    expect(io.out()).not.toContain('(via ')
    expect(io.out()).not.toContain('(overrides ')
  })

  test('an unreadable groups document fails the listing loudly instead of understating access', async () => {
    // Arrange
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    await writeFile(join(journalDir, GROUPS_FILE_NAME), 'not json', 'utf8')
    const io = fakeIo()

    // Act
    const exitCode = await run(['list'], io)

    // Assert — a matrix that silently drops the group half would read as a
    // narrower access than the agent actually has.
    expect(exitCode).toBe(1)
    expect(io.err()).not.toBe('')
  })
})
