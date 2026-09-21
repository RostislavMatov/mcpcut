import {
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
  UpstreamResponseError,
} from '../transport/http/client.js'
import { EmbeddedNewlineError } from '../transport/stdio-adapter.js'

/**
 * What a bridge failure MEANS (ADR-0015, plan task 3): one pure function
 * over the typed errors of `transport/http/client.ts`, and the single place
 * that decides whether the bridge keeps running.
 *
 * The distinction is the one ADR-0014 paid for: **a network failure is not a
 * revoked token.** The remote console used to read a dropped connection as a
 * lost session and throw the operator back to a sign-in screen; here the same
 * mistake would tear down an agent's whole MCP session over one dropped
 * packet. So a blip costs the request it hit — the caller answers that one
 * request with an error — and only an answer the SERVICE gave ends the
 * bridge.
 *
 * Error-text hygiene: `detail` carries the message of a TYPED client error
 * only. Those are built by `client-errors.ts` from a status, a method and a
 * host, and by construction contain no path, header or body — which is what
 * makes them safe to print. An error of any other shape gets a fixed string
 * instead of its own text: `String(error)` could be anything, including a
 * URL with a token in it that `node:http` put in a `cause`.
 */

export type BridgeFailure =
  /** 401: the service did not accept this token. Fatal. */
  | { readonly kind: 'unauthorized' }
  /** 403: Host/Origin screening refused the request. Fatal. */
  | { readonly kind: 'forbidden' }
  /** 404 with no session yet: nothing is served at this address for this token. Fatal. */
  | { readonly kind: 'no-endpoint' }
  /** The service forgot the session; a fresh bridge would get a fresh one. Fatal. */
  | { readonly kind: 'session-expired' }
  /** The server-initiated stream did not come back within its budget. Fatal. */
  | { readonly kind: 'stream-lost' }
  /** The connection itself failed. Costs one request. */
  | { readonly kind: 'network'; readonly detail: string }
  /** Any other non-2xx answer (409, 413, 429, 5xx). Costs one request. */
  | { readonly kind: 'service'; readonly status: number }
  /** An answer, or an outgoing message, that could not be handled. Costs one request. */
  | { readonly kind: 'protocol'; readonly detail: string }

/**
 * The failures that END the bridge, as a type rather than as a convention.
 * Extracted so `BridgeEnd`'s fatal payload and the caller's switch over it are
 * both checked by the compiler: a new fatal kind added to the union but not to
 * `reportEnd` used to fall into its `default` and be reported as a lost
 * stream, with the wrong message and the wrong exit code, silently (TS review
 * 2026-09-21, MEDIUM).
 */
export type FatalBridgeFailure = Extract<
  BridgeFailure,
  { kind: 'unauthorized' | 'forbidden' | 'no-endpoint' | 'session-expired' | 'stream-lost' }
>

const HTTP_STATUS_UNAUTHORIZED = 401
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_NOT_FOUND = 404

/** The one detail an untyped error earns: its shape is unknown, so its text is too. */
const UNKNOWN_DETAIL = 'unexpected failure'

/** The status codes that mean the SERVICE judged this bridge, rather than stumbled. */
function verdictOf(status: number): BridgeFailure {
  if (status === HTTP_STATUS_UNAUTHORIZED) return { kind: 'unauthorized' }
  if (status === HTTP_STATUS_FORBIDDEN) return { kind: 'forbidden' }
  if (status === HTTP_STATUS_NOT_FOUND) return { kind: 'no-endpoint' }
  return { kind: 'service', status }
}

/** Classifies anything thrown at the bridge. Never throws, never echoes an unknown error. */
export function classifyBridgeFailure(error: unknown): BridgeFailure {
  if (error instanceof UpstreamHttpStatusError) return verdictOf(error.status)
  if (error instanceof SessionExpiredError) return { kind: 'session-expired' }
  if (error instanceof SseStreamError) return { kind: 'stream-lost' }
  if (error instanceof UpstreamConnectionError) return { kind: 'network', detail: error.message }
  if (error instanceof UpstreamResponseError) return { kind: 'protocol', detail: error.message }
  // Raised on the way BACK to the client: an HTTP message has no terminator,
  // so the stdio sink line-frames it — and refuses when the bytes already
  // hold a `\n`. The message carries an offset and nothing else.
  if (error instanceof EmbeddedNewlineError) return { kind: 'protocol', detail: error.message }
  return { kind: 'protocol', detail: UNKNOWN_DETAIL }
}

/**
 * Whether this failure ends the bridge, rather than the one request it hit.
 * A type predicate, so everything downstream of it narrows: the switch that
 * turns a fatal into a message and an exit code is then exhaustive by
 * compilation rather than by a `default` arm.
 */
export function isFatal(failure: BridgeFailure): failure is FatalBridgeFailure {
  switch (failure.kind) {
    case 'unauthorized':
    case 'forbidden':
    case 'no-endpoint':
    case 'session-expired':
    case 'stream-lost':
      return true
    case 'network':
    case 'service':
    case 'protocol':
      return false
  }
}
