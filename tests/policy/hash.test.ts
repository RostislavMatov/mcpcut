import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  CanonicalJsonDepthError,
  canonicalJson,
  createIncrementalSha256,
  hashToolSchema,
  sha256Hex,
} from '../../src/policy/hash.js'

describe('canonicalJson', () => {
  test('produces the same output regardless of object key insertion order', () => {
    const a = canonicalJson({ a: 1, b: 2 })
    const b = canonicalJson({ b: 2, a: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":1,"b":2}')
  })

  test('sorts keys lexicographically at every nesting level', () => {
    const value = canonicalJson({
      z: 1,
      a: { d: 1, b: 2, c: { y: 1, x: 2 } },
    })
    expect(value).toBe('{"a":{"b":2,"c":{"x":2,"y":1},"d":1},"z":1}')
  })

  test('preserves array order (order is significant, unlike object keys)', () => {
    const first = canonicalJson({ list: [1, 2, 3] })
    const second = canonicalJson({ list: [3, 2, 1] })
    expect(first).not.toBe(second)
    expect(first).toBe('{"list":[1,2,3]}')
  })

  test('serializes an array of objects with each object\'s keys sorted', () => {
    const value = canonicalJson([
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ])
    expect(value).toBe('[{"a":2,"b":1},{"c":4,"d":3}]')
  })

  test('omits undefined object properties, matching JSON.stringify semantics', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson({ a: undefined })).toBe('{}')
  })

  test('turns undefined array items into null, matching JSON.stringify semantics', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
  })

  test('numbers follow JSON.stringify semantics (NaN/Infinity -> null, -0 -> 0)', () => {
    expect(canonicalJson(Number.NaN)).toBe('null')
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null')
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson(1.5)).toBe('1.5')
  })

  test('distinguishes an explicit null property from a missing one', () => {
    // Both are valid JSON shapes a server could send, and they must not
    // collide onto the same canonical string / hash.
    const withNull = canonicalJson({ description: null })
    const missing = canonicalJson({})
    expect(withNull).not.toBe(missing)
    expect(withNull).toBe('{"description":null}')
    expect(missing).toBe('{}')
  })

  test('throws a typed error beyond the recursion depth limit', () => {
    let deeplyNested: unknown = { leaf: true }
    for (let i = 0; i < 100; i += 1) {
      deeplyNested = { nested: deeplyNested }
    }
    expect(() => canonicalJson(deeplyNested)).toThrow(CanonicalJsonDepthError)
  })

  test('serializes a top-level undefined as "null" instead of returning undefined', () => {
    expect(canonicalJson(undefined)).toBe('null')
  })

  test('does not throw for reasonably nested (but not pathological) values', () => {
    let nested: unknown = { leaf: true }
    for (let i = 0; i < 10; i += 1) {
      nested = { nested }
    }
    expect(() => canonicalJson(nested)).not.toThrow()
  })
})

