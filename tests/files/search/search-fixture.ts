import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { walkRoots } from '../../../src/files/db/catalog-walk.js'
import { FILES_PG_URL_SECRET } from '../../../src/files/db/constants.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { ensureSearchSchema, type SearchDb } from '../../../src/files/search/search-schema.js'
import { createVaultStore } from '../../../src/vault/store.js'
import { createFakeEmbedder, type FakeEmbedder } from './fake-embedder.js'
import { NOW, ruleOn } from './index-fixture.js'
import { PG_URL, withTestSchema } from '../db/pg-helpers.js'

/**
 * Two or more roots on a real Postgres schema with the search tables, indexed by the fake embedder:
 * what the `search_files` tests share. The vault of `journalDir` holds the test URL, so the code under
 * test reaches the same schema through its production path (`openConfiguredDb`).
 */

export interface SearchFixture {
  readonly base: string
  readonly journalDir: string
  readonly schema: string
  readonly sdb: SearchDb
  readonly db: FilesDb
  readonly embedder: FakeEmbedder
  /** Absolute path of a folder under the base; created on first `put`. */
  readonly dir: (name: string) => string
  readonly put: (files: Readonly<Record<string, string>>) => Promise<void>
  /** Walks the roots into the catalog, then indexes everything under them. */
  readonly index: (roots: readonly string[]) => Promise<void>
  readonly cleanup: () => Promise<void>
}

export async function createSearchFixture(): Promise<SearchFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-search-')))
  const journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  await createVaultStore({ journalDir }).init()
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
  const schema = withTestSchema()
  const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schema.schema })
  const sdb = await ensureSearchSchema(db)
  const embedder = createFakeEmbedder()
  return {
    base,
    journalDir,
    schema: schema.schema,
    sdb,
    db,
    embedder,
    dir: (name) => join(base, name),
    put: async (files) => {
      for (const [path, text] of Object.entries(files)) {
        const file = join(base, ...path.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
      }
    },
    index: async (roots) => {
      await walkRoots(db, { roots: [...roots], now: new Date() })
      await indexOnce(sdb, {
        roots,
        rules: roots.map((root) => ruleOn(root)),
        embedder,
        now: NOW,
        budgetMs: Number.POSITIVE_INFINITY,
        platform: process.platform,
      })
    },
    cleanup: async () => {
      await db.close().catch(() => undefined)
      await schema.cleanup()
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}
