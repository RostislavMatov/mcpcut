import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import type { FilesDb } from '../../src/files/db/connection.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import { createIndexRulesStore } from '../../src/files/search/index-rules-store.js'
import { createVaultStore } from '../../src/vault/store.js'
import { createFakeEmbedder, type FakeEmbedder } from '../files/search/fake-embedder.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** `files db sync` with an index rule: the summary, the progress lines, the problem line. */

let base: string
let journalDir: string
let folder: string
const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-db-sync-index-')))
  journalDir = join(base, 'state')
  folder = join(base, 'data')
  await mkdir(journalDir, { recursive: true })
  await mkdir(folder, { recursive: true })
})
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(base, { recursive: true, force: true })
})

async function sync(schema: string, indexEmbedder: () => Promise<FakeEmbedder>) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', 'db', 'sync'], io, {
    files: { journalDir, env: {}, db: { loadPg: () => loadPg(process.cwd()), schema, onOpen: (db) => opened.push(db), indexEmbedder } },
  })
  return { code, out: out.join(''), err: err.join('') }
}

async function setUp(): Promise<string> {
  await createVaultStore({ journalDir }).init()
  const owner = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
  const sink = { write: () => true }
  await dispatch(['files', 'root', 'add', folder], { stdout: sink, stderr: sink }, { files: { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: owner.token } } })
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
  await createIndexRulesStore({ journalDir }).set(folder, true)
  const { schema, cleanup } = withTestSchema()
  cleanups.push(cleanup)
  return schema
}

describePg('files db sync with an index rule', () => {
  test('prints the summary with skip reasons and ends with the index list step', async () => {
    const schema = await setUp()
    await writeFile(join(folder, 'a.md'), 'alpha')
    await writeFile(join(folder, 'b.md'), 'beta')
    await writeFile(join(folder, '.env'), 'TOKEN=1')

    const result = await sync(schema, async () => createFakeEmbedder())

    expect(result.code).toBe(0)
    expect(result.out).toContain('search index: 2 files indexed, 1 skipped (1 secret-like name), 0 pending, 0 failed\n')
    expect(result.err).toBe('Next: mcpcut files index list\n')
  })

  test('prints a progress line every 50 files', async () => {
    const schema = await setUp()
    for (let index = 0; index < 120; index += 1) await writeFile(join(folder, `f${String(index).padStart(3, '0')}.md`), `word${index}`)

    const result = await sync(schema, async () => createFakeEmbedder())

    expect(result.out).toContain('indexing: 50 of 120 files\n')
    expect(result.out).toContain('indexing: 100 of 120 files\n')
    expect(result.out).not.toContain('indexing: 120 of 120')
    expect(result.out).toContain('120 files indexed')
  })

  test('a missing runtime is one line with its step, exit 1, and the catalog part still ran', async () => {
    const schema = await setUp()
    await writeFile(join(folder, 'a.md'), 'alpha')
    const missing = 'search by meaning is not installed: run `mcpcut files setup --search`'

    const result = await sync(schema, () => Promise.reject(new Error(missing)))

    expect(result.code).toBe(1)
    expect(result.out).toContain(`${folder}  1 file, 0 folders  +1 ~0 -0`)
    expect(result.err).toBe(`search index: not updated: ${missing}\nFix that, then run it again: mcpcut files db sync\n`)
  })

  test('the embedder is closed after the sync', async () => {
    const schema = await setUp()
    await writeFile(join(folder, 'a.md'), 'alpha')
    const fake = createFakeEmbedder()

    await sync(schema, async () => fake)

    expect(fake.isClosed()).toBe(true)
  })
})
