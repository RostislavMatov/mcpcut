import { afterEach, describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import type { WarnSink } from '../../../src/transport/http/server.js'
import {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from '../../../src/transport/http/server-constants.js'
import {
  createFakeSessionFactory,
  openSseCapture,
  startFront,
  INITIALIZE_BODY,
  NO_RESPONSE_MARKER,
  type StartedFront,
} from './front-harness.js'

/**
 * Integration tests for the downstream HTTP front (M3 Task 10): a real
 * `node:http` server on an ephemeral port, a real agents store, and the
 * fake echo session factory in place of session-core.
 */

const REQUEST_BODY = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
const NOTIFICATION_BODY = `{"jsonrpc":"2.0","method":"notify","${NO_RESPONSE_MARKER}":1}`

let started: StartedFront | null = null

afterEach(async () => {
  await started?.dispose()
  started = null
})

function collectStderr(): { sink: WarnSink; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    sink: {
      write: (chunk: string) => {
        lines.push(chunk)
        return true
      },
    },
  }
}

describe('sessionful model over HTTP', () => {
  test('full cycle: initialize → Mcp-Session-Id → POST → DELETE → 404 after', async () => {
    started = await startFront()
    const path = started.path()

    // initialize mints a session
    const init = await started.call('POST', path, { body: INITIALIZE_BODY })
    expect(init.status).toBe(200)
    const sessionId = init.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    expect(await init.text()).toBe(INITIALIZE_BODY)

    // follow-up POST rides the same session — header read is case-insensitive
    const followUp = await started.call('POST', path, {
      body: REQUEST_BODY,
      headers: { 'MCP-SESSION-ID': sessionId as string },
    })
    expect(followUp.status).toBe(200)
    expect(await followUp.text()).toBe(REQUEST_BODY)
    expect(started.factory.handles).toHaveLength(1)
    expect(started.factory.handles[0]?.written).toHaveLength(2)

    // DELETE tears the session down
    const del = await started.call('DELETE', path, {
      headers: { 'mcp-session-id': sessionId as string },
    })
    expect(del.status).toBe(204)
    await waitUntil(() => started?.factory.handles[0]?.isClosed() === true)

    // the dead session id now answers 404
    const after = await started.call('POST', path, {
      body: REQUEST_BODY,
      headers: { 'mcp-session-id': sessionId as string },
    })
    expect(after.status).toBe(404)
  })

  test('a notification into a session answers 202 without a body', async () => {
    started = await startFront()
    const init = await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    const sessionId = init.headers.get('mcp-session-id') as string

    const response = await started.call('POST', started.path(), {
      body: NOTIFICATION_BODY,
      headers: { 'mcp-session-id': sessionId },
    })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  test('429 when the session limit is exhausted', async () => {
    started = await startFront({ maxSessions: 1 })
    await started.call('POST', started.path(), { body: INITIALIZE_BODY })

    const second = await started.call('POST', started.path(), { body: INITIALIZE_BODY })

    expect(second.status).toBe(429)
    expect(await second.text()).toBe('{"error":"too-many-sessions"}')
  })
})

describe('stateless model over HTTP', () => {
  test('POST without initialize is served per-request; the one-shot session closes after', async () => {
    started = await startFront()

    const response = await started.call('POST', started.path(), { body: REQUEST_BODY })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(REQUEST_BODY)
    expect(started.factory.handles).toHaveLength(1)
    expect(started.factory.handles[0]?.isClosed()).toBe(true)
  })

  test('validateStatelessHeaders drives the 400 branch with the hook body', async () => {
    const errorBody = Buffer.from('{"error":"header-mismatch","code":-32020}')
    started = await startFront({
      validateStatelessHeaders: (headers) =>
        headers['mcp-method'] === 'tools/list' ? { ok: true } : { ok: false, errorBody },
    })

    const bad = await started.call('POST', started.path(), { body: REQUEST_BODY })
    const good = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { 'mcp-method': 'tools/list' },
    })

    expect(bad.status).toBe(400)
    expect(await bad.text()).toBe(errorBody.toString('utf8'))
    expect(good.status).toBe(200)
  })

  test('a stateless notification answers 202', async () => {
    started = await startFront()

    const response = await started.call('POST', started.path(), { body: NOTIFICATION_BODY })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })
})

describe('GET server-initiated stream', () => {
  test('receives buffered and live server-initiated messages, plus heartbeats', async () => {
    started = await startFront({ heartbeatIntervalMs: 25 })
    const init = await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    const sessionId = init.headers.get('mcp-session-id') as string
    const handle = started.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.push('{"method":"before-get"}')
    const capture = await openSseCapture(started, started.path(), {
      'mcp-session-id': sessionId,
    })
    expect(capture.status).toBe(200)
    expect(capture.contentType).toContain('text/event-stream')

    handle.push('{"method":"after-get"}')
    await waitUntil(() => capture.events.length >= 2)

    expect(capture.events[0]).toBe('{"method":"before-get"}')
    expect(capture.events[1]).toBe('{"method":"after-get"}')
    await waitUntil(() => capture.raw().includes(': ping'))
    capture.close()
  })

  test('GET without a session answers 405', async () => {
    started = await startFront()

    const response = await started.call('GET', started.path())

    expect(response.status).toBe(405)
  })

  test('GET with an unknown session id answers 404', async () => {
    started = await startFront()

    const response = await started.call('GET', started.path(), {
      headers: { 'mcp-session-id': 'never-issued' },
    })

    expect(response.status).toBe(404)
  })
})

describe('limits and refusals', () => {
  test('a body over the limit answers 413', async () => {
    started = await startFront({ maxBodyBytes: 64 })

    const response = await started.call('POST', started.path(), {
      body: `{"pad":"${'x'.repeat(256)}"}`,
    })

    expect(response.status).toBe(413)
    expect(await response.text()).toBe('{"error":"payload-too-large"}')
  })

  test("an 'unknown-server' refusal from the session factory answers 404", async () => {
    started = await startFront({}, createFakeSessionFactory({ refuseWith: 'unknown-server' }))

    const response = await started.call('POST', started.path(), { body: REQUEST_BODY })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"error":"not-found"}')
  })
})

