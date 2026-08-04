import { describe, expect, test } from 'vitest'
import { createRecordBuilder } from '../../src/journal/record.js'
import { REDACTED_PLACEHOLDER, REQUEST_CORRELATION_TTL_MS } from '../../src/config.js'
import type { ClassifiedMessage } from '../../src/protocol/classify.js'

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Builds a `now()` stub that returns a fixed sequence of millisecond timestamps. */
function stubClock(...timestampsMs: number[]): () => number {
  const queue = [...timestampsMs]
  return () => {
    const next = queue.shift()
    if (next === undefined) {
      throw new Error('stubClock exhausted: not enough timestamps queued')
    }
    return next
  }
}

const request = (id: string | number, method: string): ClassifiedMessage => ({
  kind: 'request',
  id,
  method,
  raw: JSON.stringify({ jsonrpc: '2.0', id, method }),
})

const response = (id: string | number): ClassifiedMessage => ({
  kind: 'response',
  id,
  isError: false,
  raw: JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
})

describe('createRecordBuilder', () => {
  describe('base record shape', () => {
    test('assigns a ULID id, ISO-8601 ts, sessionId, direction and kind', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_700_000_000_000) })

      const record = builder.buildRecord(request(1, 'tools/list'), 'client→server')

      expect(record.id).toMatch(ULID_PATTERN)
      expect(record.ts).toBe(new Date(1_700_000_000_000).toISOString())
      expect(record.sessionId).toBe('session-1')
      expect(record.direction).toBe('client→server')
      expect(record.kind).toBe('request')
    })

    test('sets method and rpcId for a request', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const record = builder.buildRecord(request('abc', 'tools/call'), 'client→server')

      expect(record.method).toBe('tools/call')
      expect(record.rpcId).toBe('abc')
    })

    test('sets method but no rpcId for a notification', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })
      const notification: ClassifiedMessage = {
        kind: 'notification',
        method: 'notifications/initialized',
        raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }

      const record = builder.buildRecord(notification, 'client→server')

      expect(record.method).toBe('notifications/initialized')
      expect(record.rpcId).toBeUndefined()
    })

    test('sets rpcId but no method for a response', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000, 2_000) })
      builder.buildRecord(request(7, 'ping'), 'client→server')

      const record = builder.buildRecord(response(7), 'server→client')

      expect(record.rpcId).toBe(7)
      expect(record.method).toBeUndefined()
    })

    test('has no method or rpcId for an invalid message', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })
      const invalid: ClassifiedMessage = { kind: 'invalid', raw: 'not json', reason: 'not valid JSON' }

      const record = builder.buildRecord(invalid, 'client→server')

      expect(record.method).toBeUndefined()
      expect(record.rpcId).toBeUndefined()
      expect(record.kind).toBe('invalid')
    })
  })

  describe('request/response duration correlation', () => {
    test('sets durationMs on a response when a matching request was seen earlier in the opposite direction', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000, 1_250) })

      builder.buildRecord(request(1, 'tools/call'), 'client→server')
      const responseRecord = builder.buildRecord(response(1), 'server→client')

      expect(responseRecord.durationMs).toBe(250)
    })

    test('leaves durationMs unset on the request record itself', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const requestRecord = builder.buildRecord(request(1, 'tools/call'), 'client→server')

      expect(requestRecord.durationMs).toBeUndefined()
    })

    test('a response with no prior matching request has no durationMs (uncorrelated)', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const responseRecord = builder.buildRecord(response(999), 'server→client')

      expect(responseRecord.durationMs).toBeUndefined()
      expect(responseRecord.rpcId).toBe(999)
    })

    test('id reuse: a second request with the same id before any response resets the correlation clock (later request wins)', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000, 1_100, 1_400) })

      builder.buildRecord(request(1, 'tools/call'), 'client→server') // t=1000
      builder.buildRecord(request(1, 'tools/call'), 'client→server') // t=1100, overwrites pending entry
      const responseRecord = builder.buildRecord(response(1), 'server→client') // t=1400

      // Duration is measured from the second (later) request, not the first.
      expect(responseRecord.durationMs).toBe(300)
    })

    test('a response is only correlated once: a second response with the same id gets no durationMs', () => {
      const builder = createRecordBuilder('session-1', {
        now: stubClock(1_000, 1_200, 1_500),
      })

      builder.buildRecord(request(1, 'tools/call'), 'client→server')
      const first = builder.buildRecord(response(1), 'server→client')
      const second = builder.buildRecord(response(1), 'server→client')

      expect(first.durationMs).toBe(200)
      expect(second.durationMs).toBeUndefined()
    })

    test('TTL eviction: a response arriving after REQUEST_CORRELATION_TTL_MS has elapsed is not correlated', () => {
      const requestedAt = 1_000
      const pastTtl = requestedAt + REQUEST_CORRELATION_TTL_MS + 1
      const builder = createRecordBuilder('session-1', { now: stubClock(requestedAt, pastTtl) })

      builder.buildRecord(request(1, 'tools/call'), 'client→server')
      const responseRecord = builder.buildRecord(response(1), 'server→client')

      expect(responseRecord.durationMs).toBeUndefined()
    })

    test('a custom ttlMs option is honored', () => {
      const customTtlMs = 100
      const builder = createRecordBuilder('session-1', {
        now: stubClock(1_000, 1_101),
        ttlMs: customTtlMs,
      })

      builder.buildRecord(request(1, 'tools/call'), 'client→server')
      const responseRecord = builder.buildRecord(response(1), 'server→client')

      expect(responseRecord.durationMs).toBeUndefined()
    })
  })

  describe('redaction', () => {
    test('redacts a token found in request params before it reaches the record payload', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })
      const classified: ClassifiedMessage = {
        kind: 'request',
        id: 1,
        method: 'tools/call',
        raw: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { token: 'super-secret-value' },
        }),
      }

      const record = builder.buildRecord(classified, 'client→server')
      const serialized = JSON.stringify(record.payload)

      expect(serialized).not.toContain('super-secret-value')
      expect(serialized).toContain(REDACTED_PLACEHOLDER)
    })

    test('redacts an inline Bearer token in an unparseable raw line by falling back to string redaction', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })
      const invalid: ClassifiedMessage = {
        kind: 'invalid',
        raw: 'garbled Bearer sk-abc123 line {{',
        reason: 'not valid JSON',
      }

      const record = builder.buildRecord(invalid, 'client→server')

      expect(record.payload).not.toContain('sk-abc123')
      expect(String(record.payload)).toContain(REDACTED_PLACEHOLDER)
    })

    test('never throws when building a record, even for malformed input', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })
      const invalid: ClassifiedMessage = { kind: 'invalid', raw: '{{{not json', reason: 'not valid JSON' }

      expect(() => builder.buildRecord(invalid, 'client→server')).not.toThrow()
    })
  })

  describe('stderr records', () => {
    test('builds a stderr record with direction server-stderr and kind stderr', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const record = builder.buildStderrRecord('some diagnostic output')

      expect(record.direction).toBe('server-stderr')
      expect(record.kind).toBe('stderr')
      expect(record.payload).toBe('some diagnostic output')
      expect(record.method).toBeUndefined()
      expect(record.rpcId).toBeUndefined()
      expect(record.durationMs).toBeUndefined()
    })

    test('redacts secrets found in a raw stderr line', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const record = builder.buildStderrRecord('auth failed: Bearer sk-live-abcdef')

      expect(record.payload).not.toContain('sk-live-abcdef')
      expect(String(record.payload)).toContain(REDACTED_PLACEHOLDER)
    })

    test('assigns a ULID id and ISO ts to stderr records', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_700_000_000_000) })

      const record = builder.buildStderrRecord('boot ok')

      expect(record.id).toMatch(ULID_PATTERN)
      expect(record.ts).toBe(new Date(1_700_000_000_000).toISOString())
      expect(record.sessionId).toBe('session-1')
    })
  })

  describe('immutability and defaults', () => {
    test('returned records are frozen', () => {
      const builder = createRecordBuilder('session-1', { now: stubClock(1_000) })

      const record = builder.buildRecord(request(1, 'ping'), 'client→server')

      expect(Object.isFrozen(record)).toBe(true)
    })

    test('defaults to Date.now and REQUEST_CORRELATION_TTL_MS when opts are omitted', () => {
      const builder = createRecordBuilder('session-default')

      const record = builder.buildRecord(request(1, 'ping'), 'client→server')

      expect(record.sessionId).toBe('session-default')
      expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
    })
  })
})
