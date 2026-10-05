import { describe, expect, test } from 'vitest'
import { EMBED_DIMS } from '../../../src/files/search/constants.js'
import { createLocalEmbedder } from '../../../src/files/search/embedder.js'

/**
 * The real runtime and model. Skipped unless MCPCUT_TEST_SEARCH_MODULES points
 * at a folder laid out like `<data dir>/modules` with `search/node_modules`
 * and `search/models/…` installed (`files setup --search` makes one).
 */

const modulesDir = process.env['MCPCUT_TEST_SEARCH_MODULES']

const PASSAGES = [
  'Как оформить возврат товара: заполните заявление и приложите чек.',
  'The deployment pipeline builds a Docker image and pushes it to the registry.',
  'Рецепт борща: свёкла, капуста, картофель, морковь, лук.',
  'To rotate the OAuth client secret, open the app settings and generate a new one.',
]
const QUERIES: ReadonlyArray<readonly [string, number]> = [
  ['how do I return an item?', 0],
  ['как задеплоить контейнер', 1],
  ['суп из свёклы', 2],
  ['rotate secret', 3],
]

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * (b[i] as number), 0)

describe.skipIf(modulesDir === undefined)('the real local embedder', () => {
  test('ranks the right passage first for each query, across languages, with unit vectors', async () => {
    const embedder = await createLocalEmbedder({ modulesDir: modulesDir as string })
    try {
      const passages = []
      for (const text of PASSAGES) passages.push(await embedder.embedPassage(text))
      for (const vector of passages) {
        expect(vector).toHaveLength(EMBED_DIMS)
        expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-5)
      }
      for (const [query, expected] of QUERIES) {
        const queryVector = await embedder.embedQuery(query)
        expect(queryVector).toHaveLength(EMBED_DIMS)
        expect(Math.abs(Math.hypot(...queryVector) - 1)).toBeLessThan(1e-5)
        const scores = passages.map((passage) => dot(queryVector, passage))
        expect(scores.indexOf(Math.max(...scores)), query).toBe(expected)
      }
    } finally {
      await embedder.close()
    }
  }, 60_000)
})
