import { describe, expect, test } from 'vitest'
import { classifyBridgeFailure, isFatal } from '../../src/bridge/failure.js'
import {
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
  UpstreamResponseError,
} from '../../src/transport/http/client.js'
import { EmbeddedNewlineError } from '../../src/transport/stdio-adapter.js'

/**
 * What the bridge does with a failure it was handed (plan task 3).
 *
 * The distinction this file exists for is the one ADR-0014 paid for twice: a
 * NETWORK failure is not a revoked token. A blip must cost the request it hit
 * and nothing more; only an answer the service itself gave — 401, 403, a 404
 * with no session, an expired session — ends the bridge.
 */

const HOST = 'plane.example:8090'

describe('classifyBridgeFailure: answers the service itself gave', () => {
  test('401 means the token was not accepted — fatal', () => {
    const failure = classifyBridgeFailure(new UpstreamHttpStatusError('POST', 401, HOST))

    expect(failure.kind).toBe('unauthorized')
    expect(isFatal(failure)).toBe(true)
  })

  test('403 means Host or Origin screening refused us — fatal', () => {
    const failure = classifyBridgeFailure(new UpstreamHttpStatusError('POST', 403, HOST))

    expect(failure.kind).toBe('forbidden')
    expect(isFatal(failure)).toBe(true)
  })

  test('404 means there is no such endpoint for this token — fatal', () => {
    const failure = classifyBridgeFailure(new UpstreamHttpStatusError('POST', 404, HOST))

    expect(failure.kind).toBe('no-endpoint')
    expect(isFatal(failure)).toBe(true)
  })

  test('an expired session is fatal, but its own kind: the client should restart us', () => {
    const failure = classifyBridgeFailure(new SessionExpiredError(HOST))

    expect(failure.kind).toBe('session-expired')
    expect(isFatal(failure)).toBe(true)
  })

  test('an SSE stream that exhausted its reconnect budget is fatal too', () => {
    const failure = classifyBridgeFailure(new SseStreamError(HOST, 5, new Error('reset')))

    expect(failure.kind).toBe('stream-lost')
    expect(isFatal(failure)).toBe(true)
  })
})

describe('classifyBridgeFailure: what costs one request and no more', () => {
  test.each([409, 413, 429, 500, 502, 504])(
    'HTTP %i is the service having a moment, not a verdict on us',
    (status) => {
      const failure = classifyBridgeFailure(new UpstreamHttpStatusError('POST', status, HOST))

      expect(failure).toEqual({ kind: 'service', status })
      expect(isFatal(failure)).toBe(false)
    },
  )

  test('a connection failure is a network failure, NOT a revoked token', () => {
    const failure = classifyBridgeFailure(
      new UpstreamConnectionError('POST', HOST, { code: 'ECONNREFUSED' }),
    )

    expect(failure.kind).toBe('network')
    expect(isFatal(failure)).toBe(false)
    // The detail is the typed error's own message, which carries the host and
    // the errno code and nothing else (`client-errors.ts` hygiene).
    expect(failure).toHaveProperty('detail', expect.stringContaining('ECONNREFUSED'))
  })

  test('an uninterpretable 2xx body costs its request', () => {
    const failure = classifyBridgeFailure(new UpstreamResponseError(HOST, 'unsupported content type'))

    expect(failure.kind).toBe('protocol')
    expect(isFatal(failure)).toBe(false)
  })

  test('a framing violation on the way back to the client costs its request', () => {
    const failure = classifyBridgeFailure(new EmbeddedNewlineError(12))

    expect(failure.kind).toBe('protocol')
    expect(isFatal(failure)).toBe(false)
  })
})

describe('classifyBridgeFailure: an error it does not know', () => {
  test('does not repeat what the error said — it may be anything at all', () => {
    const failure = classifyBridgeFailure(
      new Error('POST https://plane.example/agents/a/servers/s?token=mcpj_leak failed'),
    )

    expect(failure.kind).toBe('protocol')
    expect(JSON.stringify(failure)).not.toContain('mcpj_leak')
    expect(JSON.stringify(failure)).not.toContain('plane.example')
    expect(isFatal(failure)).toBe(false)
  })

  test.each([undefined, null, 'a string', 42, { message: 'mcpj_leak' }])(
    'survives %s without throwing and without echoing it',
    (thrown) => {
      const failure = classifyBridgeFailure(thrown)

      expect(failure.kind).toBe('protocol')
      expect(JSON.stringify(failure)).not.toContain('mcpj_leak')
    },
  )
})

describe('isFatal is exhaustive over the union', () => {
  test('every kind the classifier can produce has an answer', () => {
    const kinds = [
      classifyBridgeFailure(new UpstreamHttpStatusError('POST', 401, HOST)),
      classifyBridgeFailure(new UpstreamHttpStatusError('POST', 403, HOST)),
      classifyBridgeFailure(new UpstreamHttpStatusError('POST', 404, HOST)),
      classifyBridgeFailure(new SessionExpiredError(HOST)),
      classifyBridgeFailure(new SseStreamError(HOST, 5, null)),
      classifyBridgeFailure(new UpstreamHttpStatusError('POST', 500, HOST)),
      classifyBridgeFailure(new UpstreamConnectionError('POST', HOST, { code: 'ENOTFOUND' })),
      classifyBridgeFailure(new UpstreamResponseError(HOST, 'too large')),
    ]

    expect(new Set(kinds.map((failure) => failure.kind)).size).toBe(8)
    expect(kinds.filter(isFatal)).toHaveLength(5)
  })
})
