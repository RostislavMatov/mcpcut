import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { UpstreamAddressRefusedError, type UpstreamGuard } from '../../net/upstream-guard.js'
import type { McpMessage, MessageSource } from '../message.js'
import { UpstreamConnectionError, UpstreamResponseError } from './client-errors.js'
import { createSseParser, type SseItem } from './sse-parse.js'
import { CONTENT_TYPE_JSON } from './constants.js'

/**
 * Wire-level plumbing for the HTTP upstream client (`./client.ts`): raw
 * request start, bounded body reads, the callback-shaped source channel and
 * the default timer. Split out of the factory module purely for the
 * < 400-lines-per-file rule. Bytes and headers only — no JSON-RPC knowledge
 * (CLAUDE.md layering invariant, `tests/architecture/imports.test.ts`).
 */

type Handler<T> = ((value: T) => void) | null

/** The client-internal emit side of a `MessageSource`. */
export interface Channel {
  readonly source: MessageSource
  emitMessage(message: McpMessage): void
  emitError(error: unknown): void
  emitEnd(): void
}

/** Default injected timer: unref'ed so a pending backoff never holds the process open. */
export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * A serialized "start" queue: each `enqueue()`-ed task begins only once the
 * previous one has called its own `markDispatched`. `client.ts`'s sink uses
 * this to serialize POST *dispatch* order without serializing on the full
 * response — see the comment on `write()` there for why dispatch (not
 * response) is the release point.
 *
 * A task that settles without ever calling `markDispatched` (it threw
 * before reaching its own dispatch point) still releases the queue: the
 * safety net below calls it for them, so one failed task can never leave
 * every later one hanging forever.
 */
export interface DispatchQueue {
  enqueue<T>(task: (markDispatched: () => void) => Promise<T>): Promise<T>
}

export function createDispatchQueue(): DispatchQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    enqueue<T>(task: (markDispatched: () => void) => Promise<T>): Promise<T> {
      const previous = tail
      let dispatched = false
      let markDispatched!: () => void
      tail = new Promise<void>((resolve) => {
        markDispatched = () => {
          dispatched = true
          resolve()
        }
      })
      const result = previous.then(() => task(markDispatched))
      const release = () => {
        if (!dispatched) markDispatched()
      }
      result.then(release, release)
      return result
    },
  }
}

/**
 * Callback-shaped `MessageSource` (one handler per event, registered before
 * messages flow — `transport/message.ts` contract) whose `dispose()` runs
 * `onDispose` once and silences every later emit.
 */
export function createChannel(onDispose: () => void): Channel {
  let onMessage: Handler<McpMessage> = null
  let onError: Handler<unknown> = null
  let onEnd: (() => void) | null = null
  let isDisposed = false
  let hasEnded = false

  const source: MessageSource = Object.freeze({
    onMessage: (handler: (message: McpMessage) => void) => {
      onMessage = handler
    },
    onError: (handler: (error: unknown) => void) => {
      onError = handler
    },
    onEnd: (handler: () => void) => {
      onEnd = handler
    },
    dispose: () => {
      if (isDisposed) return
      isDisposed = true
      onDispose()
    },
  })

  return Object.freeze({
    source,
    emitMessage: (message: McpMessage) => {
      if (!isDisposed) onMessage?.(message)
    },
    emitError: (error: unknown) => {
      if (!isDisposed) onError?.(error)
    },
    emitEnd: () => {
      if (isDisposed || hasEnded) return
      hasEnded = true
      onEnd?.()
    },
  })
}

export interface StartedRequest {
  /** `null` when the guard refused the URL: no request was ever created. */
  readonly req: ClientRequest | null
  readonly response: Promise<IncomingMessage>
  /**
   * Resolves once this request's body has been fully handed off to the
   * socket (Node's `'finish'` event) — or once the request failed, so
   * nothing chained on it is ever left hanging. Never rejects. This is the
   * dispatch-order release point `client.ts`'s sink serializes writes on
   * (see the comment on `write()` there for why it is this and not the
   * response).
   */
  readonly dispatched: Promise<void>
}

/**
 * Starts one HTTP(S) request. Connection-level failures reject with
 * `UpstreamConnectionError` naming only method + host (error hygiene — see
 * `./client-errors.ts`). The `req` handle is exposed so a long-lived GET
 * stream can be destroyed on close.
 *
 * With a `guard` (tenant mode, ADR-0017 T4) the URL is checked BEFORE the
 * request exists — `net.connect` never calls `lookup` for an IP literal, so
 * this is the only place a literal is seen — and the guard's `lookup` resolves
 * the socket's address, so the checked answer is the dialed one. Host header
 * and TLS servername still come from the URL. The socket comes from the
 * guard's own keep-alive pool (`guard.agent`), never from the process-wide
 * `https.globalAgent`: a pooled socket is reused without a fresh lookup, so the
 * only safe pool is one whose every socket was opened through the guard
 * (security review M1 — the old reasoning "every client in a tenant install
 * carries a guard" held only until one unguarded https client appeared).
 *
 * A refusal rejects with the guard's own `UpstreamAddressRefusedError`, NOT
 * wrapped: its message is hygienic by construction (host as written + the
 * category of address) and is the reason the operator must read — a wrapper
 * would reduce it to its error code.
 */