describe('listen and close', () => {
  test('listen(0) binds an ephemeral port on 127.0.0.1 without any warning', async () => {
    const stderr = collectStderr()
    started = await startFront({ stderr: stderr.sink })

    expect(started.port).toBeGreaterThan(0)
    expect(stderr.lines.join('')).not.toContain('non-localhost')
  })

  test('binding a non-localhost host prints the TLS warning to stderr', async () => {
    started = await startFront()
    const warned = collectStderr()
    const { createHttpFront } = await import('../../../src/transport/http/server.js')
    const bare = createHttpFront({
      agentsStore: started.agentsStore,
      openSession: started.factory.openSession,
      stderr: warned.sink,
    })

    await bare.listen(0, '0.0.0.0')
    await bare.close()

    expect(warned.lines.join('')).toContain(
      '[http] binding to non-localhost host; put TLS in front',
    )
  })

  test.each(['0.0.0.0', '::'])(
    'a wildcard bind (%s) additionally warns that remote clients need --allowed-host',
    async (wildcard) => {
      started = await startFront()
      const warned = collectStderr()
      const { createHttpFront } = await import('../../../src/transport/http/server.js')
      const bare = createHttpFront({
        agentsStore: started.agentsStore,
        openSession: started.factory.openSession,
        stderr: warned.sink,
      })

      await bare.listen(0, wildcard)
      await bare.close()

      const output = warned.lines.join('')
      expect(output).toContain('[http] binding to non-localhost host; put TLS in front')
      expect(output).toContain('--allowed-host')
    },
  )


  test('the listener carries explicit connection timeouts (audit 2026-09-02, F3)', async () => {
    started = await startFront()

    expect(started.front.connectionTimeouts()).toEqual({
      headersTimeoutMs: HEADERS_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
    })
    // Node requires headersTimeout <= requestTimeout; pin the ordering so a
    // future edit cannot invert it without this test noticing.
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS)
  })

  test('close() tears down live sessions and stops accepting connections', async () => {
    started = await startFront()
    await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    expect(started.factory.handles).toHaveLength(1)
    const { baseUrl, factory, token } = started

    await started.front.close()

    expect(factory.handles[0]?.isClosed()).toBe(true)
    await expect(
      fetch(`${baseUrl}/agents/bot/servers/github`, {
        method: 'POST',
        body: REQUEST_BODY,
        headers: { authorization: `Bearer ${token}` },
      }),
    ).rejects.toThrow()
  })

  test('close() severs an open GET stream', async () => {
    started = await startFront()
    const init = await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    const sessionId = init.headers.get('mcp-session-id') as string
    const capture = await openSseCapture(started, started.path(), {
      'mcp-session-id': sessionId,
    })
    expect(capture.status).toBe(200)

    await started.front.close()

    // The stream ends rather than hanging; new connections are refused.
    await expect(
      fetch(`${started.baseUrl}${started.path()}`, {
        headers: { authorization: `Bearer ${started.token}` },
      }),
    ).rejects.toThrow()
    capture.close()
  })
})
