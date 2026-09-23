import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ClientConfigDocument, HttpClientEntry, StdioClientEntry } from '../../src/agents/client-config.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { runAgentCommand } from '../../src/cli/agent-cmd.js'
import { CLIENT_CONFIG_HEADING, CLIENT_CONFIG_PLACEHOLDER_NOTE } from '../../src/cli/agent-config-cmd.js'
import { INSTALL_CONFIG_VERSION, SERVE_PORT_ENV_VAR } from '../../src/setup/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'

/**
 * `agent config <name> [--http]` (ADR-0015, phase 4, C3): the client config
 * block again, with `<token>` where the token was. No admin token is needed —
 * the block without the token is a public shape, not a secret — so every run
 * below carries an EMPTY environment.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agent-config-'))
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

function configOf(
  args: string[],
  io = fakeIo(),
  { install = NO_INSTALL, env = {} }: { install?: InstallConfigLoad; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return runAgentCommand(['config', ...args], io, { journalDir, env, install })
}

function blockOf(out: string): ClientConfigDocument {
  const lines = out.split('\n')
  const start = lines.indexOf('{')
  return JSON.parse(lines.slice(start, lines.indexOf('}', start) + 1).join('\n')) as ClientConfigDocument
}

async function seedAgent(name: string): Promise<void> {
  await createAgentsStore({ journalDir }).createAgent(name)
}

describe('agent config: the block with <token>', () => {
  test('needs no admin token and prints the stdio form with the placeholder (C3)', async () => {
    await seedAgent('research-bot')
    const io = fakeIo()

    const code = await configOf(['research-bot'], io)

    expect(code).toBe(0)
    const entry = blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry
    expect(entry.env).toEqual({ MCP_AGENT_TOKEN: '<token>' })
    expect(io.out()).toContain(`${CLIENT_CONFIG_PLACEHOLDER_NOTE}\n`)
    expect(io.out()).not.toContain(CLIENT_CONFIG_HEADING)
    expect(io.out()).not.toMatch(/mcpj_/)
    expect(io.err()).toBe('')
  })

  test('--http prints the native HTTP form: the pool path and a Bearer placeholder', async () => {
    await seedAgent('research-bot')
    const io = fakeIo()

    const code = await configOf(['research-bot', '--http'], io, { install: installWithPublicUrl('https://plane.example') })

    expect(code).toBe(0)
    expect(blockOf(io.out()).mcpServers.mcpcut as HttpClientEntry).toEqual({
      url: 'https://plane.example/mcp',
      headers: { Authorization: 'Bearer <token>' },
    })
    expect(io.out()).not.toContain('HTTP client instead?')
  })

  test('the remembered address becomes --url, with no derived-address note', async () => {
    await seedAgent('research-bot')
    const io = fakeIo()

    await configOf(['research-bot'], io, { install: installWithPublicUrl('https://plane.example:8443') })

    expect((blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry).args).toEqual([
      'connect',
      '--url',
      'https://plane.example:8443',
    ])
    expect(io.out()).not.toContain('note:')
  })

  test('an env serve port shapes the derived address', async () => {
    await seedAgent('research-bot')
    const io = fakeIo()

    await configOf(['research-bot'], io, { env: { [SERVE_PORT_ENV_VAR]: '9000' } })

    expect((blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry).args.at(-1)).toBe('http://127.0.0.1:9000')
    expect(io.out()).toContain('note: address derived from the serve bind')
  })

  test('an unusable MCPCUT_SERVE_PORT prints the <serve-url> placeholder and says why, exit 0', async () => {
    await seedAgent('research-bot')
    const io = fakeIo()

    const code = await configOf(['research-bot'], io, { env: { [SERVE_PORT_ENV_VAR]: '8O90' } })

    expect(code).toBe(0)
    expect((blockOf(io.out()).mcpServers.mcpcut as StdioClientEntry).args.at(-1)).toBe('<serve-url>')
    expect(io.out()).toContain('note: the serve address is not known')
  })

  test('an unknown agent is refused, exit 1, in the store\'s words', async () => {
    const io = fakeIo()

    const code = await configOf(['ghost'], io)

    expect(code).toBe(1)
    expect(io.err()).toBe('agent "ghost" does not exist\n')
    expect(io.out()).toBe('')
  })

  test('a revoked agent still gets its block, with a note on stderr', async () => {
    await seedAgent('old-bot')
    await createAgentsStore({ journalDir }).revokeAgent('old-bot')
    const io = fakeIo()

    const code = await configOf(['old-bot'], io)

    expect(code).toBe(0)
    expect(io.out()).toContain('"mcpServers"')
    expect(io.err()).toBe('note: agent "old-bot" is revoked — its token no longer opens a session\n')
  })

  test.each([[[]], [['a', 'b']], [['a', '--json']], [['--http']]])('argv %j prints usage, exit 1', async (args) => {
    await seedAgent('a')
    const io = fakeIo()

    const code = await configOf(args, io)

    expect(code).toBe(1)
    expect(io.err()).toContain('agent config <name> [--http]')
    expect(io.out()).toBe('')
  })
})
