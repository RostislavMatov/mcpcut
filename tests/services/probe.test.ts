import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { PROBE_TIMEOUT_MS } from '../../src/services/constants.js'
import { hostAuthority } from '../../src/services/authority.js'
import { probeHostFor, probeService, probeServe, probeUi } from '../../src/services/probe.js'

/**
 * The readiness probes of the service manager (mcpcut phase 1, Task 8) — the
 * same two questions the compose healthchecks ask: does `ui` answer `GET
 * /login` with a 2xx, and does something accept a TCP connection on `serve`'s
 * port. Real sockets throughout: a probe whose only proof is a mock has not
 * been shown to survive `fetch`'s habit of throwing on a closed port.
 */

/** Short deadline for the negative cases so a failing probe cannot stall the suite. */
const FAST_TIMEOUT_MS = 500

/** One past the last TCP port: the socket layer refuses it before dialling. */
const OUT_OF_RANGE_PORT = 70_000

/**
 * How long a leak check waits for the count to come back down. The probe owns
 * only its own end of the connection: the server's accepted socket closes a
 * tick or two later, and under a loaded suite that lag once failed the check
 * that this file is actually about. Waiting for the count to settle keeps the
 * assertion about a leak, not about scheduling.
 */
const SETTLE_TIMEOUT_MS = 2_000
const SETTLE_POLL_MS = 10

/** Fails unless the active-resource count drops back to `before` within the deadline. */
async function expectResourcesSettled(before: number): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  let after = process.getActiveResourcesInfo().length
  while (after > before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
    after = process.getActiveResourcesInfo().length
  }
  expect(after).toBeLessThanOrEqual(before)
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

