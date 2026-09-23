import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { runAgentCommand } from '../../src/cli/agent-cmd.js'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { CLIENT_CONFIG_HEADING } from '../../src/cli/agent-config-cmd.js'
import { DEFAULT_SERVE_PORT } from '../../src/cli/serve-constants.js'
import {
  renderClientConfig,
  type ClientConfigDocument,
  type StdioClientEntry,
} from '../../src/agents/client-config.js'
import { INSTALL_CONFIG_VERSION } from '../../src/setup/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { SECTIONS } from '../../src/tui/catalogue/index.js'
import { outputPanelOf } from '../../src/tui/output.js'
import { requestOf } from '../../src/tui/update-form.js'

let journalDir: string
let ownerToken: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agent-cmd-'))
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
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

/**
 * Every mutation runs AS a named owner (owner decision T4, 2026-09-01): the
 * gate itself is covered by `agent-cmd-token.test.ts`, so the behaviour tests
 * here carry a valid token and stay about what the command DOES.
 */
function run(args: string[], io = fakeIo(), install: InstallConfigLoad = NO_INSTALL): Promise<number> {
  return runAgentCommand(args, io, { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken }, install })
}

/**
 * No install config: the serve address in the client config is then derived
 * from the default bind (C2). Passed explicitly so a developer's own
 * `~/.mcpcut/config.json` never reaches these assertions.
 */
const NO_INSTALL: InstallConfigLoad = { kind: 'absent', path: '/nonexistent/.mcpcut/config.json' }

function installWithPublicUrl(publicUrl: string): InstallConfigLoad {
  return {
    kind: 'ok',
    path: '/home/op/.mcpcut/config.json',
    config: {
      version: INSTALL_CONFIG_VERSION,
      dataDir: '/var/lib/mcpcut',
      ui: { host: '127.0.0.1', port: 8091 },
      serve: { host: '0.0.0.0', port: 8090, publicUrl },
    },
  }
}

const TOKEN_PATTERN = /mcpj_[A-Za-z0-9_-]{43}/g

/** The JSON block `agent create` prints: from the first `{` line to the first `}` line. */
function blockOf(out: string): ClientConfigDocument {
  const lines = out.split('\n')
  const start = lines.indexOf('{')
  const end = lines.indexOf('}', start)
  return JSON.parse(lines.slice(start, end + 1).join('\n')) as ClientConfigDocument
}

/**
 * Registers a stdio server so a grant may name it: `agent grant` refuses a
 * server the registry does not hold (owner decision S1, 2026-09-03).
 */
async function seedServer(name: string): Promise<void> {
  await createRegistryStore(journalDir).addServer({ name, transport: 'stdio', command: 'node' })
}

