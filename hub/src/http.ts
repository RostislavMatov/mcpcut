import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

/**
 * Small, semantics-free HTTP helpers for the hub's server (plan Task 5): the
 * hub's own copies of `headerValue`, `parseTarget` and `readRequestBody` from
 * `src/ui/routes.ts` (not on the H1 allowlist), plus the one answer shape
 * every route returns.
 */

/** What a route hands back; `server.ts` adds the security headers and writes it. */
export interface HubResult {
  readonly status: number
  readonly headers?: Readonly<Record<string, string | readonly string[]>>
  readonly body?: string | Buffer
}

export const CONTENT_TYPE_HTML = 'text/html; charset=utf-8'
export const CONTENT_TYPE_TEXT = 'text/plain; charset=utf-8'

/** Every hub form is a handful of short fields; anything bigger is not ours. */
export const MAX_HUB_BODY_BYTES = 16 * 1024

/** An HTML page answer. */
export function page(status: number, body: string, setCookies: readonly string[] = []): HubResult {
  return {
    status,
    headers: { 'content-type': CONTENT_TYPE_HTML, ...(setCookies.length > 0 ? { 'set-cookie': setCookies } : {}) },
    body,
  }
}

/** A `303 See Other` to a same-origin path. */
export function seeOther(location: string, setCookies: readonly string[] = []): HubResult {
  return { status: 303, headers: { location, ...(setCookies.length > 0 ? { 'set-cookie': setCookies } : {}) } }
}

/** A short plain-text refusal (screening failures carry no page). */
export function plain(status: number, text: string): HubResult {
  return { status, headers: { 'content-type': CONTENT_TYPE_TEXT }, body: `${text}\n` }
}

/** First value of a (possibly repeated) header, or `undefined`. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/** Splits a request target into path + query (the path is NOT decoded). */
export function parseTarget(url: string | undefined): { readonly path: string; readonly query: URLSearchParams } {
  const target = url ?? '/'
  const queryStart = target.indexOf('?')
  if (queryStart === -1) return { path: target, query: new URLSearchParams() }
  return { path: target.slice(0, queryStart), query: new URLSearchParams(target.slice(queryStart + 1)) }
}

export type BodyRead = { readonly ok: true; readonly body: Buffer } | { readonly ok: false }

/** Buffers a request body, refusing past `maxBytes` (the caller answers 413). */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
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

/**
 * `application/x-www-form-urlencoded` fields, first value per name. Untrusted
 * input: never throws; any other content type yields no fields at all, so a
 * JSON body cannot carry a CSRF token past a check written for forms.
 */
export function formFields(body: Buffer, contentType: string | undefined): Readonly<Record<string, string>> {
  if (contentType === undefined || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return {}
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(body.toString('utf8'))) {
    if (!Object.hasOwn(fields, key)) fields[key] = value
  }
  return fields
}

/** Error class and message only — never a body, a header or a token. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error value thrown'
}
