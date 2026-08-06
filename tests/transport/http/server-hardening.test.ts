import { afterEach, describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import { isOriginAllowed, parseRoute } from '../../../src/transport/http/routes.js'
import type { WarnSink } from '../../../src/transport/http/server.js'
import type {
  OpenSession,
  OpenedSession,
} from '../../../src/transport/http/session.js'
import {
  createFakeSessionFactory,
  startFront,
  INITIALIZE_BODY,
  type FakeSessionFactory,
  type StartedFront,
} from './front-harness.js'

/**
 * Hardening tests (M3 Task 10): route/Origin screening tables, the
 * processing order (Origin → auth → existence — no namespace scanning
 * without a token, no cross-agent visibility with one), and the 500
 * branch leaking nothing.
 */

const REQUEST_BODY = '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'

let started: StartedFront | null = null

afterEach(async () => {
  await started?.dispose()
  started = null
})

describe('parseRoute (unit)', () => {
  test('parses each supported method on the canonical path', () => {
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      expect(parseRoute(method, '/agents/bot/servers/github')).toEqual({
        method,
        agentName: 'bot',
        serverName: 'github',
      })
    }
  })

  test('ignores a query string', () => {
    expect(parseRoute('POST', '/agents/bot/servers/github?x=1')).toMatchObject({
      agentName: 'bot',
      serverName: 'github',
    })
  })

  test.each([
    ['unsupported method', 'PUT', '/agents/bot/servers/github'],
    ['missing method', undefined, '/agents/bot/servers/github'],
    ['missing url', 'POST', undefined],
    ['root', 'POST', '/'],
    ['wrong collection literal', 'POST', '/agent/bot/servers/github'],
    ['wrong nested literal', 'POST', '/agents/bot/server/github'],
    ['too few segments', 'POST', '/agents/bot/servers'],
    ['too many segments', 'POST', '/agents/bot/servers/github/extra'],
    ['trailing slash', 'POST', '/agents/bot/servers/github/'],
    ['uppercase agent name', 'POST', '/agents/Bot/servers/github'],
    ['underscore in server name', 'POST', '/agents/bot/servers/git_hub'],
    ['empty agent name', 'POST', '/agents//servers/github'],
    ['name starting with a dash', 'POST', '/agents/-bot/servers/github'],
    ['url-encoded name', 'POST', '/agents/b%6ft/servers/github'],
    ['name longer than 64 chars', 'POST', `/agents/${'a'.repeat(65)}/servers/github`],
  ])('%s → no route', (_name, method, url) => {
    expect(parseRoute(method, url)).toBeNull()
  })
})

describe('isOriginAllowed (unit)', () => {
  test('absent Origin header is allowed (non-browser agents)', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true)
  })

  test.each([
    'http://localhost',
    'http://localhost:3000',
    'https://localhost:8443',
    'http://127.0.0.1',
    'http://127.0.0.1:8090',
    'https://127.0.0.1',
    'http://[::1]:8090',
    'https://[::1]',
  ])('localhost origin %s is allowed by default', (origin) => {
    expect(isOriginAllowed(origin, [])).toBe(true)
  })

  test.each([
    'http://evil.example.com',
    'https://localhost.evil.com',
    'http://127.0.0.2',
    'null',
    'file:///etc/passwd',
    'ws://localhost',
    'not a url',
  ])('non-localhost origin %s is rejected', (origin) => {
    expect(isOriginAllowed(origin, [])).toBe(false)
  })

  test('an exact-match extra allowlist entry is allowed — and only exactly', () => {
    const extra = ['https://admin.example.com']

    expect(isOriginAllowed('https://admin.example.com', extra)).toBe(true)
    expect(isOriginAllowed('https://admin.example.com:444', extra)).toBe(false)
    expect(isOriginAllowed('http://admin.example.com', extra)).toBe(false)
  })
})

describe('Origin screening over HTTP (403 before everything)', () => {
  test('a disallowed Origin answers 403 even with a valid token', async () => {
    started = await startFront()

    const response = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { origin: 'http://evil.example.com' },
    })

    expect(response.status).toBe(403)
    expect(await response.text()).toBe('{"error":"forbidden"}')
    expect(started.factory.handles).toHaveLength(0)
  })

  test('a disallowed Origin without any token still answers 403, not 401', async () => {
    started = await startFront()

    const response = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { origin: 'http://evil.example.com' },
      noAuth: true,
    })

    expect(response.status).toBe(403)
  })

  test('a localhost Origin passes through to normal handling', async () => {
    started = await startFront()

    const response = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.status).toBe(200)
  })

  test('opts.allowedOrigins extends the allowlist', async () => {
    started = await startFront({ allowedOrigins: ['https://admin.example.com'] })

    const response = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { origin: 'https://admin.example.com' },
    })

    expect(response.status).toBe(200)
  })
})

