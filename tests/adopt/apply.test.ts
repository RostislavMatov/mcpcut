import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyAdopt, scanConfigs, type AdoptOptions } from '../../src/adopt/apply.js'

/**
 * `mcpcut adopt` against real files in a temporary home: what it finds,
 * what it writes, and what it refuses to touch. No fs mocks.
 */

let root: string
let home: string
let cwd: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpcut-adopt-'))
  home = join(root, 'home')
  cwd = join(home, 'app')
  dataDir = join(root, 'data')
  await mkdir(cwd, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function options(extra: Partial<AdoptOptions> = {}): AdoptOptions {
  return {
    place: { home, cwd, platform: 'linux' },
    dataDir,
    version: '9.9.9',
    now: () => new Date('2026-10-02T10:11:12.345Z'),
    ...extra,
  }
}

async function writeJson(file: string, value: unknown, indent: string | number = 2): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, indent)}\n`)
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

const FS_SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/w'], env: { API_KEY: 'sk-secret-value-123456' } }
const WRAPPED_FS_ARGS = ['-y', 'mcpcut@9.9.9', 'wrap', '--server', 'fs', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/w']

describe('scanConfigs', () => {
  test('finds servers in every client and scope, and names the files it looked at', async () => {
    await writeJson(join(home, '.claude.json'), { numStartups: 3, mcpServers: { fs: FS_SERVER }, projects: { [cwd]: { mcpServers: { local: { command: 'node', args: ['s.js'] } } } } })
    await writeJson(join(cwd, '.mcp.json'), { mcpServers: { shared: { command: 'uvx', args: ['mcp-server-git'] } } })
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } })
    await writeJson(join(home, '.config', 'Claude', 'claude_desktop_config.json'), { mcpServers: { done: { command: 'npx', args: ['-y', 'mcpcut@0.2.4', 'wrap', '--', 'x'] } } })

    const scan = await scanConfigs(options())

    const found = scan.locations.flatMap((l) => l.rows.map((row) => `${l.location.client}/${l.location.scope}/${row.name}/${row.verdict.kind}`))
    expect(found).toEqual([
      'claude-code/user/fs/wrap',
      'claude-code/local, this folder/local/wrap',
      'claude-code/project, shared through .mcp.json/shared/wrap',
      'cursor/global/linear/remote',
      'claude-desktop/app/done/already',
    ])
    expect(scan.looked).toContain(join(home, '.claude.json'))
    expect(scan.looked).toContain(join(cwd, '.cursor', 'mcp.json'))
    expect(scan.problems).toEqual([])
  })

  test('a file that is not JSON is a problem to report, not a crash', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true })
    await writeFile(join(home, '.cursor', 'mcp.json'), '{ "mcpServers": { // a comment\n } }')

    const scan = await scanConfigs(options())

    expect(scan.problems).toEqual([{ file: join(home, '.cursor', 'mcp.json'), reason: expect.stringMatching(/not valid JSON/) }])
  })

  test('--client keeps only that client', async () => {
    await writeJson(join(home, '.claude.json'), { mcpServers: { fs: FS_SERVER } })
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { other: { command: 'node' } } })

    const scan = await scanConfigs(options({ clients: ['cursor'] }))

    expect(scan.locations.map((l) => l.location.client)).toEqual(['cursor'])
  })
})

describe('applyAdopt', () => {
  test('wraps the servers, keeps every other key, the indent and the trailing newline', async () => {
    const file = join(home, '.claude.json')
    await writeJson(file, { numStartups: 3, mcpServers: { fs: FS_SERVER, remote: { type: 'http', url: 'https://x' } }, tipsHistory: { a: 1 } }, '\t')

    const result = await applyAdopt(await scanConfigs(options()), options())

    expect(result.failures).toEqual([])
    expect(result.written).toEqual([{ file, servers: ['fs'] }])
    const text = await readFile(file, 'utf8')
    expect(text).toMatch(/^\{\n\t"numStartups": 3,/)
    expect(text.endsWith('}\n')).toBe(true)
    const doc = await readJson(file)
    expect(doc['mcpServers']).toEqual({
      fs: { command: 'npx', args: WRAPPED_FS_ARGS, env: FS_SERVER.env },
      remote: { type: 'http', url: 'https://x' },
    })
    expect(doc['tipsHistory']).toEqual({ a: 1 })
  })

  test('keeps the file mode, and a copy of the file as it was goes to the data dir, owner-only', async () => {
    const file = join(home, '.claude.json')
    await writeJson(file, { mcpServers: { fs: FS_SERVER } })
    await chmod(file, 0o600)
    const original = await readFile(file, 'utf8')

    const result = await applyAdopt(await scanConfigs(options()), options())

    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(result.backupDir).toBe(join(dataDir, 'adopt', '2026-10-02T10-11-12.345Z'))
    const copies = await readdir(result.backupDir ?? '')
    const copy = copies.find((name) => name !== 'manifest.json') ?? ''
    expect(await readFile(join(result.backupDir ?? '', copy), 'utf8')).toBe(original)
    expect((await stat(join(result.backupDir ?? '', copy))).mode & 0o777).toBe(0o600)
  })

  test('the manifest records command lines only — never env, where the secrets are', async () => {
    await writeJson(join(home, '.claude.json'), { mcpServers: { fs: FS_SERVER } })

    const result = await applyAdopt(await scanConfigs(options()), options())

    const manifestText = await readFile(join(result.backupDir ?? '', 'manifest.json'), 'utf8')
    expect(manifestText).not.toContain('sk-secret-value')
    expect(JSON.parse(manifestText)).toMatchObject({
      changes: [{ name: 'fs', path: ['mcpServers'], before: { command: 'npx', args: FS_SERVER.args }, after: { command: 'npx', args: WRAPPED_FS_ARGS } }],
    })
  })

  test('two scopes in one file are written in one go', async () => {
    const file = join(home, '.claude.json')
    await writeJson(file, { mcpServers: { fs: FS_SERVER }, projects: { [cwd]: { mcpServers: { local: { command: 'node' } } } } })

    const result = await applyAdopt(await scanConfigs(options()), options())

    expect(result.written).toEqual([{ file, servers: ['fs', 'local'] }])
    const doc = await readJson(file)
    expect(JSON.stringify(doc)).toContain('"--server","local"')
    expect(JSON.stringify(doc)).toContain('"--server","fs"')
  })

  test('a symlinked config is written through the link; the link stays a link', async () => {
    const real = join(root, 'dotfiles', 'mcp.json')
    await writeJson(real, { mcpServers: { fs: FS_SERVER } })
    await mkdir(join(home, '.cursor'), { recursive: true })
    await symlink(real, join(home, '.cursor', 'mcp.json'))

    await applyAdopt(await scanConfigs(options()), options())

    expect((await lstat(join(home, '.cursor', 'mcp.json'))).isSymbolicLink()).toBe(true)
    expect(JSON.stringify(await readJson(real))).toContain('mcpcut@9.9.9')
  })

  test('a file changed after the scan is left alone and reported', async () => {
    const file = join(home, '.claude.json')
    await writeJson(file, { mcpServers: { fs: FS_SERVER } })
    const scan = await scanConfigs(options())
    await writeJson(file, { mcpServers: { fs: FS_SERVER }, changedBy: 'the client' })

    const result = await applyAdopt(scan, options())

    expect(result.written).toEqual([])
    expect(result.failures).toEqual([{ file, reason: expect.stringMatching(/changed/) }])
    expect(await readJson(file)).toEqual({ mcpServers: { fs: FS_SERVER }, changedBy: 'the client' })
  })

  test('nothing to wrap writes nothing — no copies, no manifest', async () => {
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { linear: { url: 'https://x' } } })

    const result = await applyAdopt(await scanConfigs(options()), options())

    expect(result).toEqual({ written: [], failures: [] })
    await expect(stat(join(dataDir, 'adopt'))).rejects.toThrow()
  })
})
