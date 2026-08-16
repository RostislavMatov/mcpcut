import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { createSessionManager, type SessionManager } from '../../src/ui/auth.js'
import { createEventHub, type EventHub, type IntervalHandle, type Scheduler } from '../../src/ui/events.js'
import { createEventsHandler } from '../../src/ui/handlers/events.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer } from '../../src/ui/server.js'

/**
 * Origin a browser would attach to every POST from a page of this UI. The
 * server requires it on state-changing requests; any localhost origin passes
 * the allowlist, so the port does not need to match the ephemeral one.
 */
const UI_TEST_ORIGIN = 'http://127.0.0.1'

/**
 * Live-stream revocation (review HIGH-2). Sessions are re-validated on every
 * ordinary request, but an SSE stream is one request that never ends — before
 * this fix a revoked, rotated, demoted or simply expired admin kept receiving
 * approval and quarantine events for as long as the tab stayed open, which
 * contradicts the plan's guarantee that "remove/rotate/role-change immediately
 * kills that admin's live sessions" (§2).
 *
 * These tests wire the REAL server, session manager and hub together exactly as
 * `src/cli/ui-wiring` does, open a real `/events` socket, mutate the admin store
 * from the outside, and assert on the socket.
 */

class FakeHandle implements IntervalHandle {
  unref(): void {
    /* nothing to detach in a test */
  }
}

/** Captures the heartbeat callback so a "tick" is explicit, not timing-based. */
class FakeScheduler implements Scheduler {
  readonly callbacks: Array<() => void> = []

  setInterval(callback: () => void): IntervalHandle {
    this.callbacks.push(callback)
    return new FakeHandle()
  }

  clearInterval(): void {
    this.callbacks.length = 0
  }

  tick(): void {
    for (const callback of [...this.callbacks]) callback()
  }
}

function stubHandlers(hub: EventHub): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    if (key === 'events') {
      out[key] = createEventsHandler(hub)
      continue
    }
    out[key] = (ctx) => ({
      kind: 'response',
      status: 200,
      body: `handler:${key} csrf:${ctx.session?.csrfToken ?? ''}`,
    })
  }
  return out
}

const openReqs: ClientRequest[] = []

interface Started {
  readonly port: number
  readonly server: UiServer
  readonly hub: EventHub
  readonly sessions: SessionManager
  readonly scheduler: FakeScheduler
  readonly adminStore: AdminStore
  readonly tokens: Record<string, string>
  login(token: string): Promise<string>
  dispose(): Promise<void>
}

let mutableNow = Date.UTC(2026, 7, 11, 12, 0, 0)

async function startUi(sessionTtlMs = 60_000): Promise<Started> {
  const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-sse-session-'))
  const adminStore = createAdminStore({ journalDir })
  const tokens: Record<string, string> = {}
  ;({ token: tokens.owner } = await adminStore.createAdmin('owner-admin', 'owner'))
  ;({ token: tokens.operator } = await adminStore.createAdmin('op-admin', 'operator'))
  ;({ token: tokens.viewer } = await adminStore.createAdmin('view-admin', 'viewer'))

  const clock = (): number => mutableNow
  // The production wiring order: sessions → hub (probing them) → server.
  const sessions = createSessionManager({ clock, ttlMs: sessionTtlMs })
  const scheduler = new FakeScheduler()
  const hub = createEventHub({
    scheduler,
    isSessionLive: (identity) => sessions.isLive(identity.sessionId, adminStore),
  })
  sessions.onDropped((dropped) => {
    hub.closeSession(dropped.sessionId)
  })
  const server = createUiServer({ adminStore, handlers: stubHandlers(hub), sessions, clock })
  const { port } = await server.listen(0)

  async function login(token: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
      body: JSON.stringify({ token }),
      redirect: 'manual',
    })
    await res.text()
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }

  return {
    port,
    server,
    hub,
    sessions,
    scheduler,
    adminStore,
    tokens,
    login,
    dispose: async () => {
      hub.close()
      await server.close()
      rmSync(journalDir, { recursive: true, force: true })
    },
  }
}

