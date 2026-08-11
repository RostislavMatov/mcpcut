import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { CONTENT_SECURITY_POLICY } from '../../src/ui/constants.js'
import { createEventHub, type EventHub } from '../../src/ui/events.js'
import { createEventsHandler } from '../../src/ui/handlers/events.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer } from '../../src/ui/server.js'

/**
 * Composed SSE-seam test (SSE-seam HIGH fix): the REAL `createEventsHandler` +
 * `createEventHub` wired into a REAL `createUiServer`, exercised over a real
 * `/events` HTTP connection. This is the path the unit tests could not cover —
 * it proves the two previously-diverging owners of the SSE headers are now one:
 *
 *  - a live `/events` connection gets ONE `200` carrying BOTH the SSE headers
 *    and the security headers, and the hub actually registers the subscriber
 *    (the old double-`writeHead` threw inside `onStream` and destroyed the
 *    socket without ever subscribing);
 *  - over the subscriber cap the request is refused with a clean `503` +
 *    `Retry-After` (the old 503 path was unreachable behind an already-written
 *    `200`).
 */

function stubHandlers(hub: EventHub): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    if (key === 'events') {
      out[key] = createEventsHandler(hub)
      continue
    }
    out[key] = () => ({ kind: 'response', status: 200, body: `handler:${key}` })
  }
  return out
}

interface Started {
  readonly base: string
  readonly port: number
  readonly server: UiServer
  readonly hub: EventHub
  login(token: string): Promise<string>
  dispose(): Promise<void>
}

const openReqs: ClientRequest[] = []

async function startUi(maxSubscribers: number): Promise<Started> {
  const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-sse-'))
  const adminStore = createAdminStore({ journalDir })
  const { token } = await adminStore.createAdmin('view-admin', 'viewer')
  const hub = createEventHub({ maxSubscribers })
  const server = createUiServer({ adminStore, handlers: stubHandlers(hub) })
  const { port } = await server.listen(0)
  const base = `http://127.0.0.1:${port}`

  async function login(t: string): Promise<string> {
    // `redirect: 'manual'`: a successful login answers 303 → `/`, and the
    // Set-Cookie lives on that redirect, not on the page it points at.
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t }),
      redirect: 'manual',
    })
    await res.text()
    const setCookie = res.headers.get('set-cookie') ?? ''
    return setCookie.split(';')[0] ?? ''
  }

  return {
    base,
    port,
    server,
    hub,
    login: () => login(token),
    dispose: async () => {
      hub.close()
      await server.close()
      rmSync(journalDir, { recursive: true, force: true })
    },
  }
}

/** Opens `/events` and resolves once response headers arrive; leaves it open. */
function openSse(
  port: number,
  cookie: string,
): Promise<{ res: IncomingMessage; req: ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/events', method: 'GET', headers: { cookie } },
      (res) => {
        res.resume() // drain heartbeats; do not let the socket buffer
        resolve({ res, req })
      },
    )
    openReqs.push(req)
    req.on('error', reject)
    req.end()
  })
}

/** A one-shot GET that reads to completion (for the 503 refusal). */
function getOnce(
  port: number,
  path: string,
  cookie: string,
): Promise<{ status: number; headers: NodeJS.Dict<string | string[]> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { cookie } },
      (res) => {
        res.on('data', () => {})
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

let started: Started | null = null

afterEach(async () => {
  for (const req of openReqs.splice(0)) req.destroy()
  await started?.dispose()
  started = null
})

describe('composed SSE seam', () => {
  test('a live /events connection carries one 200 with SSE + security headers and subscribes', async () => {
    started = await startUi(64)
    const cookie = await started.login('unused')
    const { res } = await openSse(started.port, cookie)

    expect(res.statusCode).toBe(200)
    // SSE headers written by the single server-side stream path…
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['x-accel-buffering']).toBe('no')
    // …together with the security headers, on the SAME response.
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    // The hub actually registered the stream — no throw, no destroyed socket.
    expect(started.hub.subscriberCount()).toBe(1)
  })

  test('over the subscriber cap /events is refused with a clean 503 + Retry-After', async () => {
    started = await startUi(1)
    const cookie = await started.login('unused')

    const { res: first } = await openSse(started.port, cookie)
    expect(first.statusCode).toBe(200)
    expect(started.hub.subscriberCount()).toBe(1)

    const refused = await getOnce(started.port, '/events', cookie)
    expect(refused.status).toBe(503)
    expect(refused.headers['retry-after']).toBeDefined()
    // The full hub still holds exactly the one live subscriber.
    expect(started.hub.subscriberCount()).toBe(1)
  })
})