function onDispose(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function closeNet(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/** Starts an HTTP server that answers `/login` with `status`; returns its ephemeral port. */
async function startHttp(status: number): Promise<number> {
  const server = createHttpServer((req, res) => {
    res.writeHead(req.url === '/login' ? status : 404)
    res.end()
  })
  onDispose(() => closeHttp(server))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

/**
 * Starts a bare TCP listener; returns its ephemeral port. Accepted sockets
 * are destroyed rather than half-closed: an HTTP client's keep-alive pool
 * would hold a half-closed socket open and `close()` would never resolve.
 */
async function startTcp(): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.destroy()
  })
  onDispose(async () => {
    for (const socket of sockets) socket.destroy()
    await closeNet(server)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

/** Reserves an ephemeral port and immediately gives it back, so nothing listens on it. */
async function closedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await closeNet(server)
  return port
}

describe('probeHostFor', () => {
  test('maps the IPv4 wildcard to loopback, because nothing can connect to 0.0.0.0', () => {
    expect(probeHostFor('0.0.0.0')).toBe('127.0.0.1')
  })

  test('maps both spellings of the IPv6 wildcard to loopback', () => {
    expect(probeHostFor('::')).toBe('::1')
    expect(probeHostFor('::0')).toBe('::1')
  })

  test('leaves a concrete address alone — a service bound to it does not listen on loopback', () => {
    expect(probeHostFor('10.0.0.5')).toBe('10.0.0.5')
    expect(probeHostFor('127.0.0.1')).toBe('127.0.0.1')
    expect(probeHostFor('::1')).toBe('::1')
    expect(probeHostFor('localhost')).toBe('localhost')
  })
})

describe('probeUi', () => {
  test('is true when /login answers 200', async () => {
    const port = await startHttp(200)

    expect(await probeUi('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(true)
  })

  test('is false when /login answers 500 — a listening but broken service is not ready', async () => {
    const port = await startHttp(500)

    expect(await probeUi('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(false)
  })

  test('is false, not a rejection, when nothing listens on the port', async () => {
    const port = await closedPort()
    const startedAt = Date.now()

    expect(await probeUi('127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(FAST_TIMEOUT_MS * 4)
  })

  test('is false when the answer does not arrive before the timeout', async () => {
    const server = createHttpServer(() => {
      // Never answers: the probe's own deadline has to end this.
    })
    onDispose(() => closeHttp(server))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo

    expect(await probeUi('127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
  })

  test('reaches a service bound to the IPv4 wildcard via loopback', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(req.url === '/login' ? 200 : 404)
      res.end()
    })
    onDispose(() => closeHttp(server))
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()))
    const { port } = server.address() as AddressInfo

    expect(await probeUi('0.0.0.0', port, PROBE_TIMEOUT_MS)).toBe(true)
  })
})

describe('probeUi through the UI Host screen (Q32)', () => {
  /**
   * The UI bound to a wildcard admits only localhost names in `Host`
   * (`src/net/origin-host.ts`), so a probe that sent `Host: ui:8091` from the
   * neighbour container would read 403 and call a healthy UI stopped.
   */
  async function startHostScreenedUi(): Promise<{ readonly port: number; readonly seen: string[] }> {
    const seen: string[] = []
    const server = createHttpServer((req, res) => {
      const address = server.address() as AddressInfo
      seen.push(req.headers.host ?? '')
      const allowed = req.headers.host === `localhost:${address.port}`
      res.writeHead(req.url === '/login' && allowed ? 200 : 403)
      res.end()
    })
    onDispose(() => closeHttp(server))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return { port: (server.address() as AddressInfo).port, seen }
  }

  test('sends Host: localhost:<port> whatever address it dials, so a Host-screened UI answers 200', async () => {
    const ui = await startHostScreenedUi()

    expect(await probeUi('127.0.0.1', ui.port, PROBE_TIMEOUT_MS)).toBe(true)
    expect(ui.seen).toEqual([`localhost:${ui.port}`])
  })

  test('a redirect is not the UI answering: 302 is false and is not followed', async () => {
    const hits: string[] = []
    const server = createHttpServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(req.url === '/login' ? 302 : 200, { location: '/elsewhere' })
      res.end()
    })
    onDispose(() => closeHttp(server))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo

    expect(await probeUi('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(false)
    expect(hits).toEqual(['/login'])
  })

  test('leaves no socket or timer behind after a successful probe', async () => {
    const port = await startHttp(200)
    const before = process.getActiveResourcesInfo().length

    expect(await probeUi('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(true)

    await expectResourcesSettled(before)
  })

  test('is false, not a rejection, when the host name does not resolve', async () => {
    expect(await probeUi('no-such-service.invalid', 8091, FAST_TIMEOUT_MS)).toBe(false)
  })

  /**
   * `http.request` validates the port synchronously (`ERR_SOCKET_BAD_PORT`),
   * inside the Promise executor — a hand-edited config must not turn
   * `status` into a crash. Nor into a leak: Node opens the socket handle
   * BEFORE it validates the port, so a throw would strand that handle.
   */
  test.each([OUT_OF_RANGE_PORT, -1])('is false, not a rejection, for the invalid port %i', async (port) => {
    const before = process.getActiveResourcesInfo().length

    await expect(probeUi('127.0.0.1', port, FAST_TIMEOUT_MS)).resolves.toBe(false)

    await expectResourcesSettled(before)
  })
})

describe('probeServe', () => {
  test('is true when a TCP listener accepts the connection', async () => {
    const port = await startTcp()

    expect(await probeServe('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(true)
  })

  test('is false when the port is closed', async () => {
    const port = await closedPort()

    expect(await probeServe('127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
  })

  test.each([OUT_OF_RANGE_PORT, -1])('is false, not a rejection, for the invalid port %i', async (port) => {
    const before = process.getActiveResourcesInfo().length

    await expect(probeServe('127.0.0.1', port, FAST_TIMEOUT_MS)).resolves.toBe(false)

    await expectResourcesSettled(before)
  })

  test('leaves no socket behind after a successful probe', async () => {
    const port = await startTcp()
    const before = process.getActiveResourcesInfo().length

    expect(await probeServe('127.0.0.1', port, PROBE_TIMEOUT_MS)).toBe(true)

    // The probe must destroy its socket and clear its timer, or `mcpcut
    // status` in a poll loop would leak a handle per call.
    await expectResourcesSettled(before)
  })
})

describe('probeService', () => {
  test('asks ui for /login and is satisfied by a 200', async () => {
    const port = await startHttp(200)

    expect(await probeService('ui', '127.0.0.1', port)).toBe(true)
  })

  test('is not satisfied by a bare TCP listener when the service is ui', async () => {
    const port = await startTcp()

    expect(await probeService('ui', '127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
  })

  test('is satisfied by a bare TCP listener when the service is serve', async () => {
    const port = await startTcp()

    expect(await probeService('serve', '127.0.0.1', port)).toBe(true)
  })

  test('is false for either service when nothing listens', async () => {
    const port = await closedPort()

    expect(await probeService('ui', '127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
    expect(await probeService('serve', '127.0.0.1', port, FAST_TIMEOUT_MS)).toBe(false)
  })
})

describe('bracketed IPv6 literals (an operator writes both spellings)', () => {
  test('brackets a bare IPv6 address exactly once', () => {
    expect(hostAuthority('::1', 8091)).toBe('[::1]:8091')
  })

  test('does not bracket an address that is already bracketed', () => {
    // `http://[[::1]]:8091` is not a URL: the config spelling `[::1]` is as
    // legitimate as `::1`, and both have to reach the same authority.
    expect(hostAuthority('[::1]', 8091)).toBe('[::1]:8091')
  })

  test('leaves an IPv4 address and a hostname alone', () => {
    expect(hostAuthority('127.0.0.1', 8090)).toBe('127.0.0.1:8090')
    expect(hostAuthority('console.example', 80)).toBe('console.example:80')
  })

  test('rewrites a bracketed IPv6 wildcard to loopback, as it does the bare one', () => {
    expect(probeHostFor('[::]')).toBe('::1')
    expect(probeHostFor('::')).toBe('::1')
  })

  test('dials a bracketed loopback literal as the address it names', () => {
    expect(probeHostFor('[::1]')).toBe('::1')
  })
})
