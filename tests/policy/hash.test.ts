import { describe, expect, test } from 'vitest'
import {
  CanonicalJsonDepthError,
  canonicalJson,
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
