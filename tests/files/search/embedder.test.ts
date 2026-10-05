import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { EMBED_DIMS, SEARCH_MODEL_FILES, SEARCH_MODEL_ID } from '../../../src/files/search/constants.js'
import { createLocalEmbedder, defaultThreads, meanPoolNormalize, SearchModelMissingError, truncateIds } from '../../../src/files/search/embedder.js'
import { modelDirOf, modelFilePath } from '../../../src/files/search/model-files.js'
import type { OrtTensor, SearchRuntime } from '../../../src/files/search/ort-types.js'

describe('truncateIds', () => {
  test('keeps short input as is', () => {
    expect(truncateIds([1, 2, 3], 5)).toEqual([1, 2, 3])
    expect(truncateIds([1, 2, 3], 3)).toEqual([1, 2, 3])
  })
  test('cuts to max keeping the closing id', () => {
    expect(truncateIds([1, 2, 3, 4, 5, 2], 4)).toEqual([1, 2, 3, 2])
  })
})

describe('meanPoolNormalize', () => {
  test('averages the rows and scales to unit length', () => {
    const vector = meanPoolNormalize([3, 0, 1, 0, 0, 4], 3, 2) // rows [3,0] [1,0] [0,4] -> mean [4/3, 4/3]
    expect(vector[0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(vector[1]).toBeCloseTo(Math.SQRT1_2, 6)
  })
  test('an all-zero input stays zero instead of becoming NaN', () => {
    expect(Array.from(meanPoolNormalize([0, 0, 0, 0], 2, 2))).toEqual([0, 0])
  })
})

describe('defaultThreads', () => {
  test.each([[1, 1], [2, 1], [4, 2], [8, 4], [64, 4]])('%i cores -> %i threads', (cores, threads) => {
    expect(defaultThreads(cores)).toBe(threads)
  })
})

interface Seen {
  texts: string[]
  feeds: Array<Record<string, { type: string; data: BigInt64Array; dims: readonly number[] }>>
  options: unknown[]
  released: number
  concurrent: number
  maxConcurrent: number
}

function fakeRuntime(seen: Seen, opts: { inputNames?: string[]; outDims?: (n: number) => number[] } = {}): SearchRuntime {
  class Tensor {
    constructor(readonly type: 'int64', readonly data: BigInt64Array, readonly dims: readonly number[]) {}
  }
  let lastText = ''
  return {
    ort: {
      Tensor: Tensor as unknown as SearchRuntime['ort']['Tensor'],
      InferenceSession: {
        create: async (_path, options) => {
          seen.options.push(options)
          return {
            inputNames: opts.inputNames ?? ['input_ids', 'attention_mask', 'token_type_ids'],
            outputNames: ['last_hidden_state'],
            release: async () => {
              seen.released += 1
            },
            run: async (feeds): Promise<Record<string, OrtTensor>> => {
              seen.concurrent += 1
              seen.maxConcurrent = Math.max(seen.maxConcurrent, seen.concurrent)
              seen.feeds.push(feeds as never)
              await new Promise((resolve) => setTimeout(resolve, 5))
              const n = (feeds['input_ids'] as OrtTensor).dims[1] as number
              const dims = opts.outDims?.(n) ?? [1, n, EMBED_DIMS]
              // Token t carries 1 in slot (t % 2): the mean is a fixed direction for a given n.
              const data = new Float32Array(dims.reduce((a, b) => a * b, 1))
              for (let t = 0; t < n; t++) data[t * EMBED_DIMS + (lastText.length % 2)] = 2
              seen.concurrent -= 1
              return { last_hidden_state: { data, dims } }
            },
          }
        },
      },
    },
    Tokenizer: class {
      encode(text: string) {
        lastText = text
        seen.texts.push(text)
        return { ids: [0, ...Array.from(text, (_c, i) => i + 5).slice(0, 600), 2] }
      }
    } as unknown as SearchRuntime['Tokenizer'],
  }
}

let modulesDir: string
let seen: Seen
beforeEach(async () => {
  modulesDir = await mkdtemp(join(tmpdir(), 'mcpcut-embedder-'))
  seen = { texts: [], feeds: [], options: [], released: 0, concurrent: 0, maxConcurrent: 0 }
  const dir = modelDirOf(join(modulesDir, 'search'))
  for (const file of SEARCH_MODEL_FILES) {
    const path = modelFilePath(dir, file)
    await mkdir(join(path, '..'), { recursive: true })
    // Only the size check and the JSON parse run on these: a sparse file of the pinned size is enough.
    if (file.path.endsWith('.json')) await writeFile(path, `{${' '.repeat(file.size - 2)}}`)
    else {
      await writeFile(path, '')
      await truncate(path, file.size)
    }
  }
})
afterEach(async () => {
  await rm(modulesDir, { recursive: true, force: true })
})

describe('createLocalEmbedder', () => {
  test('adds the e5 prefixes, feeds the three int64 inputs and returns a unit vector of the model dims', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, threads: 3, load: async () => fakeRuntime(seen) })
    const vector = await embedder.embedPassage('hello')
    await embedder.embedQuery('hi')
    expect(embedder.model).toBe(SEARCH_MODEL_ID)
    expect(embedder.dims).toBe(EMBED_DIMS)
    expect(seen.texts).toEqual(['passage: hello', 'query: hi'])
    expect(seen.options).toEqual([{ intraOpNumThreads: 3, interOpNumThreads: 1, graphOptimizationLevel: 'all' }])
    const first = seen.feeds[0]!
    expect(Object.keys(first)).toEqual(['input_ids', 'attention_mask', 'token_type_ids'])
    expect(first['input_ids']!.dims).toEqual([1, 16])
    expect(first['input_ids']!.type).toBe('int64')
    expect(Array.from(first['attention_mask']!.data).every((v) => v === 1n)).toBe(true)
    expect(Array.from(first['token_type_ids']!.data).every((v) => v === 0n)).toBe(true)
    expect(vector).toHaveLength(EMBED_DIMS)
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5)
  })

  test('omits token_type_ids when the model has no such input', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, load: async () => fakeRuntime(seen, { inputNames: ['input_ids', 'attention_mask'] }) })
    await embedder.embedQuery('x')
    expect(Object.keys(seen.feeds[0]!)).toEqual(['input_ids', 'attention_mask'])
  })

  test('cuts long input to 512 ids', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, load: async () => fakeRuntime(seen) })
    await embedder.embedPassage('x'.repeat(2000))
    expect(seen.feeds[0]!['input_ids']!.dims).toEqual([1, 512])
  })

  test('an unexpected output shape is a clear error', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, load: async () => fakeRuntime(seen, { outDims: (n) => [1, n, 768] }) })
    await expect(embedder.embedQuery('x')).rejects.toThrow(/unexpected shape \[1, \d+, 768\]/)
  })

  test('runs one text at a time even when called concurrently, and a failure does not block the next', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, load: async () => fakeRuntime(seen) })
    await Promise.all([embedder.embedQuery('a'), embedder.embedPassage('b'), embedder.embedQuery('c')])
    expect(seen.maxConcurrent).toBe(1)
    expect(seen.texts).toEqual(['query: a', 'passage: b', 'query: c'])
  })

  test('close releases the session once', async () => {
    const embedder = await createLocalEmbedder({ modulesDir, load: async () => fakeRuntime(seen) })
    await embedder.close()
    await embedder.close()
    expect(seen.released).toBe(1)
  })

  test('missing model files are SearchModelMissingError with the setup line', async () => {
    await rm(join(modulesDir, 'search', 'models'), { recursive: true })
    const failure = createLocalEmbedder({ modulesDir, cli: 'npx mcpcut', load: async () => fakeRuntime(seen) })
    await expect(failure).rejects.toBeInstanceOf(SearchModelMissingError)
    await expect(failure).rejects.toThrow('run `npx mcpcut files setup --search`')
  })
})
