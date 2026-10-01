import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyAdopt, scanConfigs, type AdoptOptions } from '../../src/adopt/apply.js'
import { undoAdopt } from '../../src/adopt/undo.js'

/** `mcpcut adopt --undo`: put back what the last `--apply` changed, and only that. */

let root: string
let home: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpcut-adopt-undo-'))
  home = join(root, 'home')
  dataDir = join(root, 'data')
  await mkdir(join(home, 'app'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

let tick = 0

function options(): AdoptOptions {
  tick += 1
  return { place: { home, cwd: join(home, 'app'), platform: 'linux' }, dataDir, version: '9.9.9', now: () => new Date(Date.UTC(2026, 9, 2, 10, 0, tick)) }
}

const CLAUDE_JSON = (): string => join(home, '.claude.json')

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(file: string): Promise<{ mcpServers: Record<string, Record<string, unknown>> } & Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
}

async function adopt(): Promise<void> {
  const opts = options()
  await applyAdopt(await scanConfigs(opts), opts)
}

const FS = { command: 'npx', args: ['-y', 'fs-server'], env: { KEY: 'v' } }
const BARE = { command: '/usr/bin/memory-server' }

describe('undoAdopt', () => {
  test('puts every wrapped entry back as it was, and says which', async () => {
    const original = { numStartups: 1, mcpServers: { fs: FS, mem: BARE } }
    await writeJson(CLAUDE_JSON(), original)
    await adopt()

    const result = await undoAdopt({ dataDir })

    expect(result).toMatchObject({ kind: 'done', restored: [{ file: CLAUDE_JSON(), servers: ['fs', 'mem'] }], kept: [], failures: [] })
    expect(await readJson(CLAUDE_JSON())).toEqual(original)
  })

  test('keeps what the user changed since: a new env key stays, an entry edited by hand is left alone', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS, mem: BARE } })
    await adopt()
    const adopted = await readJson(CLAUDE_JSON())
    await writeJson(CLAUDE_JSON(), {
      ...adopted,
      mcpServers: {
        fs: { ...adopted.mcpServers['fs'], env: { KEY: 'v', NEW: 'w' } },
        mem: { command: 'something-else' },
        added: { command: 'node' },
      },
    })

    const result = await undoAdopt({ dataDir })

    expect(result).toMatchObject({ kind: 'done', restored: [{ servers: ['fs'] }], kept: [{ file: CLAUDE_JSON(), name: 'mem' }] })
    expect((await readJson(CLAUDE_JSON())).mcpServers).toEqual({
      fs: { command: 'npx', args: ['-y', 'fs-server'], env: { KEY: 'v', NEW: 'w' } },
      mem: { command: 'something-else' },
      added: { command: 'node' },
    })
  })

  test('a removed entry or a removed file is kept as the user left it', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    await writeJson(join(home, '.cursor', 'mcp.json'), { mcpServers: { other: BARE } })
    await adopt()
    await writeJson(CLAUDE_JSON(), { mcpServers: {} })
    await rm(join(home, '.cursor', 'mcp.json'))

    const result = await undoAdopt({ dataDir })

    expect(result).toMatchObject({ kind: 'done', restored: [], kept: [{ name: 'fs' }, { name: 'other' }], failures: [] })
  })

  test('undo is a stack: the second undo reaches the run before', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    await adopt()
    const afterFirst = await readJson(CLAUDE_JSON())
    await writeJson(CLAUDE_JSON(), { mcpServers: { ...afterFirst.mcpServers, mem: BARE } })
    await adopt()

    await undoAdopt({ dataDir })
    expect(Object.keys((await readJson(CLAUDE_JSON())).mcpServers)).toEqual(['fs', 'mem'])
    expect((await readJson(CLAUDE_JSON())).mcpServers['mem']).toEqual(BARE)
    expect(JSON.stringify((await readJson(CLAUDE_JSON())).mcpServers['fs'])).toContain('mcpcut@9.9.9')

    await undoAdopt({ dataDir })
    expect((await readJson(CLAUDE_JSON())).mcpServers['fs']).toEqual(FS)

    expect(await undoAdopt({ dataDir })).toEqual({ kind: 'nothing' })
  })

  test('nothing adopted yet: nothing to undo', async () => {
    expect(await undoAdopt({ dataDir })).toEqual({ kind: 'nothing' })
  })

  test('a manifest that is not one adopt wrote is reported, and no config is touched', async () => {
    await writeJson(CLAUDE_JSON(), { mcpServers: { fs: FS } })
    await adopt()
    const adopted = await readFile(CLAUDE_JSON(), 'utf8')
    const runDir = join(dataDir, 'adopt', '2099-01-01T00-00-00.000Z')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'manifest.json'), '{"version":1,"changes":[{"file":1}]}')

    const result = await undoAdopt({ dataDir })

    expect(result).toEqual({ kind: 'problem', dir: runDir, reason: expect.stringMatching(/not one adopt wrote/) })
    expect(await readFile(CLAUDE_JSON(), 'utf8')).toBe(adopted)
  })
})
