import type { SseStream } from './sse.js'

/**
 * The response of one POST, as it may become an SSE stream (decision M36,
 * phase B). Claude Code cuts a POST answered with JSON at 60 s; a call held
 * for a human waits as long as its agent does, so its POST must be answered
 * with an SSE stream instead: headers at once, the gate's progress
 * notifications for that request as events, the final response as the last
 * event (smoke 2026-10-08, #6–#8).
 *
 * The switch is lazy, so every answer that comes quickly stays the plain JSON
 * it always was. The stream opens on the first message RELATED to the request
 * (a `notifications/progress` on its token — which the gate sends the moment
 * it starts holding a call), or after `upgradeAfterMs` with no answer (any
 * slow call, token or not). Semantics-free like the rest of this layer: what
 * counts as related is the injected hooks' business.
 */

/** Opens the SSE response of one POST; offered by the front only when the client accepts SSE. */
export type OpenPostStream = () => SseStream

/** What a POST answered on its own SSE stream resolves to: the front has nothing left to write. */
export const STREAMED = 'streamed' as const
export type Streamed = typeof STREAMED

export interface PostStream {
  /** Sends one related message as an event, opening the stream first; `false` when this POST cannot stream. */
  send(payload: Buffer): boolean
  /**
   * Ends the POST with its answer: on an open stream the answer is the last
   * event and the stream ends (`STREAMED`); otherwise `null`, and the caller
   * answers with JSON as before.
   */
  finish(payload: Buffer): Streamed | null
  /** Ends an open stream that has no answer to carry (`STREAMED`); `null` when none was opened. */
  abort(): Streamed | null
}

export interface PostStreamOptions {
  /** Absent when the client does not accept SSE: then nothing ever streams. */
  readonly open: OpenPostStream | undefined
  /** No answer by then → the stream opens anyway, with no event yet. */
  readonly upgradeAfterMs: number
}

export function startPostStream(opts: PostStreamOptions): PostStream {
  const { open } = opts
  let stream: SseStream | null = null
  let isDone = false
  let cannotOpen = open === undefined

  function ensureOpen(): SseStream | null {
    if (isDone || cannotOpen || open === undefined) return null
    try {
      stream ??= open()
    } catch {
      // The response is already gone (a destroyed socket): this POST answers
      // as JSON, or not at all — the abort path tells the session.
      cannotOpen = true
      return null
    }
    return stream
  }

  const timer = open === undefined ? null : setTimeout(() => void ensureOpen(), opts.upgradeAfterMs)
  // A POST waiting on a human must not keep the process alive by itself.
  timer?.unref()

  /** Stops the clock; the stream (if any) is the caller's to end now. */
  function settle(): SseStream | null {
    isDone = true
    if (timer !== null) clearTimeout(timer)
    return stream
  }

  return {
    send(payload) {
      const target = ensureOpen()
      if (target === null) return false
      target.send(payload)
      return true
    },
    finish(payload) {
      const target = settle()
      if (target === null) return null
      target.send(payload)
      target.close()
      return STREAMED
    },
    abort() {
      const target = settle()
      if (target === null) return null
      target.close()
      return STREAMED
    },
  }
}
