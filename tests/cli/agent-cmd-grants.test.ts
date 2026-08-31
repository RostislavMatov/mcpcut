import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runAgentCommand } from '../../src/cli/agent-cmd.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createGroupsStore } from '../../src/groups/store.js'

/**
 * M4 Task 6: `agent grant --resources/--prompts`. The pre-M4 CLI surface is
 * pinned by `agent-cmd.test.ts`, which this file does not touch; everything
 * here is the additive grant-dictionary extension.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-agent-grants-'))
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

function run(args: string[], io = fakeIo()): Promise<number> {
  return runAgentCommand(args, io, { journalDir })
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
    expect(io.err()).toBe('')
  })

  test('a group the agent is not a member of raises no warning', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'read_file'])
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'github', '*')
    const io = fakeIo()

    await run(['ungrant', 'research-bot', 'github'], io)

    expect(io.err()).toBe('')
  })
})
