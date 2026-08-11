import { request } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import {
  isHostAllowed,
  isOriginAllowed,
  LOCALHOST_HOSTNAMES,
} from '../../src/net/origin-host.js'
import { startFront, type StartedFront } from '../transport/http/front-harness.js'

/**
 * M4 Task 1: shared origin/host screening module (`src/net/origin-host.ts`)
 * and Host validation on the agent-facing HTTP front (M3 backlog: DNS
 * rebinding defense must cover Host, not just Origin).
 *
 * The over-HTTP tests use `node:http` directly because `fetch` treats
 * `Host` as a forbidden header and silently drops overrides.
 */

const REQUEST_BODY = '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'
const BOUND = { boundHost: '127.0.0.1', port: 8090, extraAllowed: [] as readonly string[] }

// ---------------------------------------------------------------------------
// isHostAllowed (unit, pure)
// ---------------------------------------------------------------------------

describe('isHostAllowed (unit)', () => {
  test('absent Host header is rejected (HTTP/1.1 requires one; fail closed)', () => {
    expect(isHostAllowed(undefined, BOUND)).toBe(false)
  })

  test.each([
    '127.0.0.1:8090',
    'localhost:8090',
    'LOCALHOST:8090',
    '[::1]:8090',
  ])('localhost form %s with the bound port is allowed', (header) => {
    expect(isHostAllowed(header, BOUND)).toBe(true)
  })

  test.each([
    'evil.com:8090',
    'evil.com',
    'localhost.evil.com:8090',
    '127.0.0.2:8090',
  ])('foreign host %s is rejected (DNS rebinding form)', (header) => {
    expect(isHostAllowed(header, BOUND)).toBe(false)
  })

  test.each([
    '127.0.0.1:8091',
    'localhost:1',
    '127.0.0.1',
  ])('%s with a port different from the bound one is rejected', (header) => {
    expect(isHostAllowed(header, BOUND)).toBe(false)
  })

  test('a portless Host matches the HTTP default port 80', () => {
    const onPort80 = { ...BOUND, port: 80 }

    expect(isHostAllowed('127.0.0.1', onPort80)).toBe(true)
    expect(isHostAllowed('127.0.0.1:80', onPort80)).toBe(true)
    expect(isHostAllowed('localhost', onPort80)).toBe(true)
  })

  test('the bound host itself is allowed even when it is not a localhost name', () => {
    const bound = { boundHost: '192.168.0.5', port: 8090, extraAllowed: [] }

    expect(isHostAllowed('192.168.0.5:8090', bound)).toBe(true)
    expect(isHostAllowed('192.168.0.6:8090', bound)).toBe(false)
    // Loopback names stay allowed regardless of the bound host.
    expect(isHostAllowed('127.0.0.1:8090', bound)).toBe(true)
  })

  test('an IPv6 bound host matches its bracketed Host form', () => {
    const bound = { boundHost: '::1', port: 8090, extraAllowed: [] }

    expect(isHostAllowed('[::1]:8090', bound)).toBe(true)
  })

  test('an extraAllowed entry (reverse-proxy name) matches exactly — and only exactly', () => {
    const bound = { ...BOUND, extraAllowed: ['mcp.internal.example'] }

    expect(isHostAllowed('mcp.internal.example', bound)).toBe(true)
    expect(isHostAllowed('mcp.internal.example:8443', bound)).toBe(false)
    expect(isHostAllowed('other.internal.example', bound)).toBe(false)
  })

  test.each([
    '',
    'not a host',
    '127.0.0.1:8090/path',
    'user@127.0.0.1:8090',
    '127.0.0.1:8090?x=1',
    '127.0.0.1:8090#frag',
    'http://127.0.0.1:8090',
  ])('malformed Host %j is rejected', (header) => {
    expect(isHostAllowed(header, BOUND)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isOriginAllowed (unit — behavior preserved after the move out of routes.ts)
// ---------------------------------------------------------------------------

describe('isOriginAllowed (unit, relocated module)', () => {
  test('absent Origin is allowed (non-browser agents)', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true)
  })

  test('localhost origins pass, foreign ones do not', () => {
    expect(isOriginAllowed('http://localhost:5173', [])).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:8090', [])).toBe(true)
    expect(isOriginAllowed('http://evil.example.com', [])).toBe(false)
    expect(isOriginAllowed('null', [])).toBe(false)
  })

  test('extra allowlist entries match exactly', () => {
    expect(isOriginAllowed('https://admin.example.com', ['https://admin.example.com'])).toBe(true)
    expect(isOriginAllowed('https://admin.example.com:444', ['https://admin.example.com'])).toBe(
      false,
    )
  })

  test('the localhost hostname list covers IPv4, IPv6 and the name', () => {
    for (const name of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(LOCALHOST_HOSTNAMES).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// Host screening over HTTP (403 before authentication, uniform body)
// ---------------------------------------------------------------------------

interface RawResponse {
  readonly status: number
  readonly body: string
}

/** `node:http` POST with full control over the Host header (`null` = omit). */
function rawPost(
  started: StartedFront,
  hostHeader: string | null,
  opts: { readonly noAuth?: boolean } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: started.port,
        path: started.path(),
        method: 'POST',
        setHost: false,
        headers: {
          ...(hostHeader === null ? {} : { host: hostHeader }),
          ...(opts.noAuth === true ? {} : { authorization: `Bearer ${started.token}` }),
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(REQUEST_BODY)
  })
}

/**
 * Raw HTTP/1.0 POST with NO Host header at all: `node:http` cannot send
 * one (it either adds Host or, without it, Node's 1.1 guard answers 400),
 * so the request is written straight onto a socket.
 */
function rawHttp10PostWithoutHost(started: StartedFront): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: started.port })
    const chunks: Buffer[] = []
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0)
      const bodyStart = raw.indexOf('\r\n\r\n')
      resolve({ status, body: bodyStart === -1 ? '' : raw.slice(bodyStart + 4) })
    })
    socket.on('connect', () => {
      socket.write(
        `POST ${started.path()} HTTP/1.0\r\n` +
          `Authorization: Bearer ${started.token}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(REQUEST_BODY)}\r\n` +
          '\r\n' +
          REQUEST_BODY,
      )
    })
  })
}

