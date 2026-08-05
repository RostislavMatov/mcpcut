import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  runServerAdd,
  runServerList,
  runServerRemove,
  runServerShow,
} from '../../src/cli/server-cmd.js'
import { REGISTRY_FILE_NAME } from '../../src/registry/constants.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-server-cmd-'))
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

const opts = () => ({ journalDir })

const ADD_GITHUB = [
  'github',
  '--transport', 'stdio',
  '--command', 'npx',
  '--args', '-y,@modelcontextprotocol/server-github',
  '--env', 'GITHUB_PERSONAL_ACCESS_TOKEN=vault:github-pat',
]

describe('server add', () => {
  test('adds a stdio server with args and env; record lands in registry.json', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github')
    const file = JSON.parse(await readFile(join(journalDir, REGISTRY_FILE_NAME), 'utf8'))
    expect(file.servers.github).toEqual({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'vault:github-pat' },
    })
  })

  test('adds an http server with a vault-referenced header; protocol defaults to auto', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp', '--header', 'Authorization=vault:api-key'],
      io,
      opts(),
    )

    expect(exitCode).toBe(0)
    const file = JSON.parse(await readFile(join(journalDir, REGISTRY_FILE_NAME), 'utf8'))
    expect(file.servers['remote-api']).toEqual({
      name: 'remote-api',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'vault:api-key' },
      protocol: 'auto',
    })
  })

  test('rejects a secret literal in --env with the vault hint, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', `GITHUB_TOKEN=ghp_${'a'.repeat(36)}`],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('vault set')
  })

  test('validation errors are printed one per line as path: message', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['GitHub!', '--transport', 'stdio', '--command', 'npx'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    const lines = io.err().trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => /^\S+: /.test(line))).toBe(true)
  })

  test('duplicate name exits 1 with an "already exists" error', async () => {
    const io = fakeIo()
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())

    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('already exists')
  })

  test('missing --transport exits 1 with a helpful message', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['github', '--command', 'npx'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--transport')
  })

  test('missing name positional prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['--transport', 'stdio', '--command', 'npx'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('malformed --env (no "=") exits 1 naming the bad flag value', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', 'NOEQUALS'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('NOEQUALS')
  })

  test('duplicate --env key exits 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', 'A=1', '--env', 'A=2'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('A')
  })

  test('--env __proto__=x is rejected', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', '__proto__=x'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
  })

  test('mixing --url into a stdio record is a validation error', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--url', 'https://example.com'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('url')
  })

  test('unknown flag prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['github', '--bogus'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server list', () => {
  test('empty registry prints a friendly message, exit 0', async () => {
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no servers')
  })

  test('lists name, transport and command/url', async () => {
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())
    await runServerAdd(['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts())

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('github')
    expect(out).toContain('stdio')
    expect(out).toContain('npx')
    expect(out).toContain('remote-api')
    expect(out).toContain('http')
    expect(out).toContain('https://example.com/mcp')
  })

  test('a very long url is shortened in the table', async () => {
    const longPath = 'a'.repeat(200)
    await runServerAdd(['long', '--transport', 'http', '--url', `https://example.com/${longPath}`], fakeIo(), opts())
    const io = fakeIo()

    await runServerList([], io, opts())

    expect(io.out()).not.toContain(longPath)
    expect(io.out()).toContain('…')
  })

  test('unknown flag prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerList(['--bogus'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server show', () => {
  test('prints the full record; vault references and env literals are shown as-is', async () => {
    await runServerAdd([...ADD_GITHUB, '--env', 'LOG_LEVEL=debug'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerShow(['github'], io, opts())

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('name: github')
    expect(out).toContain('transport: stdio')
    expect(out).toContain('command: npx')
    expect(out).toContain('GITHUB_PERSONAL_ACCESS_TOKEN: vault:github-pat')
    expect(out).toContain('LOG_LEVEL: debug')
  })

  test('prints http fields including the defaulted protocol', async () => {
    await runServerAdd(['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerShow(['remote-api'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('url: https://example.com/mcp')
    expect(io.out()).toContain('protocol: auto')
  })

  test('unknown server exits 1 and echoes the name safely', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow(['nope'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nope')
  })

  test('control characters in the requested name are neutralized in the error output', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow(['evil\x1b[2Jserver'], io, opts())

    expect(exitCode).toBe(1)
    const withoutLineBreaks = io.err().replace(/\n/g, '')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(withoutLineBreaks)).toBe(false)
  })

  test('missing name prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow([], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server remove', () => {
  test('removes an existing server, exit 0; it is gone afterwards', async () => {
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github')
    expect(await runServerShow(['github'], fakeIo(), opts())).toBe(1)
  })

  test('removing an unknown server exits 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerRemove(['nope'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nope')
  })

  test('missing name prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerRemove([], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('corrupt registry.json surfaces a loud error instead of pretending success', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(journalDir, REGISTRY_FILE_NAME), '{ not json', 'utf8')
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('corrupt')
  })
})