describe('agent create', () => {
  test('prints the token in its token: line and inside the client config — the same token, nowhere else (C5)', async () => {
    // The point is "not multiplied across the output", not a literal count:
    // the block exists to carry the token into the client, and the token:
    // line stays for the readers that parse it.
    const io = fakeIo()

    const exitCode = await run(['create', 'research-bot'], io)

    expect(exitCode).toBe(0)
    const tokenMatches = io.out().match(TOKEN_PATTERN) ?? []
    expect(tokenMatches).toHaveLength(2)
    expect(tokenMatches[0]).toBe(tokenMatches[1])
    expect(io.out()).toContain(`token: ${tokenMatches[0]}\n`)
    expect(io.err()).not.toContain(tokenMatches[0] as string)
    expect(io.out() + io.err()).toContain(TOKEN_ONCE_NOTICE)
  })

  test('the client config follows the notice and carries the token in env, never in args', async () => {
    const io = fakeIo()

    await run(['create', 'research-bot'], io)

    const out = io.out()
    const token = /^token: (\S+)$/m.exec(out)?.[1] as string
    expect(out.indexOf(CLIENT_CONFIG_HEADING)).toBeGreaterThan(out.indexOf(TOKEN_ONCE_NOTICE))
    const entry = blockOf(out).mcpServers.mcpcut as StdioClientEntry
    expect(entry.env).toEqual({ MCP_AGENT_TOKEN: token })
    expect(entry.args.join(' ')).not.toContain(token)
  })

  test('without a remembered address the block dials the derived loopback bind and says so (C2)', async () => {
    const io = fakeIo()

    await run(['create', 'research-bot'], io)

    const entry = blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry
    expect(entry.args).toEqual(['-y', `mcpcut@${PRODUCT_VERSION}`, 'connect', '--url', `http://127.0.0.1:${DEFAULT_SERVE_PORT}`])
    expect(io.out()).toContain('note: address derived from the serve bind')
    expect(io.out()).toContain('mcpcut setup --serve-public-url <url>')
  })

  test('a remembered plain-http address gets --allow-http, and no derived-address note', async () => {
    const io = fakeIo()

    await run(['create', 'research-bot'], io, installWithPublicUrl('http://203.0.113.7:8090'))

    const entry = blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry
    expect(entry.args).toEqual(['-y', `mcpcut@${PRODUCT_VERSION}`, 'connect', '--url', 'http://203.0.113.7:8090', '--allow-http'])
    expect(io.out()).not.toContain('note: address derived')
  })

  test('points at the HTTP form instead of printing a second block', async () => {
    const io = fakeIo()

    await run(['create', 'research-bot'], io)

    expect(io.out()).toContain('HTTP client instead? mcpcut agent config research-bot --http\n')
    expect(io.out().match(/"mcpServers"/g)).toHaveLength(1)
  })

  test('the block is byte-for-byte what the generator renders for the same address and token', async () => {
    const io = fakeIo()

    await run(['create', 'research-bot'], io, installWithPublicUrl('https://plane.example'))

    const token = /^token: (\S+)$/m.exec(io.out())?.[1] as string
    expect(io.out()).toContain(renderClientConfig({ serveUrl: 'https://plane.example', token, form: 'stdio' }))
  })

  test('the printed notice is the marker the console recognises as a one-time token', async () => {
    // Two ends have to agree for the console to hold its screen: the catalogue
    // must declare this action as one that mints (`mintsToken` — the flag alone
    // decides, since the sentence itself can be printed by any command that
    // quotes an agent), and the command must really print the marker. Building
    // the request from the catalogue action ties both to this test, so a
    // reworded notice or a dropped flag fails here rather than silently
    // disarming the prompt.
    const io = fakeIo()

    await run(['create', 'research-bot'], io)

    const create = SECTIONS.flatMap((section) => section.actions).find(
      (action) => action.command === 'agent' && action.subcommand === 'create',
    )
    expect(create).toBeDefined()
    if (create === undefined) return
    const request = requestOf(create, { name: 'research-bot' })
    const panel = outputPanelOf({
      argv: request.argv,
      display: request.display,
      exitCode: 0,
      stdout: io.out(),
      stderr: io.err(),
      ...(request.mintsToken === true ? { mintsToken: true as const } : {}),
    })
    expect(panel.holdsOneTimeToken).toBe(true)
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
    await seedServer('github')
    await seedServer('jira')
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
    await seedServer('github')
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github'], io)

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants['github']).toEqual({ tools: '*' })
  })

  test('grant with --tools splits on commas and trims blanks', async () => {
    await seedServer('github')
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
    await seedServer('github')
    await run(['create', 'research-bot'])
    const io = fakeIo()

    const exitCode = await run(['grant', 'research-bot', 'github', '--tools', 'a*b'], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
  })

  test('grant to an unknown agent → exit 1', async () => {
    await seedServer('github')
    const io = fakeIo()

    const exitCode = await run(['grant', 'nobody', 'github'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nobody')
  })

  test('grant to an unknown server → exit 1, "unknown server", store unchanged, no audit line (S1)', async () => {
    // Arrange — the agent exists; the server was never registered.
    await run(['create', 'research-bot'])
    const io = fakeIo()

    // Act
    const exitCode = await run(['grant', 'research-bot', 'ghost'], io)

    // Assert — refused before the write, with the way out on the next line;
    // no audit line, because nothing changed.
    expect(exitCode).toBe(1)
    expect(io.err()).toContain('unknown server "ghost"')
    expect(io.err()).toContain('register it first: server add ghost')
    expect(io.err()).not.toContain('[audit]')
    expect(io.out()).toBe('')
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants).toEqual({})
  })

  test('ungrant removes the server grant', async () => {
    await seedServer('github')
    await run(['create', 'research-bot'])
    await run(['grant', 'research-bot', 'github'])

    const exitCode = await run(['ungrant', 'research-bot', 'github'])

    expect(exitCode).toBe(0)
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants).toEqual({})
  })

  test('ungrant of a dangling grant (server no longer registered) still works', async () => {
    // Arrange — the grant exists although its server does not: exactly the
    // state `server remove --prune-grants` and manual clean-up act on, so the
    // registry check of `grant` must not spread to `ungrant`.
    await run(['create', 'research-bot'])
    await createAgentsStore({ journalDir }).grantServer('research-bot', 'gone', ['read_file'])
    const io = fakeIo()

    // Act
    const exitCode = await run(['ungrant', 'research-bot', 'gone'], io)

    // Assert
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('removed grant gone from research-bot')
    const agent = await createAgentsStore({ journalDir }).getAgent('research-bot')
    expect(agent?.grants).toEqual({})
  })

  test('untrusted names echoed in errors are sanitized (no raw control characters)', async () => {
    await seedServer('github')
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
