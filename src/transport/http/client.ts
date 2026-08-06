import type { ClientRequest, IncomingMessage } from 'node:http'
import {
  serverMessage,
  type McpMessage,
  type MessageSink,
  type MessageSource,
} from '../message.js'
import {
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
  UpstreamResponseError,
} from './client-errors.js'
import {
  contentTypeOf,
  createChannel,
  defaultDelay,
  readBoundedBody,
  startRequest,
} from './client-wire.js'
import {
  ACCEPT_JSON_AND_SSE,
  ACCEPT_SSE_ONLY,
  CLOSE_DRAIN_TIMEOUT_MS,
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_SSE,
  HTTP_STATUS_ACCEPTED,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_NOT_FOUND,
  MAX_UPSTREAM_RESPONSE_BYTES,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
  SSE_RECONNECT_BASE_DELAY_MS,
  SSE_RECONNECT_MAX_ATTEMPTS,
  SSE_RECONNECT_MAX_DELAY_MS,
} from './constants.js'
import { createSseParser, type SseItem } from './sse-parse.js'

/**
 * HTTP upstream client (M3 Task 9): connects the control plane to a remote
 * streamable-HTTP MCP server as a transport-neutral `MessageSource`/
 * `MessageSink` pair. Supports both session models of ADR-0002 —
 * sessionful (`Mcp-Session-Id` + GET-SSE + DELETE) and stateless
 * (2026-07-28, plain POSTs) — with `auto` detected purely transport-side:
 * by the presence of the session header on the first successful POST
 * response. No JSON body is ever parsed here; any per-message semantics
 * (e.g. `Mcp-Method`/`Mcp-Name` for stateless upstreams) arrive through the
 * injected `perMessageHeaders` hook (Task 11), default: none.
 *
 * Error hygiene: see `./client-errors.ts` — status + host only, never
 * path/query, header values or bodies.
 */

// Public typed-error surface stays on this module (the split into
// client-errors.ts is a file-size measure, not an API decision).
export {
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
  UpstreamResponseError,
} from './client-errors.js'

/** Session model pinned in (or defaulted by) the registry record. */
export type HttpUpstreamProtocol = 'sessionful' | 'stateless' | 'auto'

/**
 * The slice of a registry http-record the client needs. Header values must
 * already be dereferenced by the caller (vault refs resolved) — the client
 * treats them as opaque ready-to-send strings.
 */
export interface HttpUpstreamRecord {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly protocol: HttpUpstreamProtocol
}

export interface HttpUpstreamClientOptions {
  /** Value for `MCP-Protocol-Version` on every request (pass-through; unset → header not sent). */
  readonly protocolVersionHeader?: string
  /** Injected semantic hook: extra headers derived from the outgoing bytes (default: none). */
  readonly perMessageHeaders?: (bytes: Buffer) => Record<string, string>
  /** Injected timer (backoff waits, close drain bound). Default: unref'ed setTimeout. */
  readonly delay?: (ms: number) => Promise<void>
  readonly sseReconnectMaxAttempts?: number
  readonly sseReconnectBaseDelayMs?: number
  readonly sseReconnectMaxDelayMs?: number
  readonly closeDrainTimeoutMs?: number
  readonly maxResponseBytes?: number
}

export interface HttpUpstreamClient {
  readonly source: MessageSource
  readonly sink: MessageSink
  /** DELETEs the session (if any), stops the GET stream, waits (bounded) for in-flight POSTs. Idempotent. */
  close(): Promise<void>
}

/**
 * Creates one upstream HTTP client. The returned `sink` POSTs every message
 * to the record's URL, the `source` delivers everything the server answers
 * or pushes (JSON bodies, SSE events, GET-stream events) as server-origin
 * messages without a terminator key. `close()`/`sink.dispose()` shut the
 * connection down; after that, writes resolve as no-ops.
 */