describe('Host screening over HTTP', () => {
  let started: StartedFront | null = null

  afterEach(async () => {
    await started?.dispose()
    started = null
  })

  test('Host: evil.com on a 127.0.0.1 bind answers 403 even with a valid token', async () => {
    started = await startFront()

    const response = await rawPost(started, 'evil.com')

    expect(response.status).toBe(403)
    expect(response.body).toBe('{"error":"forbidden"}')
    expect(started.factory.handles).toHaveLength(0)
  })

  test('Host: evil.com without any token still answers 403, not 401 (before auth)', async () => {
    started = await startFront()

    const response = await rawPost(started, 'evil.com', { noAuth: true })

    expect(response.status).toBe(403)
    expect(response.body).toBe('{"error":"forbidden"}')
  })

  test('the Host refusal is byte-identical to the Origin refusal (no oracle)', async () => {
    started = await startFront()

    const hostRefusal = await rawPost(started, 'evil.com', { noAuth: true })
    const originRefusal = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { origin: 'http://evil.example.com' },
      noAuth: true,
    })

    expect(hostRefusal.status).toBe(403)
    expect(originRefusal.status).toBe(403)
    expect(hostRefusal.body).toBe(await originRefusal.text())
  })

  test('Host with the bound address and port passes through to normal handling', async () => {
    started = await startFront()

    const response = await rawPost(started, `127.0.0.1:${started.port}`)

    expect(response.status).toBe(200)
  })

  test('Host: localhost:<bound port> passes on a 127.0.0.1 bind', async () => {
    started = await startFront()

    const response = await rawPost(started, `localhost:${started.port}`)

    expect(response.status).toBe(200)
  })

  test('a Host-less HTTP/1.1 request is refused by Node itself (400) before any handling', async () => {
    // Node's `requireHostHeader` answers 400 ahead of our handler for
    // HTTP/1.1 (which mandates Host); our own fail-closed branch is the
    // second layer, exercised over the wire in the HTTP/1.0 test below.
    started = await startFront()

    const response = await rawPost(started, null)

    expect(response.status).toBe(400)
    expect(started.factory.handles).toHaveLength(0)
  })

  test('a Host-less HTTP/1.0 request reaches our check and answers 403', async () => {
    started = await startFront()

    const response = await rawHttp10PostWithoutHost(started)

    expect(response.status).toBe(403)
    expect(response.body).toBe('{"error":"forbidden"}')
    expect(started.factory.handles).toHaveLength(0)
  })

  test('Host with a port different from the bound one answers 403', async () => {
    started = await startFront()

    const response = await rawPost(started, `127.0.0.1:${started.port + 1}`)

    expect(response.status).toBe(403)
  })

  test('opts.allowedHosts admits a reverse-proxy name exactly', async () => {
    started = await startFront({ allowedHosts: ['mcp.internal.example'] })

    const allowed = await rawPost(started, 'mcp.internal.example')
    const other = await rawPost(started, 'other.internal.example')

    expect(allowed.status).toBe(200)
    expect(other.status).toBe(403)
  })
})
