import { describe, expect, test } from 'vitest'
import { createRecordBuilder } from '../../src/journal/record.js'
import {
  MAX_INVALID_PAYLOAD_CHARS,
  MAX_PENDING_REQUESTS,
  REDACTED_PLACEHOLDER,
} from '../../src/config.js'
import type { ClassifiedMessage, JsonRpcId } from '../../src/protocol/classify.js'

/**
 * Hardening regressions for the record builder: payload size caps on raw
 * carriers, direction-aware correlation, and bounded pending-request state.
 */

/** Monotonic clock stub: every call advances by `stepMs`. */
function tickingClock(startMs: number, stepMs = 1): () => number {
  let current = startMs - stepMs
  return () => {
    current += stepMs
    return current
  }
}

const request = (id: JsonRpcId, method = 'tools/call'): ClassifiedMessage => ({
  kind: 'request',
  id,
  method,
  raw: JSON.stringify({ jsonrpc: '2.0', id, method }),
})

const response = (id: JsonRpcId): ClassifiedMessage => ({
  kind: 'response',
  id,
  isError: false,
  raw: JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
})

describe('raw payload size cap', () => {
  test('truncates an oversize unparseable line instead of journaling it whole', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })
    const oversize = `garbage ${'x'.repeat(MAX_INVALID_PAYLOAD_CHARS * 2)}`

    const record = builder.buildRecord(
      { kind: 'invalid', raw: oversize, reason: 'not valid JSON' },
      'client→server',
    )
    const payload = record.payload as string

    expect(payload.length).toBeLessThan(oversize.length)
    expect(payload.length).toBeLessThanOrEqual(MAX_INVALID_PAYLOAD_CHARS + 32)
    expect(payload).toContain('[TRUNCATED]')
  })

  test('leaves a short unparseable line intact apart from redaction', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })

    const record = builder.buildRecord(
      { kind: 'invalid', raw: 'short garbage {{', reason: 'not valid JSON' },
      'client→server',
    )

    expect(record.payload).toBe('short garbage {{')
  })

  test('truncates an oversize stderr line', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })

    const record = builder.buildStderrRecord('y'.repeat(MAX_INVALID_PAYLOAD_CHARS * 2))
    const payload = record.payload as string

    expect(payload.length).toBeLessThanOrEqual(MAX_INVALID_PAYLOAD_CHARS + 32)
    expect(payload).toContain('[TRUNCATED]')
  })

  test('redacts a secret that straddles the truncation boundary of a huge line', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })
    const head = 'a'.repeat(MAX_INVALID_PAYLOAD_CHARS - 10)
    const tail = 'b'.repeat(1_000_000)
    const raw = `${head}{"api_key":"sk-live-supersecretvalue123"}${tail}`

    const record = builder.buildRecord(
      { kind: 'invalid', raw, reason: 'not valid JSON' },
      'client→server',
    )

    expect(record.payload as string).not.toContain('sk-live-supersecret')
  })

  test('processes a multi-megabyte fragment in bounded time', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })
    const raw = '{"a":"b",'.repeat(1_800_000) // ~16 MB, the framer overflow size

    const startedAt = performance.now()
    builder.buildRecord({ kind: 'invalid', raw, reason: 'not valid JSON' }, 'client→server')
    const elapsedMs = performance.now() - startedAt

    // Coarse guard: redaction must work on a bounded window, not the whole
    // 16 MB line, or the proxy's event loop stalls for seconds.
    expect(elapsedMs).toBeLessThan(500)
  })

  test('seals an unterminated PRIVATE KEY block left behind by truncation', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })
    const raw = `noise ${'-----BEGIN RSA PRIVATE KEY-----\n'}${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(1_000)}`

    const record = builder.buildRecord(
      { kind: 'invalid', raw, reason: 'not valid JSON' },
      'client→server',
    )
    const payload = record.payload as string

    expect(payload).not.toContain('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo')
    expect(payload).toContain(REDACTED_PLACEHOLDER)
    expect(payload).toContain('noise')
  })

  test('redacts before truncating, so a secret near the cap cannot survive as a prefix', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })
    const filler = 'a'.repeat(MAX_INVALID_PAYLOAD_CHARS - 20)
    const raw = `${filler}{"api_key":"sk-live-supersecretvalue123"}`

    const record = builder.buildRecord(
      { kind: 'invalid', raw, reason: 'not valid JSON' },
      'client→server',
    )

    expect(record.payload as string).not.toContain('sk-live-supersecret')
  })
})

describe('direction-aware correlation', () => {
  test('a server-initiated request does not collide with a client request that reuses its id', () => {
    const builder = createRecordBuilder('session-1', { now: tickingClock(1_000, 100) })

    builder.buildRecord(request(1, 'tools/call'), 'client→server') // t=1000
    builder.buildRecord(request(1, 'sampling/createMessage'), 'server→client') // t=1100
    const clientAnswer = builder.buildRecord(response(1), 'client→server') // t=1200
    const serverAnswer = builder.buildRecord(response(1), 'server→client') // t=1300

    // The client's response answers the server-initiated request (t=1100).
    expect(clientAnswer.durationMs).toBe(100)
    // The server's response answers the client request (t=1000).
    expect(serverAnswer.durationMs).toBe(300)
  })

  test('a response in the same direction as the request is not correlated', () => {
    const builder = createRecordBuilder('session-1', { now: tickingClock(1_000, 100) })

    builder.buildRecord(request(5), 'client→server')
    const sameDirection = builder.buildRecord(response(5), 'client→server')

    expect(sameDirection.durationMs).toBeUndefined()
  })

  test('a null-id response is never correlated to a null-id request', () => {
    const builder = createRecordBuilder('session-1', { now: tickingClock(1_000, 100) })

    builder.buildRecord(request(null), 'client→server')
    const nullResponse = builder.buildRecord(response(null), 'server→client')

    expect(nullResponse.durationMs).toBeUndefined()
  })

  test('string and numeric ids with the same textual form do not collide', () => {
    const builder = createRecordBuilder('session-1', { now: tickingClock(1_000, 100) })

    builder.buildRecord(request(1), 'client→server')
    const stringResponse = builder.buildRecord(response('1'), 'server→client')

    expect(stringResponse.durationMs).toBeUndefined()
  })
})

describe('bounded pending-request state', () => {
  test('keeps the pending map bounded and still correlates the newest request', () => {
    const builder = createRecordBuilder('session-1', { now: tickingClock(1_000, 1) })
    const overflow = MAX_PENDING_REQUESTS + 100

    for (let i = 0; i < overflow; i += 1) {
      builder.buildRecord(request(i), 'client→server')
    }
    const newest = builder.buildRecord(response(overflow - 1), 'server→client')
    const evicted = builder.buildRecord(response(0), 'server→client')

    expect(newest.durationMs).toBeGreaterThanOrEqual(0)
    expect(evicted.durationMs).toBeUndefined()
  })
})

describe('stderr redaction', () => {
  test('an env assignment and a JSON password in one stderr line are both redacted', () => {
    const builder = createRecordBuilder('session-1', { now: () => 1_000 })

    const record = builder.buildStderrRecord('env: OPENAI_API_KEY=sk-live-XYZ {"password":"p"}')
    const payload = String(record.payload)

    expect(payload).not.toContain('sk-live-XYZ')
    expect(payload).not.toContain('"p"')
    expect(payload).toContain(REDACTED_PLACEHOLDER)
  })
})
