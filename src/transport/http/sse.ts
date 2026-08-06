import type { ServerResponse } from 'node:http'
import { CONTENT_TYPE_SSE } from './constants.js'
import { HTTP_STATUS_OK } from './server-constants.js'

/**
 * Outbound Server-Sent Events stream for the downstream HTTP front (the
 * GET server-initiated channel of the sessionful model — spec matrix §1.3).
 *
 * Serialization: each message becomes one event, `data: <payload>\n\n`.
 * A payload containing newlines is split into one `data:` line per text
 * line (the WHATWG grammar's only representation of multi-line data —
 * `sse-parse.ts` on the client side re-joins them with '\n', so the bytes
 * round-trip). The split is on `\r\n`, `\r` and `\n` alike — matching
 * `sse-parse.ts`'s own line-break rule — not just `\n`: splitting on `\n`
 * only would leave a bare `\r` embedded inside one wire line, and the
 * parser's line-break regex (which treats a lone `\r` as a break too)
 * would then cut that wire line in the wrong place, silently dropping
 * whatever text followed the `\r` (it loses its `data:` prefix once
 * mis-split, and an unprefixed line is ignored as an unknown field — see
 * `sse-parse.ts`). Splitting on every CR/LF variant here keeps every byte
 * accounted for; the CR-vs-LF distinction itself cannot survive an SSE
 * round trip (the grammar has no way to represent it), so it normalizes to
 * `\n` — a documented, honest lossy transform, never a silent drop. A
 * `: ping` comment goes out every `heartbeatIntervalMs` on an unref'ed
 * timer so intermediaries keep the connection alive without the process
 * being held open.
 *
 * Headers include `X-Accel-Buffering: no` (spec SHOULD — critical behind
 * a buffering reverse proxy) and disable caching. Payload bytes are
 * forwarded as-is: this module never inspects them (layering invariant).
 */

export interface SseStream {
  /** Sends one message as an SSE event. No-op after close. */
  send(payload: Buffer): void
  /** True until the stream is closed (by us or by the peer dropping). */
  isOpen(): boolean
  /** Ends the response and stops the heartbeat. Idempotent. */
  close(): void
}

export interface SseStreamOptions {
  readonly heartbeatIntervalMs: number
  /** Fires exactly once, when the stream closes for ANY reason (ours or the peer's). */
  readonly onClose?: () => void
}

/** Matches `sse-parse.ts`'s own line-break rule: CRLF, then bare CR or LF. */
const SSE_LINE_BREAK = /\r\n|\r|\n/

/** Encodes one payload as a spec-conformant SSE event. */
export function encodeSseEvent(payload: Buffer): string {
  const lines = payload.toString('utf8').split(SSE_LINE_BREAK)
  return `${lines.map((line) => `data: ${line}`).join('\n')}\n\n`
}

/**
 * Writes SSE headers on `res` and returns the live stream handle. The
 * caller owns routing decisions; this handle only serializes and keeps
 * the connection warm.
 */
export function openSseStream(res: ServerResponse, opts: SseStreamOptions): SseStream {
  let isClosed = false

  res.writeHead(HTTP_STATUS_OK, {
    'content-type': CONTENT_TYPE_SSE,
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  // Flush the headers immediately so the client sees the stream open even
  // before the first event or heartbeat.
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, opts.heartbeatIntervalMs)
  heartbeat.unref()

  function markClosed(): void {
    if (isClosed) {
      return
    }
    isClosed = true
    clearInterval(heartbeat)
    opts.onClose?.()
  }

  // The peer dropping the connection must free the session's stream slot.
  res.on('close', markClosed)

  return Object.freeze({
    send(payload: Buffer): void {
      if (isClosed) {
        return
      }
      res.write(encodeSseEvent(payload))
    },
    isOpen(): boolean {
      return !isClosed
    },
    close(): void {
      if (isClosed) {
        return
      }
      markClosed()
      res.end()
    },
  })
}
