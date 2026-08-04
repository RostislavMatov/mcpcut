import { describe, expect, test } from 'vitest'
import { redact } from '../../src/redact/redact.js'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'

/** Recursively freezes an object graph so mutation attempts throw in strict mode. */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze)
    Object.freeze(obj)
  }
  return obj
}

describe('redact', () => {
  describe('sensitive keys', () => {
    test('replaces a top-level key matching a redact pattern', () => {
      const input = { token: 'abc123' }

      const result = redact(input) as Record<string, unknown>

      expect(result.token).toBe(REDACTED_PLACEHOLDER)
    })

    test('replaces sensitive keys regardless of value type (string, object, array, number)', () => {
      const input = {
        password: 'hunter2',
        secret: { nested: 'value' },
        credential: ['a', 'b'],
        access_key: 12345,
      }

      const result = redact(input) as Record<string, unknown>

      expect(result.password).toBe(REDACTED_PLACEHOLDER)
      expect(result.secret).toBe(REDACTED_PLACEHOLDER)
      expect(result.credential).toBe(REDACTED_PLACEHOLDER)
      expect(result.access_key).toBe(REDACTED_PLACEHOLDER)
    })

    test('key match is case-insensitive: API_KEY', () => {
      const input = { API_KEY: 'super-secret' }

      const result = redact(input) as Record<string, unknown>

      expect(result.API_KEY).toBe(REDACTED_PLACEHOLDER)
    })

    test('key match is case-insensitive: ApiKey', () => {
      const input = { ApiKey: 'super-secret' }

      const result = redact(input) as Record<string, unknown>

      expect(result.ApiKey).toBe(REDACTED_PLACEHOLDER)
    })

    test('leaves non-secret keys untouched', () => {
      const input = { toolName: 'search', count: 3, active: true }

      const result = redact(input) as Record<string, unknown>

      expect(result).toEqual(input)
    })
  })

  describe('Authorization header never survives redaction', () => {
    test('Bearer token in headers.Authorization is fully removed from serialized output', () => {
      const input = { headers: { Authorization: 'Bearer abc123' } }

      const result = redact(input)
      const serialized = JSON.stringify(result)

      expect(serialized).not.toContain('abc123')
      expect(serialized).not.toContain('Bearer abc123')
    })

    test('Basic token in params.authorization is fully removed from serialized output', () => {
      const input = { params: { authorization: 'Basic xyz==' } }

      const result = redact(input)
      const serialized = JSON.stringify(result)

      expect(serialized).not.toContain('xyz==')
      expect(serialized).not.toContain('Basic xyz==')
    })

    test('key-based redaction wins even without a Bearer/Basic value pattern match', () => {
      const input = { headers: { Authorization: 'opaque-token-value' } }

      const result = redact(input) as { headers: Record<string, unknown> }

      expect(result.headers.Authorization).toBe(REDACTED_PLACEHOLDER)
      expect(JSON.stringify(result)).not.toContain('opaque-token-value')
    })
  })

  describe('value-pattern redaction (non-sensitive keys carrying inline tokens)', () => {
    test('redacts a Bearer token embedded in a string value under a non-sensitive key', () => {
      const input = { message: 'call with Bearer sk-abc.def-123 please' }

      const result = redact(input) as Record<string, unknown>

      expect(result.message).not.toContain('sk-abc.def-123')
      expect(result.message).toContain(REDACTED_PLACEHOLDER)
    })

    test('redacts a Basic token embedded in a string value under a non-sensitive key', () => {
      const input = { note: 'creds were Basic dXNlcjpwYXNz' }

      const result = redact(input) as Record<string, unknown>

      expect(result.note).not.toContain('dXNlcjpwYXNz')
      expect(result.note).toContain(REDACTED_PLACEHOLDER)
    })

    test('value-pattern redaction is stable across repeated calls (no lastIndex statefulness leak)', () => {
      const input = { note: 'Bearer token1' }

      const first = redact(input) as Record<string, unknown>
      const second = redact(input) as Record<string, unknown>

      expect(first.note).toBe(second.note)
      expect(first.note).not.toContain('token1')
    })
  })

  describe('structural recursion', () => {
    test('recurses into nested objects', () => {
      const input = { outer: { inner: { token: 'deep-secret' } } }

      const result = redact(input) as { outer: { inner: Record<string, unknown> } }

      expect(result.outer.inner.token).toBe(REDACTED_PLACEHOLDER)
    })

    test('recurses into arrays of objects', () => {
      const input = { items: [{ token: 'a' }, { token: 'b' }, { safe: 'c' }] }

      const result = redact(input) as { items: Array<Record<string, unknown>> }

      expect(result.items[0]?.token).toBe(REDACTED_PLACEHOLDER)
      expect(result.items[1]?.token).toBe(REDACTED_PLACEHOLDER)
      expect(result.items[2]?.safe).toBe('c')
    })

    test('passes through null values unchanged', () => {
      const input = { value: null, token: null }

      const result = redact(input) as Record<string, unknown>

      expect(result.value).toBeNull()
      // sensitive key still gets replaced even though the value is null
      expect(result.token).toBe(REDACTED_PLACEHOLDER)
    })

    test('passes through undefined values unchanged', () => {
      const input: Record<string, unknown> = { value: undefined }

      const result = redact(input) as Record<string, unknown>

      expect(result.value).toBeUndefined()
    })

    test('passes through primitives unchanged at the top level', () => {
      expect(redact(42)).toBe(42)
      expect(redact(true)).toBe(true)
      expect(redact('plain string')).toBe('plain string')
      expect(redact(null)).toBeNull()
      expect(redact(undefined)).toBeUndefined()
    })

    test('handles deeply nested objects (5+ levels)', () => {
      const input = {
        l1: { l2: { l3: { l4: { l5: { token: 'buried-secret', safe: 'ok' } } } } },
      }

      const result = redact(input) as {
        l1: { l2: { l3: { l4: { l5: Record<string, unknown> } } } }
      }

      expect(result.l1.l2.l3.l4.l5.token).toBe(REDACTED_PLACEHOLDER)
      expect(result.l1.l2.l3.l4.l5.safe).toBe('ok')
    })

    test('handles an empty object', () => {
      expect(redact({})).toEqual({})
    })

    test('handles an empty array', () => {
      expect(redact([])).toEqual([])
    })

    test('handles a top-level array of objects', () => {
      const input = [{ token: 'a' }, { safe: 'b' }]

      const result = redact(input) as Array<Record<string, unknown>>

      expect(result[0]?.token).toBe(REDACTED_PLACEHOLDER)
      expect(result[1]?.safe).toBe('b')
    })
  })

  describe('circular references', () => {
    test('replaces a self-referencing object with a circular marker instead of recursing infinitely', () => {
      const input: Record<string, unknown> = { name: 'self-ref' }
      input.self = input

      const result = redact(input) as Record<string, unknown>

      expect(result.name).toBe('self-ref')
      expect(result.self).toBe('[CIRCULAR]')
    })

    test('replaces a circular array reference with a circular marker', () => {
      const arr: unknown[] = ['a']
      arr.push(arr)

      const result = redact(arr) as unknown[]

      expect(result[0]).toBe('a')
      expect(result[1]).toBe('[CIRCULAR]')
    })

    test('does not throw for circular structures', () => {
      const input: Record<string, unknown> = {}
      input.parent = input

      expect(() => redact(input)).not.toThrow()
    })
  })

  describe('immutability', () => {
    test('does not mutate the original input object', () => {
      const input = deepFreeze({
        headers: { Authorization: 'Bearer abc123' },
        items: [{ token: 'x' }],
      })

      expect(() => redact(input)).not.toThrow()

      const result = redact(input) as { headers: Record<string, unknown> }
      expect(result.headers.Authorization).toBe(REDACTED_PLACEHOLDER)
      // original untouched: frozen object retains its original secret value
      expect(input.headers.Authorization).toBe('Bearer abc123')
    })

    test('returns a new object reference, not the same reference as the input', () => {
      const input = { safe: 'value' }

      const result = redact(input)

      expect(result).not.toBe(input)
      expect(result).toEqual(input)
    })

    test('returns a new nested object reference', () => {
      const input = { outer: { safe: 'value' } }

      const result = redact(input) as { outer: unknown }

      expect(result.outer).not.toBe(input.outer)
    })
  })
})