describe('authentication over HTTP: uniform 401, auth before existence', () => {
  async function bodyOf(response: Response): Promise<string> {
    expect(response.status).toBe(401)
    return response.text()
  }

  test('no token, garbage header, unknown token and revoked token get byte-identical 401 bodies', async () => {
    started = await startFront()
    const revoked = await started.agentsStore.createAgent('doomed')
    await started.agentsStore.revokeAgent('doomed')

    const bodies = await Promise.all([
      bodyOf(await started.call('POST', started.path(), { body: REQUEST_BODY, noAuth: true })),
      bodyOf(
        await started.call('POST', started.path(), {
          body: REQUEST_BODY,
          noAuth: true,
          headers: { authorization: 'garbage' },
        }),
      ),
      bodyOf(
        await started.call('POST', started.path(), {
          body: REQUEST_BODY,
          noAuth: true,
          headers: { authorization: 'Bearer mcpj_who-knows' },
        }),
      ),
      bodyOf(
        await started.call('POST', started.path(), {
          body: REQUEST_BODY,
          noAuth: true,
          headers: { authorization: `Bearer ${revoked.token}` },
        }),
      ),
    ])

    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe('{"error":"unauthorized"}')
    expect(started.factory.handles).toHaveLength(0)
  })

  test('an unauthenticated request to a NON-existent route still answers 401 (no scanning without a token)', async () => {
    started = await startFront()

    const missingRoute = await started.call('POST', '/agents/ghost/servers/nothing', {
      body: REQUEST_BODY,
      noAuth: true,
    })
    const brokenRoute = await started.call('POST', '/definitely/not/a/route', {
      body: REQUEST_BODY,
      noAuth: true,
    })

    expect(missingRoute.status).toBe(401)
    expect(brokenRoute.status).toBe(401)
  })

  test("a valid token cannot reach ANOTHER agent's path — 404, indistinguishable from a missing agent", async () => {
    started = await startFront()
    await started.agentsStore.createAgent('second-agent')

    const existing = await started.call('POST', started.path('second-agent'), {
      body: REQUEST_BODY,
    })
    const missing = await started.call('POST', started.path('no-such-agent'), {
      body: REQUEST_BODY,
    })

    expect(existing.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await existing.text()).toBe(await missing.text())
    expect(started.factory.handles).toHaveLength(0)
  })

  test('an authenticated request to an unparseable route answers 404', async () => {
    started = await startFront()

    const response = await started.call('POST', '/agents/bot/servers/github/extra', {
      body: REQUEST_BODY,
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"error":"not-found"}')
  })

  test('a supported-path request with an unrouted method (PUT) answers 404', async () => {
    started = await startFront()

    const response = await started.call('PUT', started.path(), { body: REQUEST_BODY })

    expect(response.status).toBe(404)
  })
})

describe('500 branch hygiene', () => {
  test('an exploding session factory yields a detail-free 500 and a diagnostic stderr line', async () => {
    const lines: string[] = []
    const stderr: WarnSink = {
      write: (chunk: string) => {
        lines.push(chunk)
        return true
      },
    }
    const marker = 'MARKER_INTERNAL_DETAILS_x91'
    started = await startFront(
      { stderr },
      createFakeSessionFactory({ throwError: new Error(marker) }),
    )

    const response = await started.call('POST', started.path(), { body: REQUEST_BODY })
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toBe('{"error":"internal"}')
    expect(body).not.toContain(marker)
    expect(lines.join('')).toContain('[http] request handler failed')
  })

  test('the 500 stderr line never contains request bodies, headers or the token', async () => {
    const lines: string[] = []
    const stderr: WarnSink = {
      write: (chunk: string) => {
        lines.push(chunk)
        return true
      },
    }
    started = await startFront(
      { stderr },
      createFakeSessionFactory({ throwError: new Error('boom') }),
    )
    const secretBody = '{"secret":"BODY_MARKER_77"}'

    await started.call('POST', started.path(), {
      body: secretBody,
      headers: { 'x-custom': 'HEADER_MARKER_88' },
    })

    const logged = lines.join('')
    expect(logged).not.toContain('BODY_MARKER_77')
    expect(logged).not.toContain('HEADER_MARKER_88')
    expect(logged).not.toContain(started.token)
  })

  test('a session error names the failure class and message, and nothing else', async () => {
    const lines: string[] = []
    const stderr: WarnSink = {
      write: (chunk: string) => {
        lines.push(chunk)
        return true
      },
    }
    const base = createFakeSessionFactory()
    const failingClose: OpenSession = async (ctx) => {
      const opened = await base.openSession(ctx)
      if ('error' in opened) return opened
      const wrapped: OpenedSession = {
        sink: opened.sink,
        source: opened.source,
        close: () => Promise.reject(new Error('CLOSE_MARKER_42')),
      }
      return wrapped
    }
    const factory: FakeSessionFactory = { openSession: failingClose, handles: base.handles }
    started = await startFront({ stderr }, factory)

    const init = await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    const sessionId = init.headers.get('mcp-session-id') ?? ''
    await started.call('DELETE', started.path(), { headers: { 'mcp-session-id': sessionId } })

    const logged = lines.join('')
    expect(logged).toContain('Error: CLOSE_MARKER_42')
    expect(logged).toContain(sessionId)
    expect(logged).not.toContain(started.token)
  })

  test('an initialize that explodes mid-handshake leaves no half-open session behind', async () => {
    started = await startFront(
      { stderr: { write: () => true } },
      createFakeSessionFactory({ throwError: new Error('handshake-explosion') }),
    )

    const response = await started.call('POST', started.path(), { body: INITIALIZE_BODY })

    expect(response.status).toBe(500)
    const followUp = await started.call('POST', started.path(), { body: REQUEST_BODY })
    expect(followUp.status).toBe(500)
  })
})

describe('abandoned requests free their upstream', () => {
  test('a client that aborts a stateless POST does not leave the session open', async () => {
    // The factory never answers: only the abort can end this request.
    started = await startFront({}, createFakeSessionFactory({ respond: () => null }))
    const controller = new AbortController()

    const inFlight = fetch(`${started.baseUrl}${started.path()}`, {
      method: 'POST',
      body: REQUEST_BODY,
      headers: { authorization: `Bearer ${started.token}` },
      signal: controller.signal,
    })
    inFlight.catch(() => undefined)
    const front = started
    await waitUntil(() => front.factory.handles.length === 1)
    controller.abort()

    await waitUntil(() => front.factory.handles[0]?.isClosed() === true)
    expect(front.factory.handles[0]?.isDisposed()).toBe(true)
  })
})
