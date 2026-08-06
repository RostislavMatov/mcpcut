import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { McpMessage, MessageSource } from '../message.js'
import { UpstreamConnectionError, UpstreamResponseError } from './client-errors.js'

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
  readonly req: ClientRequest
  readonly response: Promise<IncomingMessage>
}

/**
 * Starts one HTTP(S) request. Connection-level failures reject with
 * `UpstreamConnectionError` naming only method + host (error hygiene — see
 * `./client-errors.ts`). The `req` handle is exposed so a long-lived GET
 * stream can be destroyed on close.
 */
export function startRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  host: string,
): StartedRequest {
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  let req!: ClientRequest
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = requestFn(url, { method, headers }, resolve)
    req.on('error', (error: unknown) => reject(new UpstreamConnectionError(method, host, error)))
    if (body !== null) {
      req.end(body)
    } else {
      req.end()
    }
  })
  return { req, response }
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

/** Lowercased `Content-Type` of a response, `''` when absent. */
export function contentTypeOf(res: IncomingMessage): string {
  const raw = res.headers['content-type']
  return typeof raw === 'string' ? raw.toLowerCase() : ''
}
