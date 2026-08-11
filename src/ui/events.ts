/**
 * SSE hub for the admin UI (M4 Task 11). One hub per `ui` process fans a
 * single queue/quarantine watcher (`watch.ts`) out to every open `GET /events`
 * stream. The hub owns three concerns only: the subscriber roster (with a hard
 * cap), a shared unref-ed heartbeat, and named-event fan-out. It never reads
 * disk and never decides WHAT to publish — the watcher does that and calls
 * `publish()`; keeping the split means the fan-out has no I/O to fail on.
 *
 * The stream sink is typed as the minimal `SseSink` subset of `ServerResponse`
 * (a real `ServerResponse` satisfies it structurally) so the hub is testable
 * with a plain fake and never depends on `node:http` internals.
 */

import { UI_MAX_SSE_SUBSCRIBERS, UI_SSE_HEARTBEAT_INTERVAL_MS } from './constants.js'

/** The three delta kinds the UI listens for; the client keys its DOM updates on these. */
export type UiEventName = 'approval-pending' | 'approval-resolved' | 'quarantine-changed'

/** A published event: a name plus a JSON-serializable data object. */
export interface UiEvent {
  readonly event: UiEventName
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * The slice of `node:http`'s `ServerResponse` the hub touches. A real
 * `ServerResponse` is assignable to this, so the handler passes it straight
 * through; tests pass a lightweight fake.
 *
 * The hub never calls `writeHead`: the SSE status line and headers are written
 * exactly once by `server.ts` on the stream path (with `securityHeaders()`),
 * before `subscribe()` runs. The hub only writes the event stream body.
 */
export interface SseSink {
  write(chunk: string): unknown
  end(): unknown
  on(event: 'close', listener: () => void): unknown
  readonly writableEnded?: boolean
}

/** An interval handle we can detach from the event loop; mirrors `NodeJS.Timeout`. */
export interface IntervalHandle {
  unref?(): void
}

/** Injectable timers so tests drive heartbeats deterministically. */
export interface Scheduler {
  setInterval(callback: () => void, ms: number): IntervalHandle
  clearInterval(handle: IntervalHandle): void
}

const defaultScheduler: Scheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
}

export interface EventHubOptions {
  readonly heartbeatIntervalMs?: number
  readonly maxSubscribers?: number
  readonly scheduler?: Scheduler
}

export type SubscribeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'at-capacity' }

export interface EventHub {
  /**
   * True while the hub is open and below its subscriber cap. `server.ts` checks
   * this BEFORE writing the SSE `200` so an over-capacity request can still be
   * answered with a clean 503 instead of a broken half-written stream.
   */
  hasCapacity(): boolean
  /**
   * Registers an already-authenticated stream whose headers `server.ts` has
   * already written. Does NOT write headers. Refuses (without side effects) if
   * the hub is closed or full — a defensive backstop to the `hasCapacity()`
   * pre-check, which the single-threaded request path makes race-free.
   */
  subscribe(sink: SseSink): SubscribeResult
  /** Fans one event out to every open subscriber. No-op after `close()`. */
  publish(event: UiEvent): void
  subscriberCount(): number
  /** Ends every stream and stops the heartbeat. Idempotent. */
  close(): void
}

/**
 * Opening comment written the moment a stream is registered. It flushes the
 * already-written response headers to the client (a bare `writeHead` with no
 * body is not sent until the first write) and establishes the stream before
 * the first real event or the 15s heartbeat.
 */
const SSE_PRELUDE = ': connected\n\n'

/** Serializes one named event to the SSE wire format (single-line JSON data). */
function encodeEvent(event: UiEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export function createEventHub(opts: EventHubOptions = {}): EventHub {
  const scheduler = opts.scheduler ?? defaultScheduler
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? UI_SSE_HEARTBEAT_INTERVAL_MS
  const maxSubscribers = opts.maxSubscribers ?? UI_MAX_SSE_SUBSCRIBERS

  const subscribers = new Set<SseSink>()
  let closed = false

  const heartbeat = scheduler.setInterval(() => {
    for (const sink of subscribers) safeWrite(sink, ': heartbeat\n\n')
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  /** A dead socket must never take the whole fan-out down; drop it instead. */
  function safeWrite(sink: SseSink, chunk: string): void {
    try {
      sink.write(chunk)
    } catch {
      subscribers.delete(sink)
    }
  }

  function hasCapacity(): boolean {
    return !closed && subscribers.size < maxSubscribers
  }

  function subscribe(sink: SseSink): SubscribeResult {
    if (!hasCapacity()) {
      return { ok: false, reason: 'at-capacity' }
    }
    subscribers.add(sink)
    // The peer dropping the connection frees its slot exactly once.
    sink.on('close', () => {
      subscribers.delete(sink)
    })
    // Flush headers and open the stream immediately (see SSE_PRELUDE).
    safeWrite(sink, SSE_PRELUDE)
    return { ok: true }
  }

  function publish(event: UiEvent): void {
    if (closed) return
    const chunk = encodeEvent(event)
    for (const sink of subscribers) safeWrite(sink, chunk)
  }

  function subscriberCount(): number {
    return subscribers.size
  }

  function close(): void {
    if (closed) return
    closed = true
    scheduler.clearInterval(heartbeat)
    for (const sink of subscribers) {
      try {
        sink.end()
      } catch {
        // A stream already torn down by its peer needs nothing from us.
      }
    }
    subscribers.clear()
  }

  return Object.freeze({ hasCapacity, subscribe, publish, subscriberCount, close })
}
