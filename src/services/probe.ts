import { connect } from 'node:net'
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
 * caller. `fetch` in particular throws `TypeError: fetch failed` on a closed
 * port rather than resolving, so a probe that did not catch broadly would
 * turn "not started yet" into a crash in the middle of a poll loop.
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

/**
 * `ui` is ready when its login screen answers 2xx. Redirects are not followed
 * (`redirect: 'manual'`): a 302 to somewhere else is not the UI answering.
 */
export async function probeUi(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const url = `http://${hostAuthority(probeHostFor(host), port)}${UI_PROBE_PATH}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    const ok = response.ok
    // An unread body holds its socket open in the connection pool; `status`
    // polls this in a loop, so the body is cancelled rather than left behind.
    await response.body?.cancel().catch(() => undefined)
    return ok
  } catch {
    return false
  }
}

/**
 * `serve` is ready when something accepts a TCP connection on its port. It
 * answers every unauthenticated request with 401 by design, so there is no
 * HTTP status that distinguishes "up" from "up and refusing us"; accepting
 * the connection is the strongest signal available without a credential.
 */
export function probeServe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
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

    const socket = connect({ host: probeHostFor(host), port })
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    timer = setTimeout(() => settle(false), timeoutMs)
    // A pending probe must never be the reason the process stays alive
    // (`proxy/spawn.ts` precedent).
    timer.unref()
  })
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