export function createHttpUpstreamClient(
  record: HttpUpstreamRecord,
  opts: HttpUpstreamClientOptions = {},
): HttpUpstreamClient {
  const url = new URL(record.url)
  const host = url.host
  const delay = opts.delay ?? defaultDelay
  const maxAttempts = opts.sseReconnectMaxAttempts ?? SSE_RECONNECT_MAX_ATTEMPTS
  const baseDelayMs = opts.sseReconnectBaseDelayMs ?? SSE_RECONNECT_BASE_DELAY_MS
  const maxDelayMs = opts.sseReconnectMaxDelayMs ?? SSE_RECONNECT_MAX_DELAY_MS
  const maxBytes = opts.maxResponseBytes ?? MAX_UPSTREAM_RESPONSE_BYTES

  let sessionId: string | null = null
  let isDetected = record.protocol === 'stateless'
  let detectionGate: Promise<void> | null = null
  let releaseDetectionGate: (() => void) | null = null
  let isClosed = false
  let closePromise: Promise<void> | null = null
  let currentGetRequest: ClientRequest | null = null
  let isGetRunning = false
  let minRetryDelayMs = 0
  const inFlight = new Set<Promise<void>>()

  const channel = createChannel(() => {
    void close().catch(() => undefined)
  })

  function baseHeaders(): Record<string, string> {
    return {
      ...record.headers,
      ...(opts.protocolVersionHeader !== undefined
        ? { [MCP_PROTOCOL_VERSION_HEADER]: opts.protocolVersionHeader }
        : {}),
      ...(sessionId !== null ? { [MCP_SESSION_ID_HEADER]: sessionId } : {}),
    }
  }

  function postHeaders(message: McpMessage): Record<string, string> {
    return {
      'content-type': CONTENT_TYPE_JSON,
      accept: ACCEPT_JSON_AND_SSE,
      ...(opts.perMessageHeaders !== undefined ? opts.perMessageHeaders(message.bytes) : {}),
      ...baseHeaders(),
    }
  }

  function handleSseItem(item: SseItem): void {
    if (item.kind === 'retry') {
      minRetryDelayMs = item.retryMs
      return
    }
    channel.emitMessage(serverMessage(Buffer.from(item.data, 'utf8')))
  }

  /** Streams one SSE response through the parser into the source. */
  function consumeSse(res: IncomingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const parser = createSseParser(maxBytes)
      const fail = (error: unknown) => {
        res.destroy()
        reject(error)
      }
      res.on('data', (chunk: Buffer) => {
        try {
          for (const item of parser.feed(chunk)) handleSseItem(item)
        } catch (error: unknown) {
          fail(error)
        }
      })
      res.on('end', () => {
        try {
          for (const item of parser.end()) handleSseItem(item)
          resolve()
        } catch (error: unknown) {
          reject(error)
        }
      })
      res.on('error', (error: unknown) => reject(new UpstreamConnectionError('stream', host, error)))
    })
  }

  /** Transport-only session detection: the header's presence on the first successful POST response. */
  function noteDetection(res: IncomingMessage): void {
    isDetected = true
    const raw = res.headers[MCP_SESSION_ID_HEADER]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.length > 0 && record.protocol !== 'stateless') {
      sessionId = value
      startGetStream()
    }
    releaseDetectionGate?.()
  }

  async function handlePostResponse(res: IncomingMessage): Promise<void> {
    const status = res.statusCode ?? 0
    if (status === HTTP_STATUS_NOT_FOUND && sessionId !== null) {
      res.resume()
      throw new SessionExpiredError(host)
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new UpstreamHttpStatusError('POST', status, host)
    }
    if (status === HTTP_STATUS_ACCEPTED) {
      res.resume()
      return
    }
    const contentType = contentTypeOf(res)
    if (contentType.startsWith(CONTENT_TYPE_SSE)) {
      await consumeSse(res)
      return
    }
    const body = await readBoundedBody(res, maxBytes, host)
    if (body.length === 0) {
      return
    }
    if (!contentType.startsWith(CONTENT_TYPE_JSON)) {
      throw new UpstreamResponseError(host, `unsupported content type on HTTP ${status} response`)
    }
    channel.emitMessage(serverMessage(body))
  }

  async function performPost(message: McpMessage, isDetector: boolean): Promise<void> {
    const { response } = startRequest(url, 'POST', postHeaders(message), message.bytes, host)
    const res = await response
    const status = res.statusCode ?? 0
    if (isDetector && status >= 200 && status < 300) {
      noteDetection(res)
    }
    await handlePostResponse(res)
  }

  /**
   * Until the session model is known, exactly one POST (the detector) is in
   * flight and later writes queue behind its response HEADERS (not its full
   * body) — the session id must be known before any second request. If the
   * detector fails, the next queued write takes over detection.
   */
  async function postWithDetection(message: McpMessage): Promise<void> {
    if (isDetected) {
      await performPost(message, false)
      return
    }
    if (detectionGate === null) {
      detectionGate = new Promise((resolve) => {
        releaseDetectionGate = resolve
      })
      try {
        await performPost(message, true)
      } finally {
        releaseDetectionGate?.()
        releaseDetectionGate = null
        if (!isDetected) detectionGate = null
      }
      return
    }
    await detectionGate
    await postWithDetection(message)
  }

  function write(message: McpMessage): Promise<void> {
    if (isClosed) {
      return Promise.resolve()
    }
    const task = postWithDetection(message).catch((error: unknown) => {
      channel.emitError(error)
      throw error
    })
    inFlight.add(task)
    const settle = () => inFlight.delete(task)
    task.then(settle, settle)
    return task
  }

  function reconnectDelayMs(failureCount: number): number {
    const backoff = Math.min(baseDelayMs * 2 ** (failureCount - 1), maxDelayMs)
    return Math.max(backoff, minRetryDelayMs)
  }

  /** Opens the GET stream once; `'unsupported'` means 405 (valid: no stream). */
  async function openGetOnce(): Promise<'unsupported' | Promise<void>> {
    const headers = { accept: ACCEPT_SSE_ONLY, ...baseHeaders() }
    const { req, response } = startRequest(url, 'GET', headers, null, host)
    currentGetRequest = req
    const res = await response
    const status = res.statusCode ?? 0
    if (status === HTTP_STATUS_METHOD_NOT_ALLOWED) {
      res.resume()
      return 'unsupported'
    }
    if (status === HTTP_STATUS_NOT_FOUND) {
      res.resume()
      throw new SessionExpiredError(host)
    }
    if (status !== 200 || !contentTypeOf(res).startsWith(CONTENT_TYPE_SSE)) {
      res.resume()
      throw new UpstreamHttpStatusError('GET', status, host)
    }
    return consumeSse(res)
  }

  async function runGetLoop(): Promise<void> {
    let failures = 0
    let lastError: unknown = null
    while (!isClosed) {
      try {
        const outcome = await openGetOnce()
        if (outcome === 'unsupported') return
        failures = 0
        await outcome
        // Stream ended cleanly (server closed it): reconnect below.
      } catch (error: unknown) {
        if (isClosed) return
        if (error instanceof SessionExpiredError) {
          channel.emitError(error)
          return
        }
        lastError = error
      }
      failures += 1
      if (failures > maxAttempts) {
        channel.emitError(new SseStreamError(host, maxAttempts, lastError))
        return
      }
      await delay(reconnectDelayMs(failures))
    }
  }

  function startGetStream(): void {
    if (isGetRunning || isClosed) return
    isGetRunning = true
    void runGetLoop().catch((error: unknown) => channel.emitError(error))
  }

  /** Best-effort session DELETE; any HTTP status (405 included) is acceptable. */
  async function sendSessionDelete(): Promise<void> {
    try {
      const { response } = startRequest(url, 'DELETE', baseHeaders(), null, host)
      const res = await response
      res.resume()
    } catch (error: unknown) {
      channel.emitError(error)
    }
  }

  async function doClose(): Promise<void> {
    isClosed = true
    const pending = [...inFlight]
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        delay(opts.closeDrainTimeoutMs ?? CLOSE_DRAIN_TIMEOUT_MS),
      ])
    }
    currentGetRequest?.destroy()
    currentGetRequest = null
    if (sessionId !== null) {
      await sendSessionDelete()
    }
    channel.emitEnd()
  }

  function close(): Promise<void> {
    closePromise ??= doClose()
    return closePromise
  }

  const sink: MessageSink = Object.freeze({
    write,
    dispose(): void {
      void close().catch(() => undefined)
    },
  })

  return Object.freeze({ source: channel.source, sink, close })
}
