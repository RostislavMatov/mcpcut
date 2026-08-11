import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UiSession } from './auth.js'
import { ROUTE_TABLE } from './authz.js'

/**
 * The injectable handler contract for the admin UI (M4 Task 9). The server
 * core (`server.ts`) owns routing, authentication, authorization, CSRF and the
 * security headers; the actual page rendering (Wave 3, Task 10), action
 * handlers (Wave 3, Tasks 12–15) and the SSE endpoint (Wave 3, Task 11) are
 * INJECTED as a handler map keyed by the `handler` field of `ROUTE_TABLE`.
 *
 * This module defines that contract — the request context a handler receives
 * and the result it returns — plus the completeness check that fails fast if a
 * route in the table has no bound handler.
 */

/** Everything a handler needs about one already-authorized request. */
export interface UiRequestContext {
  readonly method: string
  /** Path only (query already split off). */
  readonly path: string
  /** Captured `:params` from the matched route (e.g. `{ id }`). */
  readonly params: Readonly<Record<string, string>>
  /** Parsed query string. */
  readonly query: URLSearchParams
  /**
   * The authenticated session, or `undefined` for the `public` surface
   * (`GET /login`, assets). Carries `adminName` (attribution), `role` and the
   * per-session `csrfToken` a page must embed in its forms and `fetch` calls.
   */
  readonly session: UiSession | undefined
  /** Raw request body (empty for GET). Handlers parse their own shape. */
  readonly body: Buffer
  /** Raw request headers (read-only view). */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * A handler's answer. `response` is a buffered plan (the server adds security
 * headers and a default content type); `stream` hands the raw `res` to the
 * handler for Server-Sent Events after the server has written the status line
 * and headers.
 */
export type UiResult =
  | {
      readonly kind: 'response'
      readonly status: number
      readonly headers?: Record<string, string>
      readonly body?: string | Buffer
    }
  | {
      readonly kind: 'stream'
      /**
       * Called after the server writes `200` with security + SSE headers. The
       * handler owns the socket from here (writes events, registers with the
       * hub, cleans up on `res` close). It must not call `writeHead` again.
       */
      readonly onStream: (res: ServerResponse) => void
    }

/** The signature every injected page/action/SSE handler implements. */
export type UiHandler = (ctx: UiRequestContext) => Promise<UiResult> | UiResult

/** A map from `ROUTE_TABLE` handler keys to their implementations. */
export type UiHandlers = Readonly<Record<string, UiHandler>>

/**
 * Handler keys served by the server core itself (login/logout), not injected.
 * Distinguished by a leading `@`.
 */
export function isInternalHandler(key: string): boolean {
  return key.startsWith('@')
}

/**
 * Handler keys the caller MUST inject (every non-internal route). Frozen at
 * module load from the normative table so Wave 3 cannot forget one and the
 * server cannot be constructed with a route that has no implementation.
 */
export const REQUIRED_HANDLER_KEYS: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      ROUTE_TABLE.filter((entry) => !isInternalHandler(entry.handler)).map((entry) => entry.handler),
    ),
  ),
)

/** Raised when a server is constructed without a handler for some route. */
export class MissingHandlerError extends Error {
  constructor(missing: readonly string[]) {
    super(`UI server is missing handlers for routes: ${missing.join(', ')}`)
    this.name = 'MissingHandlerError'
  }
}

/** Throws `MissingHandlerError` unless every required handler key is present. */
export function assertHandlersComplete(handlers: UiHandlers): void {
  const missing = REQUIRED_HANDLER_KEYS.filter((key) => typeof handlers[key] !== 'function')
  if (missing.length > 0) throw new MissingHandlerError(missing)
}

/**
 * Parses a request body as either JSON or `application/x-www-form-urlencoded`
 * into a flat string map. Untrusted input: never throws — an unparseable body
 * yields an empty map, and only string scalars are kept. Used to extract the
 * login token and the CSRF field.
 */
export function parseBodyFields(
  body: Buffer,
  contentType: string | undefined,
): Readonly<Record<string, string>> {
  const text = body.toString('utf8')
  if (text.length === 0) return {}
  if (contentType !== undefined && contentType.includes('application/json')) {
    return parseJsonFields(text)
  }
  return parseUrlEncodedFields(text)
}

function parseJsonFields(text: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function parseUrlEncodedFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const params = new URLSearchParams(text)
  for (const [key, value] of params) {
    if (!(key in out)) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Small transport helpers (shared by `server.ts`; kept here to keep the server
// file within the size budget). All pure over headers/streams — no semantics.
// ---------------------------------------------------------------------------

/** First value of a (possibly multi-valued) header, or `undefined`. */
export function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/** Splits a request target into path + query (the path is NOT URL-decoded). */
export function parseTarget(url: string | undefined): { path: string; query: URLSearchParams } {
  const target = url ?? '/'
  const queryStart = target.indexOf('?')
  if (queryStart === -1) return { path: target, query: new URLSearchParams() }
  return {
    path: target.slice(0, queryStart),
    query: new URLSearchParams(target.slice(queryStart + 1)),
  }
}

/** Buffered body read outcome: the whole payload or an over-limit refusal. */
export type BodyResult = { readonly ok: true; readonly body: Buffer } | { readonly ok: false }

/** Buffers a request body, refusing past `maxBytes` (→ the caller answers 413). */
export function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        resolve({ ok: false })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }))
    req.on('error', (error: unknown) => reject(error))
  })
}

/** Error class and message only — never a body, a header or a token. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