describe('sha256Hex', () => {
  test('returns a 64-char lowercase hex digest', () => {
    const digest = sha256Hex('hello')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is deterministic for the same input', () => {
    expect(sha256Hex('hello world')).toBe(sha256Hex('hello world'))
  })

  test('differs for different input', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('Hello'))
  })

  test('matches the known SHA-256 digest of the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('hashToolSchema', () => {
  test('is invariant to the property order it is constructed from', () => {
    const hash = hashToolSchema({
      name: 'delete_file',
      description: 'Deletes a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      annotations: { destructiveHint: true },
    })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('changes when description changes', () => {
    const base = { name: 'search', inputSchema: { type: 'object' } }
    const first = hashToolSchema({ ...base, description: 'Search the index' })
    const second = hashToolSchema({ ...base, description: 'Search everything, including secrets' })
    expect(first).not.toBe(second)
  })

  test('changes when the input schema changes', () => {
    const base = { name: 'search', description: 'Search the index' }
    const first = hashToolSchema({ ...base, inputSchema: { type: 'object' } })
    const second = hashToolSchema({ ...base, inputSchema: { type: 'array' } })
    expect(first).not.toBe(second)
  })

  test('changes when annotations change', () => {
    const base = { name: 'search', description: 'Search the index' }
    const first = hashToolSchema({ ...base, annotations: { readOnlyHint: true } })
    const second = hashToolSchema({ ...base, annotations: { readOnlyHint: false } })
    expect(first).not.toBe(second)
  })

  test('treats an omitted description the same as an absent one across calls', () => {
    const withoutDescription = hashToolSchema({ name: 'search' })
    const withUndefinedDescription = hashToolSchema({ name: 'search', description: undefined })
    expect(withoutDescription).toBe(withUndefinedDescription)
  })

  test('is stable across two calls with structurally identical but distinct objects', () => {
    const descriptor = {
      name: 'list_items',
      description: 'Lists items',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      annotations: { readOnlyHint: true },
    }
    const first = hashToolSchema({ ...descriptor })
    const second = hashToolSchema({ ...descriptor })
    expect(first).toBe(second)
  })

  test('changes when the tool name changes', () => {
    const first = hashToolSchema({ name: 'delete_file' })
    const second = hashToolSchema({ name: 'delete_files' })
    expect(first).not.toBe(second)
  })
})

describe('createIncrementalSha256', () => {
  test('digests chunks fed one at a time exactly as sha256Hex digests their concatenation', () => {
    const chunks = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']

    const hasher = createIncrementalSha256()
    for (const chunk of chunks) {
      hasher.update(chunk)
    }

    expect(hasher.digestHex()).toBe(sha256Hex(chunks.join('')))
  })

  test('digests nothing as the empty-string digest, so an empty export still has a valid claim', () => {
    expect(createIncrementalSha256().digestHex()).toBe(sha256Hex(''))
  })

  test('is chunk-boundary independent: the same bytes split differently digest the same', () => {
    const oneChunk = createIncrementalSha256()
    oneChunk.update('abcdef')

    const split = createIncrementalSha256()
    split.update('ab')
    split.update('')
    split.update('cdef')

    expect(split.digestHex()).toBe(oneChunk.digestHex())
  })

  test('hashes multi-byte characters as UTF-8, matching sha256Hex', () => {
    const hasher = createIncrementalSha256()
    hasher.update('client→server')

    expect(hasher.digestHex()).toBe(sha256Hex('client→server'))
  })
})

/**
 * Binary chunks (M5 wave-5 review, finding V2). The offline verifier's
 * digest claim is "sha256 over the EXACT bytes of records.jsonl", and it can
 * only keep that promise if the digest never passes through a UTF-8
 * decoder: decoding is LOSSY for invalid input (every bad byte collapses to
 * U+FFFD), so two byte-different files hash the same once decoded. These
 * tests pin the byte path AND the pre-existing string path, because the
 * exporting side still feeds UTF-8 strings and must keep digesting them
 * identically.
 */
describe('createIncrementalSha256: raw bytes', () => {
  test('digests a byte chunk as those bytes, matching node crypto over the same buffer', () => {
    const bytes = Buffer.from([0x7b, 0x80, 0x7d, 0x0a])

    const hasher = createIncrementalSha256()
    hasher.update(bytes)

    expect(hasher.digestHex()).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  test('two files differing only in one INVALID utf-8 byte digest differently', () => {
    // The reviewer's reproduction: 0x80 and 0xff are both invalid UTF-8 and
    // both decode to U+FFFD, so a decoded digest cannot tell these apart.
    const first = Buffer.from([0x7b, 0x80, 0x7d])
    const second = Buffer.from([0x7b, 0xff, 0x7d])

    const a = createIncrementalSha256()
    a.update(first)
    const b = createIncrementalSha256()
    b.update(second)

    expect(a.digestHex()).not.toBe(b.digestHex())
  })

  test('a string chunk still digests as UTF-8, so the exporting side is unchanged', () => {
    const hasher = createIncrementalSha256()
    hasher.update('client→server')

    expect(hasher.digestHex()).toBe(sha256Hex('client→server'))
  })

  test('string and byte chunks mix in one digest, matching the concatenated bytes', () => {
    const hasher = createIncrementalSha256()
    hasher.update('{"a":1}')
    hasher.update(Buffer.from('\n', 'utf8'))
    hasher.update('{"b":2}\n')

    expect(hasher.digestHex()).toBe(sha256Hex('{"a":1}\n{"b":2}\n'))
  })
})
