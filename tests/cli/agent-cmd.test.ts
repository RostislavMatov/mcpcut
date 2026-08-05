import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runAgentCommand } from '../../src/cli/agent-cmd.js'
import { createAgentsStore } from '../../src/agents/store.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-agent-cmd-'))
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

function run(args: string[], io = fakeIo()): Promise<number> {
  return runAgentCommand(args, io, { journalDir })
}

describe('agent create', () => {
  test('prints the token exactly ONCE with a save-it-now warning, exit 0', async () => {
    const io = fakeIo()

    const exitCode = await run(['create', 'research-bot'], io)

    expect(exitCode).toBe(0)
    const tokenMatches = io.out().match(/mcpj_[A-Za-z0-9_-]{43}/g) ?? []
    expect(tokenMatches).toHaveLength(1)
    const combined = io.out() + io.err()
    expect(combined.toLowerCase()).toContain('cannot be recovered')
  })

  test('the printed token actually authenticates against the store', async () => {
    const io = fakeIo()
    await run(['create', 'research-bot'], io)
    const token = (io.out().match(/mcpj_[A-Za-z0-9_-]{43}/) ?? [])[0] as string

    const found = await createAgentsStore({ journalDir }).findAgentByToken(token)

    expect(found?.name).toBe('research-bot')
  })

  test('duplicate name → exit 1 with a clear error, no second token printed', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['create', 'research-bot'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('research-bot')
    expect(io.out()).not.toMatch(/mcpj_/)
  })

  test('invalid name → exit 1 and mentions the allowed format', async () => {
    const io = fakeIo()

    const exitCode = await run(['create', 'Bad Name!'], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
  })

  test('missing name → usage on stderr, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['create'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('agent list', () => {
  test('empty store → friendly "(no agents)" line', async () => {
    const io = fakeIo()

    const exitCode = await run(['list'], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('(no agents)')
  })

  test('shows name, created date, revoked marker, and human-readable grants', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github', '--tools', 'get_*,list_issues'])
    await run(['grant', 'research-bot', 'jira'])
    await run(['create', 'old-bot'])
    await run(['revoke', 'old-bot'])
    const io = fakeIo()

    const exitCode = await run(['list'], io)

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('research-bot')
    expect(out).toMatch(/github.*get_\*, list_issues/)
    expect(out).toMatch(/jira.*\*/)
    expect(out).toContain('old-bot')
    expect(out).toContain('REVOKED')
    // never leak hashes to the terminal
    expect(out).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('agent grant / ungrant', () => {
  test("grant without --tools grants '*' (all tools)", async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github'], io)

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toEqual({ tools: '*' })
  })

  test('grant with --tools splits on commas and trims blanks', async () => {
    await run(['create', 'research-bot'])

    const exitCode = await run([
      'grant',
      'research-bot',
      'github',
      '--tools',
      ' get_* , list_issues ',
    ])

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toEqual({ tools: ['get_*', 'list_issues'] })
  })

  test('grant with an empty --tools value → exit 1 with usage-style error', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--tools', ' , '], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
  })

  test('grant with a bad tool pattern → exit 1 with a clear message', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--tools', 'a*b'], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
  })

  test('grant to an unknown agent → exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['grant', 'nobody', 'github'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nobody')
  })

  test('ungrant removes the server grant', async () => {
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github'])

    const exitCode = await run(['ungrant', 'research-bot', 'github'])

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants).toEqual({})
  })

  test('untrusted names echoed in errors are sanitized (no raw control characters)', async () => {
    const io = fakeIo()

    const exitCode = await run(['grant', 'evil\u0007name', 'github'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('\u0007')
  })
})

describe('agent revoke', () => {
  test('revoke marks the agent revoked, exit 0', async () => {
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['revoke', 'research-bot'], io)

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.revokedAt).toBeDefined()
  })

  test('revoke of an unknown agent → exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['revoke', 'nobody'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nobody')
  })
})

describe('dispatch and usage', () => {
  test('unknown subcommand → usage on stderr, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['frobnicate'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('no subcommand → usage on stderr, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})
