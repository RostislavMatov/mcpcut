import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { FILES_SYNC_INTERVAL_MS, startFilesSync, type FilesSync, type FilesSyncTimer } from '../../src/cli/serve-files-sync.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import type { FilesDb } from '../../src/files/db/connection.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import { walkRoots } from '../../src/files/db/catalog-walk.js'
import type { IndexRule } from '../../src/files/search/index-rules-store.js'
import type { Embedder } from '../../src/files/search/types.js'
import { createVaultStore } from '../../src/vault/store.js'
import { createFakeEmbedder, FAKE_MODEL_ID } from '../files/search/fake-embedder.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** The index step of the `serve` sync: lazy embedder, one line per distinct problem, closed on stop. */

let base: string
let journalDir: string
let folder: string
let clock: number
const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []
const stops: FilesSync[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-serve-index-')))
  journalDir = join(base, 'state')
  folder = join(base, 'data')
  clock = Date.parse('2026-10-05T12:00:00.000Z')
  await mkdir(journalDir, { recursive: true })
  await mkdir(folder, { recursive: true })
})
afterEach(async () => {
  await Promise.all(stops.splice(0).map((sync) => sync.stop()))
  opened.splice(0)
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(base, { recursive: true, force: true })
})

function fakeTimer(): FilesSyncTimer & { tick: () => void } {
  let tick: () => void = () => undefined
  return {
    setInterval: (handler) => {
      tick = handler
      return { unref: () => undefined } as never
    },
    clearInterval: () => undefined,
    get tick() {
      return tick
    },
  } as never
}

interface Wiring {
  readonly rules: IndexRule[]
  readonly createEmbedder: () => Promise<Embedder>
}

async function startWith(schema: string, wiring: Wiring, listIndexRules: () => Promise<readonly IndexRule[]> = async () => wiring.rules) {
  await createVaultStore({ journalDir }).init()
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
  const lines: string[] = []
  const timer = fakeTimer()
  const sync = startFilesSync({
    journalDir,
    cli: 'mcpcut',
    listRoots: async () => [folder],
    stderr: { write: (chunk: string) => void lines.push(chunk) },
    now: () => clock,
    platform: process.platform,
    timer,
    loadPg: () => loadPg(process.cwd()),
    schema,
    onOpen: (db) => opened.push(db),
    listIndexRules,
    createEmbedder: wiring.createEmbedder,
    modelId: FAKE_MODEL_ID,
  })
  stops.push(sync)
  const tick = async () => {
    clock += FILES_SYNC_INTERVAL_MS
    timer.tick()
    await sync.idle()
  }
  return { sync, lines, tick }
}

const ruleFor = (path: string): IndexRule => ({ path, enabled: true, setAt: '2026-10-05T10:00:00.000Z' })

describePg('serve sync: the index step', () => {
  test('no rule on: the embedder is never created', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    let created = 0
    const { sync } = await startWith(schema, { rules: [], createEmbedder: async () => (created += 1, createFakeEmbedder()) })

    await sync.done

    expect(created).toBe(0)
  })

  test('with a rule the embedder is made only in a round with a file to embed and closed when that round ends', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await writeFile(join(folder, 'a.md'), 'alpha beta')
    const fake = createFakeEmbedder()
    let created = 0
    const wiring: Wiring = { rules: [ruleFor(folder)], createEmbedder: async () => (created += 1, fake) }
    const { sync, tick } = await startWith(schema, wiring)
    await sync.done
    await walkRoots(opened[0] as FilesDb, { roots: [folder], now: new Date(clock) })

    await tick()
    await tick()

    expect(created).toBe(1)
    const rows = await opened[0]?.query<{ n: string }>('SELECT count(*) AS n FROM search_files')
    expect(rows?.rows[0]?.n).toBe('1')
    expect(fake.isClosed()).toBe(true)
  })

  test('a missing runtime is one line, repeated rounds do not repeat it, installing it later adds none', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await writeFile(join(folder, 'a.md'), 'alpha beta')
    let isInstalled = false
    const missing = 'search by meaning is not installed: run `mcpcut files setup --search`'
    const wiring: Wiring = {
      rules: [ruleFor(folder)],
      createEmbedder: async () => (isInstalled ? createFakeEmbedder() : Promise.reject(new Error(missing))),
    }
    const { sync, lines, tick } = await startWith(schema, wiring)
    await sync.done
    await walkRoots(opened[0] as FilesDb, { roots: [folder], now: new Date(clock) })

    await tick()
    await tick()
    isInstalled = true
    await tick()

    expect(lines).toEqual([`[serve] files sync: search index: ${missing}\n`])
  })

  test('rules that cannot be read skip the index step, never clear the index, and are reported once', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await writeFile(join(folder, 'a.md'), 'alpha beta')
    let isReadable = true
    const wiring: Wiring = { rules: [ruleFor(folder)], createEmbedder: async () => createFakeEmbedder() }
    const { sync, lines, tick } = await startWith(schema, wiring, async () => {
      if (isReadable) return wiring.rules
      throw new Error('files-index.json is corrupt')
    })
    await sync.done
    await walkRoots(opened[0] as FilesDb, { roots: [folder], now: new Date(clock) })
    await tick()
    const count = async () => (await opened[0]?.query<{ n: string }>('SELECT count(*) AS n FROM search_files'))?.rows[0]?.n

    isReadable = false
    await tick()
    await tick()

    expect(await count()).toBe('1')
    expect(lines).toEqual(['[serve] files sync: could not read the index rules: files-index.json is corrupt\n'])
  })
})
