import { type ClientRequest, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { MAX_TCP_PORT } from '../cli/serve-constants.js'
import { hostAuthority, unbracketHost } from './authority.js'
import {
  PROBE_TIMEOUT_MS,
  UI_PROBE_PATH,
  WILDCARD_PROBE_HOSTS,
  type ServiceName,
} from './constants.js'

/**
 * Readiness probes of the service manager (mcpcut phase 1, Task 8).
 *
 * "Is the service running" is deliberately not answered by a live pid alone:
 * a process that is up but wedged before `listen()` is not something an
 * operator can use, and a pid that got reused by an unrelated program is not
 * the service at all. So the manager pairs a live pid with an answer on the
 * port, and these two functions are that answer — the same two questions the
 * compose healthchecks ask (`GET /login` for the admin UI, a TCP connect for
 * the HTTP front, which refuses unauthenticated requests by design and so has
 * no unauthenticated 2xx to look for).
 *
 * Every failure mode collapses to `false`. That is not swallowing an error:
 * "did not answer" is the whole result these functions produce, and a
 * connection refused, a DNS failure and a timeout are the same answer to the
 * caller. A socket error on a closed port is an `error` event, not a value,
 * so a probe that did not listen for it broadly would turn "not started yet"
 * into a crash in the middle of a poll loop.
 */

/**
 * The address a probe should dial for a service bound to `host`.
 *
 * Only wildcard addresses are rewritten (to loopback) — see
 * `WILDCARD_PROBE_HOSTS` for why a concrete address must be dialled as given.
 */
export function probeHostFor(host: string): string {
  // Unbracketed first: `[::]` and `::` are the same bind address written two
  // ways, and only one of them would ever match the wildcard map (review
  // SEC-L3). What comes back is a bare address — `connect` wants it bare, and
  // `hostAuthority` puts the brackets back for the URL.
  const address = unbracketHost(host)
  return WILDCARD_PROBE_HOSTS.get(address) ?? address
}

/** The name the UI probe puts in `Host`; see `probeUi` for why it is not the dialled address. */
const UI_PROBE_HOST_HEADER_NAME = 'localhost'

/** The 2xx range, as `[min, end)`: the only statuses that mean the login screen answered. */
const HTTP_OK_MIN = 200
const HTTP_OK_END = 300

/**
 * `ui` is ready when its login screen answers 2xx. Redirects are not followed
 * — `node:http` never follows one — and a 3xx is not ok: a redirect to
 * somewhere else is not the UI answering.
 *
 * WHY `Host: localhost:<port>` whatever address is dialled (Q32): a UI bound
 * to a wildcard admits only localhost names and its `--allowed-host` list in
 * `Host` (`isHostAllowed`, `src/net/origin-host.ts`). Inside compose the probe
 * dials the neighbour by its service name, and `Host: ui:8091` would read 403
 * — a healthy UI reported stopped. The probe is not a browser, carries no
 * credential and only asks for the public `GET /login`, so naming loopback in
 * `Host` opens nothing to it that the route did not already show.
 *
 * `node:http` rather than `fetch`: undici does not reliably let a caller set
 * `Host`. `agent: false` keeps the socket out of a keep-alive pool, which
 * `status` polling in a loop would otherwise fill.
 */
export function probeUi(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!isDialablePort(port)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (answer: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // The status line is the whole answer; the connection is not wanted.
      req.destroy()
      resolve(answer)
    }

    let req: ClientRequest
    try {
      req = request({
        host: probeHostFor(host),
        port,
        path: UI_PROBE_PATH,
        method: 'GET',
        headers: { host: hostAuthority(UI_PROBE_HOST_HEADER_NAME, port) },
        agent: false,
      })
    } catch {
      // Anything `request` throws rather than emits would otherwise reject
      // the probe from inside the executor instead of answering "did not
      // answer". A bad port never gets here: `isDialablePort` turned it away.
      resolve(false)
      return
    }
    req.once('response', (res) => {
      const status = res.statusCode ?? 0
      // Drain rather than leave the body unread: an unread body holds its socket.
      res.resume()
      settle(status >= HTTP_OK_MIN && status < HTTP_OK_END)
    })
    req.once('error', () => settle(false))
    req.end()
    timer = setTimeout(() => settle(false), timeoutMs)
    // A pending probe must never be the reason the process stays alive.
    timer.unref()
  })
}

/**
 * `serve` is ready when something accepts a TCP connection on its port. It
 * answers every unauthenticated request with 401 by design, so there is no
 * HTTP status that distinguishes "up" from "up and refusing us"; accepting
 * the connection is the strongest signal available without a credential.
 */
export function probeServe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!isDialablePort(port)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (answer: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // Destroy on the success path too: the probe wants the fact of the
      // connection, not the connection.
      socket.destroy()
      resolve(answer)
    }

    let socket: Socket
    try {
      socket = connect({ host: probeHostFor(host), port })
    } catch {
      // Same as `probeUi`: a synchronous throw is "did not answer" too.
      resolve(false)
      return
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    timer = setTimeout(() => settle(false), timeoutMs)
    // A pending probe must never be the reason the process stays alive
    // (`proxy/spawn.ts` precedent).
    timer.unref()
  })
}

/**
 * A port `node:net` will dial. Checked BEFORE `request`/`connect`, not only
 * caught after: Node opens the socket handle and only then validates the
 * port, so a port outside 0–65535 (a hand-edited config) throws
 * `ERR_SOCKET_BAD_PORT` and strands that handle — a leak per `status` call in
 * a poll loop. A port nothing can listen on is simply "did not answer".
 */
function isDialablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= MAX_TCP_PORT
}

/** Dispatches to the probe that fits the service. */
export function probeService(
  service: ServiceName,
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return service === 'ui' ? probeUi(host, port, timeoutMs) : probeServe(host, port, timeoutMs)
}