/** Opens `/events`, resolving with the response plus a promise of its close. */
function openSse(
  port: number,
  cookie: string,
): Promise<{ res: IncomingMessage; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/events', method: 'GET', headers: { cookie } },
      (res) => {
        res.resume()
        const closed = new Promise<void>((done) => {
          res.on('end', () => done())
          res.on('close', () => done())
        })
        resolve({ res, closed })
      },
    )
    openReqs.push(req)
    req.on('error', reject)
    req.end()
  })
}

/** True when `closed` settles within `ms`; false when the stream stays open. */
function closedWithin(closed: Promise<void>, ms = 1500): Promise<boolean> {
  return Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

let started: Started | null = null

afterEach(async () => {
  for (const req of openReqs.splice(0)) req.destroy()
  await started?.dispose()
  started = null
})

describe('a live SSE stream does not outlive its session', () => {
  test('a revoked admin loses the open stream within one heartbeat', async () => {
    started = await startUi()
    const cookie = await started.login(started.tokens.operator ?? '')
    const stream = await openSse(started.port, cookie)
    expect(started.hub.subscriberCount()).toBe(1)

    await started.adminStore.removeAdmin('op-admin')
    started.scheduler.tick()
    await started.hub.sweepSessions()

    expect(await closedWithin(stream.closed)).toBe(true)
    expect(started.hub.subscriberCount()).toBe(0)
  })

  test('rotation closes exactly that admin stream; another admin keeps theirs', async () => {
    started = await startUi()
    const opCookie = await started.login(started.tokens.operator ?? '')
    const viewerCookie = await started.login(started.tokens.viewer ?? '')
    const opStream = await openSse(started.port, opCookie)
    const viewerStream = await openSse(started.port, viewerCookie)
    expect(started.hub.subscriberCount()).toBe(2)

    await started.adminStore.rotateAdmin('op-admin')
    await started.hub.sweepSessions()

    expect(await closedWithin(opStream.closed)).toBe(true)
    expect(await closedWithin(viewerStream.closed, 200)).toBe(false)
    expect(started.hub.subscriberCount()).toBe(1)
  })

  test('a role change closes that admin stream', async () => {
    started = await startUi()
    const cookie = await started.login(started.tokens.viewer ?? '')
    const stream = await openSse(started.port, cookie)

    await started.adminStore.setRole('view-admin', 'operator')
    await started.hub.sweepSessions()

    expect(await closedWithin(stream.closed)).toBe(true)
    expect(started.hub.subscriberCount()).toBe(0)
  })

  test('session TTL expiry closes the stream', async () => {
    mutableNow = Date.UTC(2026, 7, 11, 12, 0, 0)
    started = await startUi(1000)
    const cookie = await started.login(started.tokens.viewer ?? '')
    const stream = await openSse(started.port, cookie)

    mutableNow += 2000
    await started.hub.sweepSessions()

    expect(await closedWithin(stream.closed)).toBe(true)
    expect(started.hub.subscriberCount()).toBe(0)
  })

  test('an untouched live session keeps its stream across sweeps', async () => {
    started = await startUi()
    const cookie = await started.login(started.tokens.viewer ?? '')
    const stream = await openSse(started.port, cookie)

    await started.hub.sweepSessions()
    await started.hub.sweepSessions()

    expect(await closedWithin(stream.closed, 200)).toBe(false)
    expect(started.hub.subscriberCount()).toBe(1)
  })

  test('logout closes that stream immediately, without waiting for a heartbeat', async () => {
    started = await startUi()
    const cookie = await started.login(started.tokens.viewer ?? '')
    const csrfProbe = await fetch(`http://127.0.0.1:${started.port}/`, { headers: { cookie } })
    const csrf = /csrf:([^\s]*)/.exec(await csrfProbe.text())?.[1] ?? ''
    const stream = await openSse(started.port, cookie)

    const res = await fetch(`http://127.0.0.1:${started.port}/logout`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf, origin: UI_TEST_ORIGIN },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)

    expect(await closedWithin(stream.closed)).toBe(true)
    expect(started.hub.subscriberCount()).toBe(0)
  })
})
