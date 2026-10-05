import { createHash } from 'node:crypto'
import { EMBED_DIMS } from '../../../src/files/search/constants.js'
import type { Embedder } from '../../../src/files/search/types.js'

/**
 * A deterministic embedder for tests: a hashed bag of words. Texts sharing
 * words are close, texts sharing none are far — enough to make ranking and
 * rights filtering meaningful without the native runtime or the model.
 */

export const FAKE_MODEL_ID = 'fake-embedder@1'

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function fakeVector(text: string, dims: number = EMBED_DIMS): Float32Array {
  const vector = new Float32Array(dims)
  for (const word of wordsOf(text)) {
    const digest = createHash('sha256').update(word).digest()
    const slot = digest.readUInt32BE(0) % dims
    vector[slot] = (vector[slot] ?? 0) + ((digest[4] ?? 0) & 1 ? 1 : -1)
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((value) => value / norm)
}

export interface FakeEmbedder extends Embedder {
  /** Every text embedded, in order, with its kind — to assert what reached the model (e.g. redacted text). */
  readonly calls: ReadonlyArray<{ readonly kind: 'passage' | 'query'; readonly text: string }>
  readonly isClosed: () => boolean
}

export function createFakeEmbedder(model: string = FAKE_MODEL_ID): FakeEmbedder {
  const calls: Array<{ kind: 'passage' | 'query'; text: string }> = []
  let isClosed = false
  return {
    model,
    dims: EMBED_DIMS,
    calls,
    isClosed: () => isClosed,
    embedPassage: async (text) => {
      calls.push({ kind: 'passage', text })
      return fakeVector(text)
    },
    embedQuery: async (text) => {
      calls.push({ kind: 'query', text })
      return fakeVector(text)
    },
    close: async () => {
      isClosed = true
    },
  }
}
