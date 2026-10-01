import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runAdoptCommand, type AdoptCommandOptions } from '../../src/cli/adopt-cmd.js'
import { cliCommand } from '../../src/cli/next-step.js'

/** `mcpcut adopt` as a user runs it: what it says, what it writes, and the next step it ends on. */

let root: string
let home: string
let cwd: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpcut-adopt-cmd-'))
  home = join(root, 'home')
  cwd = join(home, 'app')
  dataDir = join(root, 'data')
  await mkdir(cwd, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeIo(): { stdout: { write: (c: string) => void }; stderr: { write: (c: string) => void }; out: () => string; err: () => string } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: { write: (c) => out.push(c) }, stderr: { write: (c) => err.push(c) }, out: () => out.join(''), err: () => err.join('') }
}

function run(args: string[], io = fakeIo(), platform: NodeJS.Platform = 'linux'): Promise<number> {
  const opts: AdoptCommandOptions = { journalDir: dataDir, place: { home, cwd, platform }, version: '9.9.9', now: () => new Date('2026-10-02T10:11:12.345Z') }
  return runAdoptCommand(args, io, opts)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

const CLAUDE_JSON = (): string => join(home, '.claude.json')
const FS = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/w'] }

describe('adopt (dry run)', () => {
  test('shows each server and what happens to it, writes nothing, ends with the command that writes it', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS, remote: { url: 'https://x' } } })
    const before = await readFile(CLAUDE_JSON(), 'utf8')
    const io = fakeIo()

    const code = await run([], io)

    expect(code).toBe(0)
    expect(io.out()).toContain('1 server to put behind mcpcut. Nothing is written yet.')
    expect(io.out()).toContain('Each command becomes: npx -y mcpcut@9.9.9 wrap --server <name> -- <its command>')
    expect(io.out()).toContain('Claude Code (user) ~/.claude.json')
    expect(io.out()).toMatch(/fs\s+wrap\s+npx -y @modelcontextprotocol\/server-filesystem \/w/)
    expect(io.out()).toMatch(/remote\s+skip\s+remote server/)
    expect(io.err()).toBe(`Write it: ${cliCommand()} adopt --apply\n`)
    expect(await readFile(CLAUDE_JSON(), 'utf8')).toBe(before)
  })

  test('a key in an argument is redacted in the table', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { gh: { command: 'gh-server', args: ['--token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] } } })
    const io = fakeIo()

    await run([], io)

    expect(io.out()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  test('on Windows the launcher shown is cmd /c npx', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    const io = fakeIo()

    await run([], io, 'win32')

    expect(io.out()).toContain('Each command becomes: cmd /c npx -y mcpcut@9.9.9 wrap')
  })

  test('no servers anywhere: says where it looked and how to add one behind mcpcut', async () => {
    const io = fakeIo()

    const code = await run([], io)

    expect(code).toBe(0)
    expect(io.out()).toContain('No MCP servers found in Claude Code, Cursor or Claude Desktop.')
    expect(io.out()).toContain('~/.claude.json')
    expect(io.err()).toContain(`claude mcp add fs -- ${cliCommand()} wrap --server fs -- npx -y @modelcontextprotocol/server-filesystem`)
  })

  test('everything already wrapped: nothing to change, look at the sessions', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: { command: 'npx', args: ['-y', 'mcpcut@0.2.4', 'wrap', '--', 'x'] } } })
    const io = fakeIo()

    expect(await run(['--apply'], io)).toBe(0)

    expect(io.out()).toContain('Nothing to change: 1 server already starts through mcpcut.')
    expect(io.err()).toBe(`See what they did: ${cliCommand()} sessions\n`)
  })
})

describe('adopt --apply', () => {
  test('writes the change, says where the copies are, and ends with restart, sessions and undo', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    const io = fakeIo()

    const code = await run(['--apply'], io)

    expect(code).toBe(0)
    expect(io.out()).toContain('1 server now starts through mcpcut:\n  ~/.claude.json: fs\n')
    expect(io.out()).toContain(`Copies of the files as they were: ${join(dataDir, 'adopt', '2026-10-02T10-11-12.345Z')}`)
    expect(io.err()).toContain(`Next: restart Claude Code to load the change, let the agent work, then: ${cliCommand()} sessions\n`)
    expect(io.err()).toContain(`Undo: ${cliCommand()} adopt --undo\n`)
    expect(await readFile(CLAUDE_JSON(), 'utf8')).toContain('"mcpcut@9.9.9"')
  })

  test('--client limits the change to one client', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { fs: FS } })

    await run(['--apply', '--client', 'cursor'])

    expect(await readFile(CLAUDE_JSON(), 'utf8')).not.toContain('mcpcut@')
    expect(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).toContain('mcpcut@9.9.9')
  })
})

describe('adopt --undo', () => {
  test('puts the servers back and says to restart', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    const original = await readFile(CLAUDE_JSON(), 'utf8')
    await run(['--apply'])
    const io = fakeIo()

    const code = await run(['--undo'], io)

    expect(code).toBe(0)
    expect(io.out()).toBe('Restored:\n  ~/.claude.json: fs\n')
    expect(io.err()).toBe('Next: restart the client so it starts these servers directly again.\n')
    expect(await readFile(CLAUDE_JSON(), 'utf8')).toBe(original)
  })

  test('nothing to undo still names the next step', async () => {
    const io = fakeIo()

    expect(await run(['--undo'], io)).toBe(0)

    expect(io.err()).toBe(`Put servers behind mcpcut: ${cliCommand()} adopt\n`)
  })
})

describe('adopt: refusals', () => {
  test.each([
    [['--bogus'], /Unknown option/],
    [['--client', 'vscode'], /Unknown client "vscode"; one of: claude-code, cursor, claude-desktop/],
    [['--undo', '--apply'], /--undo takes no other option/],
    [['extra'], /positional/i],
  ])('%j: one line why, then the usage, exit 1', async (args, reason) => {
    const io = fakeIo()

    expect(await run(args, io)).toBe(1)

    expect(io.err()).toMatch(reason)
    expect(io.err()).toContain(`${cliCommand()} adopt [--apply]`)
  })
})
