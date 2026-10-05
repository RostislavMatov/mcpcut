import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { FILES_PG_URL_SECRET } from '../../../src/files/db/constants.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { createSearchBackend, type SearchBackend } from '../../../src/files/search/search-backend.js'
import { createVaultStore } from '../../../src/vault/store.js'
import { createFakeEmbedder } from './fake-embedder.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describePg, PG_URL, withTestSchema } from '../db/pg-helpers.js'

/** The lazy, per-process search backend: failures become one line and are retried; an agent's call creates nothing. */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function emptyJournalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpcut-search-backend-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('without Postgres set up the problem names the command that sets it up', async () => {
  const backend = createSearchBackend({ journalDir: await emptyJournalDir(), cli: 'mcpcut' })

  expect(await backend.open()).toEqual({ kind: 'unavailable', problem: 'Postgres is not set up: an administrator runs `mcpcut files db init`' })
})

test('a vault URL that is not a Postgres URL is a one-line problem, and the next call tries again', async () => {
  const journalDir = await emptyJournalDir()
  await createVaultStore({ journalDir }).init()
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, 'not a url')
  const backend = createSearchBackend({ journalDir, cli: 'mcpcut' })

  const first = await backend.open()
  const second = await backend.open()

  expect(first.kind).toBe('unavailable')
  expect(second).toEqual(first)
})

describePg('the search backend on Postgres', () => {
  let fx: SearchFixture
  const backends: SearchBackend[] = []
  beforeEach(async () => {
    fx = await createSearchFixture()
  })
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()))
    await fx.cleanup()
  })

  const backendOver = (extra: Partial<Parameters<typeof createSearchBackend>[0]> = {}): SearchBackend => {
    const backend = createSearchBackend({
      journalDir: fx.journalDir,
      cli: 'mcpcut',
      schema: fx.schema,
      loadPg: () => loadPg(process.cwd()),
      createEmbedder: async () => fx.embedder,
      ...extra,
    })
    backends.push(backend)
    return backend
  }

  test('a model that fails to load is a problem now and is loaded on the next call', async () => {
    let attempts = 0
    const backend = backendOver({
      createEmbedder: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('the search model is incomplete (tokenizer.json): run `mcpcut files setup --search`')
        return fx.embedder
      },
    })

    const first = await backend.open()
    const second = await backend.open()

    expect(first).toEqual({ kind: 'unavailable', problem: 'the search model is incomplete (tokenizer.json): run `mcpcut files setup --search`' })
    expect(second.kind).toBe('ready')
    expect(attempts).toBe(2)
  })

  test('the embedder is made once and closed together with the backend', async () => {
    let made = 0
    const embedder = createFakeEmbedder()
    const backend = backendOver({ createEmbedder: async () => (made += 1, embedder) })

    await backend.open()
    await backend.open()
    await backend.close()

    expect(made).toBe(1)
    expect(embedder.isClosed()).toBe(true)
    expect((await backend.open()).kind).toBe('unavailable')
  })

  test('with no search tables yet it answers empty and creates nothing', async () => {
    const schema = withTestSchema()
    cleanups.push(schema.cleanup)
    const core: FilesDb = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schema.schema })
    cleanups.push(() => core.close())
    let embedders = 0
    const backend = backendOver({ schema: schema.schema, createEmbedder: async () => (embedders += 1, fx.embedder) })

    const opened = await backend.open()

    expect(opened).toEqual({ kind: 'empty' })
    expect(embedders).toBe(0)
    const tables = await core.query<{ found: string | null }>("SELECT to_regclass('search_files')::text AS found")
    expect(tables.rows[0]?.found).toBeNull()
  })
})
