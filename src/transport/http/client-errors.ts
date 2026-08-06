/**
 * Typed errors of the HTTP upstream client (`./client.ts`). Split out of the
 * factory module purely for the < 400-lines-per-file rule; the public import
 * surface stays `client.ts`, which re-exports everything here.
 *
 * Error hygiene invariant (CLAUDE.md: secrets never reach the journal):
 * messages carry only the HTTP status, the request method, and the target
 * HOST — never a path or query (may embed tokens), never header values,
 * never bodies. The original low-level error travels as `cause` and Node's
 * network errors contain at most address/port.
 */

/** Non-2xx upstream answer that has no dedicated meaning for the client. */
export class UpstreamHttpStatusError extends Error {
  readonly status: number
  constructor(method: string, status: number, host: string) {
    super(`upstream ${host} answered ${method} with HTTP ${status}`)
    this.name = 'UpstreamHttpStatusError'
    this.status = status
  }
}

/**
 * 404 while a session id was active: the upstream expired the session. The
 * spec tells clients to start a new session; the control plane is a
 * pass-through, so the client only reports — the caller decides (Task 9
 * brief: no silent re-initialize).
 */
export class SessionExpiredError extends Error {
  constructor(host: string) {
    super(`upstream ${host} no longer knows the active session (HTTP 404): session expired`)
    this.name = 'SessionExpiredError'
  }
}

/** The connection itself failed (refused, reset, DNS, ...). */
export class UpstreamConnectionError extends Error {
  constructor(method: string, host: string, cause: unknown) {
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : 'unknown error'
    super(`${method} request to upstream ${host} failed: ${code}`, { cause })
    this.name = 'UpstreamConnectionError'
  }
}

/** A 2xx response the client cannot interpret (content type, size). */
export class UpstreamResponseError extends Error {
  constructor(host: string, reason: string) {
    super(`unusable response from upstream ${host}: ${reason}`)
    this.name = 'UpstreamResponseError'
  }
}

/** The GET-SSE stream could not be re-established within the attempt budget. */
export class SseStreamError extends Error {
  constructor(host: string, attempts: number, cause: unknown) {
    super(
      `server-initiated SSE stream to upstream ${host} lost after ${attempts} reconnect attempts`,
      { cause },
    )
    this.name = 'SseStreamError'
  }
}
