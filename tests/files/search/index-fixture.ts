import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { walkRoots } from '../../../src/files/db/catalog-walk.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import type { PgModule } from '../../../src/files/db/pg-types.js'
import type { IndexOptions } from '../../../src/files/search/indexer.js'
import type { IndexRule } from '../../../src/files/search/index-rules-store.js'
import { ensureSearchSchema, type SearchDb } from '../../../src/files/search/search-schema.js'
import type { Embedder } from '../../../src/files/search/types.js'
import { createFakeEmbedder, type FakeEmbedder } from './fake-embedder.js'
import { PG_URL, withTestSchema } from '../db/pg-helpers.js'

/** A real Postgres schema with the search tables, a temp root, a fake embedder: what the indexer tests share. */

export interface IndexFixture {
  readonly root: string
  readonly schema: string
  readonly sdb: SearchDb
  readonly db: FilesDb
  readonly embedder: FakeEmbedder
  /** Writes files (relative path → text) under the root, creating folders. */
  readonly put: (files: Readonly<Record<string, string | Buffer>>) => Promise<void>
  /** Re-reads the root into the catalog, as `files db sync` would. */
  readonly walk: () => Promise<void>
  /** Index options for this fixture; `rules` default to the whole root on. */
  readonly options: (extra?: Partial<IndexOptions>) => IndexOptions
  readonly cleanup: () => Promise<void>
}

export const NOW = new Date('2026-10-05T12:00:00.000Z')

export function ruleOn(path: string, enabled = true): IndexRule {
  return { path, enabled, setAt: NOW.toISOString() }
}

/** Index options that plan with the embedder's model and hand it out when the round needs it. */
export function usingEmbedder(embedder: Embedder): Pick<IndexOptions, 'modelId' | 'createEmbedder'> {
  return { modelId: embedder.model, createEmbedder: async () => embedder }
}

export async function createIndexFixture(wrapPg: (pg: PgModule) => PgModule = (pg) => pg): Promise<IndexFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-index-')))
  const schema = withTestSchema()
  const db = await openFilesDb({ pg: wrapPg(await loadPg(process.cwd())), url: PG_URL, schema: schema.schema })
  const sdb = await ensureSearchSchema(db)
  const embedder = createFakeEmbedder()
  return {
    root,
    schema: schema.schema,
    sdb,
    db,
    embedder,
    put: async (files) => {
      for (const [relPath, data] of Object.entries(files)) {
        const file = join(root, ...relPath.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, data)
      }
    },
    walk: async () => void (await walkRoots(db, { roots: [root], now: new Date() })),
    options: (extra = {}) => ({
      roots: [root],
      rules: [ruleOn(root)],
      ...usingEmbedder(embedder),
      now: NOW,
      budgetMs: Number.POSITIVE_INFINITY,
      platform: process.platform,
      ...extra,
    }),
    cleanup: async () => {
      await db.close().catch(() => undefined)
      await schema.cleanup()
      await rm(root, { recursive: true, force: true })
    },
  }
}
