import { afterAll, beforeAll, expect, test } from 'vitest'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { SEARCH_MODEL_ID } from '../../../src/files/search/constants.js'
import { createLocalEmbedder } from '../../../src/files/search/embedder.js'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { createSearchBackend } from '../../../src/files/search/search-backend.js'
import { createFilesServer } from '../../../src/files/server.js'
import { NOW, ruleOn } from './index-fixture.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describe } from 'vitest'
import { walkRoots } from '../../../src/files/db/catalog-walk.js'
import { PG_URL } from '../db/pg-helpers.js'

/**
 * Performance with the real model and a real Postgres (gated on both MCPCUT_TEST_SEARCH_MODULES and
 * MCPCUT_TEST_PG_URL): 1000 generated files of about 2 KB, mixed Russian and English, indexed; one search
 * under a second. The indexing time is printed.
 */

const modulesDir = process.env['MCPCUT_TEST_SEARCH_MODULES']
const FILE_COUNT = 1000
const MAX_SEARCH_MS = 1000
const INDEX_TIMEOUT_MS = 30 * 60_000

const RU = ['возврат', 'товара', 'заявление', 'чек', 'доставка', 'курьер', 'оплата', 'карта', 'договор', 'склад', 'заказ', 'гарантия', 'ремонт', 'сервис', 'отчёт', 'проект']
const EN = ['deployment', 'pipeline', 'docker', 'registry', 'secret', 'rotation', 'invoice', 'payment', 'schedule', 'meeting', 'release', 'branch', 'review', 'incident', 'backlog', 'metrics']

function sentence(seed: number, words: readonly string[]): string {
  const picked = Array.from({ length: 9 }, (_unused, n) => words[(seed * 7 + n * 5 + n * n) % words.length])
  return `${picked.join(' ')}.`
}

/** About 2 KB: alternating Russian and English sentences, different per file. */
function documentOf(index: number): string {
  const lines: string[] = [`Документ номер ${index} / Document ${index}`]
  for (let n = 0; lines.join('\n').length < 2000; n += 1) {
    lines.push(sentence(index + n, n % 2 === 0 ? RU : EN))
  }
  return lines.join('\n')
}

describe.skipIf(modulesDir === undefined || PG_URL === '')('search with the real model on 1000 files', () => {
  let fx: SearchFixture
  beforeAll(async () => {
    fx = await createSearchFixture()
  })
  afterAll(async () => {
    await fx.cleanup()
  })

  test('indexes them and answers one search in under a second', async () => {
    const files: Record<string, string> = {}
    for (let n = 0; n < FILE_COUNT; n += 1) files[`docs/d${String(n % 20).padStart(2, '0')}/f${n}.md`] = documentOf(n)
    files['docs/special.md'] = 'Как оформить возврат товара: заполните заявление и приложите чек в течение четырнадцати дней.'
    await fx.put(files)
    const docs = fx.dir('docs')
    await walkRoots(fx.db, { roots: [docs], now: new Date() })
    // The indexer closes the embedder it asked for at the end of the round; the search makes its own.
    const embedderFor = () => createLocalEmbedder({ modulesDir: modulesDir as string })
    const started = Date.now()
    const result = await indexOnce(fx.sdb, { roots: [docs], rules: [ruleOn(docs)], modelId: SEARCH_MODEL_ID, createEmbedder: embedderFor, now: NOW, budgetMs: Number.POSITIVE_INFINITY, platform: process.platform })
    const indexMs = Date.now() - started
    console.info(`indexed ${result.indexed} files in ${(indexMs / 1000).toFixed(1)} s`)
    expect(result.indexed).toBe(FILE_COUNT + 1)

    const search = createSearchBackend({
      journalDir: fx.journalDir,
      cli: 'mcpcut',
      schema: fx.schema,
      loadPg: () => loadPg(process.cwd()),
      createEmbedder: embedderFor,
    })
    const server = createFilesServer({ roots: async () => [docs], rules: async () => [{ path: docs, ops: ['read'] }], actor: 'a', searchListed: async () => true, search })
    const ask = async (query: string) =>
      (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: { query } } })) as {
        result: { content: Array<{ text: string }> }
      }
    await ask('warm up')
    const searchStarted = Date.now()
    const answer = await ask('how do I return an item?')
    const searchMs = Date.now() - searchStarted
    await search.close()

    const results = (JSON.parse(answer.result.content[0]?.text ?? '{}') as { results: Array<{ path: string; text: string }> }).results
    expect(results[0]?.path).toBe(`${docs}/special.md`)
    expect(searchMs).toBeLessThan(MAX_SEARCH_MS)
  }, INDEX_TIMEOUT_MS)
})