export function startRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  host: string,
  guard?: UpstreamGuard,
): StartedRequest {
  if (guard !== undefined) {
    try {
      guard.checkUrl(url)
    } catch (error: unknown) {
      return { req: null, response: Promise.reject(error), dispatched: Promise.resolve() }
    }
  }
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  const options = requestOptionsOf(url, method, headers, guard)
  let req!: ClientRequest
  let resolveDispatched!: () => void
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve
  })
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = requestFn(url, options, resolve)
    req.on('error', (error: unknown) => {
      resolveDispatched()
      reject(connectionFailureOf(method, host, error))
    })
    req.once('finish', resolveDispatched)
    if (body !== null) {
      req.end(body)
    } else {
      req.end()
    }
  })
  return { req, response, dispatched }
}

/**
 * Request options, with the guard's pool and resolver when there is a guard.
 * `lookup` rides on the request as well as inside the agent: the agent's copy
 * wins (its options override the request's), the request's copy keeps the
 * socket guarded should the agent ever lack one. The agent goes only on an
 * `https:` request — an `https.Agent` refuses any other protocol, and a real
 * guard lets nothing else through `checkUrl`, so an `http:` request with a
 * guard exists only under a test stand-in guard.
 */
function requestOptionsOf(
  url: URL,
  method: string,
  headers: Record<string, string>,
  guard: UpstreamGuard | undefined,
): RequestOptions {
  if (guard === undefined) return { method, headers }
  if (url.protocol !== 'https:') return { method, headers, lookup: guard.lookup }
  return { method, headers, lookup: guard.lookup, agent: guard.agent }
}

/** A guard refusal travels as itself (see `startRequest`); anything else is wrapped. */
function connectionFailureOf(method: string, host: string, error: unknown): Error {
  return error instanceof UpstreamAddressRefusedError
    ? error
    : new UpstreamConnectionError(method, host, error)
}

/** Buffers a whole response body, failing (and dropping the socket) past `maxBytes`. */
export function readBoundedBody(
  res: IncomingMessage,
  maxBytes: number,
  host: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    res.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        res.destroy()
        reject(new UpstreamResponseError(host, `response body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', (error: unknown) => reject(new UpstreamConnectionError('read', host, error)))
  })
}

/**
 * The body of an error response, when it is a non-empty JSON body; `null`
 * otherwise, having read nothing. Read (bounded) BEFORE anything drains the
 * response, so the caller can still `resume()` it on `null`.
 */
export async function readJsonErrorBody(
  res: IncomingMessage,
  maxBytes: number,
  host: string,
): Promise<Buffer | null> {
  if (!contentTypeOf(res).startsWith(CONTENT_TYPE_JSON)) {
    return null
  }
  const body = await readBoundedBody(res, maxBytes, host)
  return body.length === 0 ? null : body
}

/** Lowercased `Content-Type` of a response, `''` when absent. */
export function contentTypeOf(res: IncomingMessage): string {
  const raw = res.headers['content-type']
  return typeof raw === 'string' ? raw.toLowerCase() : ''
}

export interface SseConsumerOptions {
  /** Forwarded to `sse-parse.ts`'s `createSseParser` (per-event memory bound). */
  readonly maxBufferedChars: number
  readonly host: string
  /** One dispatched event's data, decoded utf8. */
  readonly onMessage: (data: string) => void
  /** A `retry:` directive's value, verbatim (uncapped — `client.ts` caps it). */
  readonly onRetry: (retryMs: number) => void
}

/** Streams one SSE response through `sse-parse.ts` into the given callbacks, in order. */
export function consumeSseResponse(res: IncomingMessage, opts: SseConsumerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = createSseParser(opts.maxBufferedChars)
    const handle = (item: SseItem): void => {
      if (item.kind === 'retry') {
        opts.onRetry(item.retryMs)
        return
      }
      opts.onMessage(item.data)
    }
    res.on('data', (chunk: Buffer) => {
      try {
        for (const item of parser.feed(chunk)) handle(item)
      } catch (error: unknown) {
        res.destroy()
        reject(error)
      }
    })
    res.on('end', () => {
      try {
        for (const item of parser.end()) handle(item)
        resolve()
      } catch (error: unknown) {
        reject(error)
      }
    })
    res.on('error', (error: unknown) => reject(new UpstreamConnectionError('stream', opts.host, error)))
  })
}
