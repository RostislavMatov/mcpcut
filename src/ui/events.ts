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

/**
 * Who a stream belongs to. An SSE connection is the one request that never
 * ends, so unlike every other route it cannot be re-authorized "on the next
 * request" — the hub records the identity it was opened under and can therefore
 * both close it by key and re-check it periodically.
 */
export interface SseIdentity {
  readonly sessionId: string
  readonly adminName: string
}

export interface EventHubOptions {
  readonly heartbeatIntervalMs?: number
  readonly maxSubscribers?: number
  readonly scheduler?: Scheduler
  /**
   * Liveness probe for an open stream, run on every heartbeat tick. Wiring it
   * to the session manager is what makes a revoked/rotated/demoted admin — and
   * a session that simply hit its TTL — lose its live streams without any new
   * coupling between the admin store and the hub.
   *
   * Fail-closed: a probe that throws, and a stream with no identity at all, are
   * both treated as dead. When no probe is configured (unit tests, embedders
   * with no session model) the sweep does nothing.
   */
  readonly isSessionLive?: (identity: SseIdentity) => boolean | Promise<boolean>
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
   *
   * `identity` binds the stream to the session that opened it, so it can be
   * closed when that session dies. It is optional only for tests and embedders
   * with no session model; the UI server always supplies it.
   */
  subscribe(sink: SseSink, identity?: SseIdentity): SubscribeResult
  /** Fans one event out to every open subscriber. No-op after `close()`. */
  publish(event: UiEvent): void
  subscriberCount(): number
  /** Ends every stream opened under `sessionId`. Returns how many were closed. */
  closeSession(sessionId: string): number
  /** Ends every stream of one admin (all their sessions). Returns the count. */
  closeForAdmin(adminName: string): number
  /**
   * Re-checks every open stream against `isSessionLive` and ends the dead ones.
   * Runs on every heartbeat tick; exposed so callers (and tests) can force it.
   * Returns how many streams were closed.
   */
  sweepSessions(): Promise<number>
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

  const isSessionLive = opts.isSessionLive
  /** Roster: sink → the identity it was opened under (`undefined` = unbound). */
  const subscribers = new Map<SseSink, SseIdentity | undefined>()
  let closed = false

  const heartbeat = scheduler.setInterval(() => {
    for (const sink of subscribers.keys()) safeWrite(sink, ': heartbeat\n\n')
    // The same tick that keeps live streams open retires the dead ones.
    void sweepSessions()
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

  /** Ends one stream and frees its slot. Safe on an already-torn-down peer. */
  function endStream(sink: SseSink): void {
    subscribers.delete(sink)
    try {
      sink.end()
    } catch {
      // A stream already torn down by its peer needs nothing from us.
    }
  }

  function hasCapacity(): boolean {
    return !closed && subscribers.size < maxSubscribers
  }

  function subscribe(sink: SseSink, identity?: SseIdentity): SubscribeResult {
    if (!hasCapacity()) {
      return { ok: false, reason: 'at-capacity' }
    }
    subscribers.set(sink, identity)
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
    for (const sink of subscribers.keys()) safeWrite(sink, chunk)
  }

  function subscriberCount(): number {
    return subscribers.size
  }

  /** Ends every stream whose identity satisfies `matches`; returns the count. */
  function closeMatching(matches: (identity: SseIdentity) => boolean): number {
    let ended = 0
    for (const [sink, identity] of [...subscribers]) {
      if (identity === undefined || !matches(identity)) continue
      endStream(sink)
      ended += 1
    }
    return ended
  }

  function closeSession(sessionId: string): number {
    return closeMatching((identity) => identity.sessionId === sessionId)
  }

  function closeForAdmin(adminName: string): number {
    return closeMatching((identity) => identity.adminName === adminName)
  }

  /** Fail-closed liveness: an absent identity or a throwing probe means dead. */
  async function isLive(identity: SseIdentity | undefined): Promise<boolean> {
    if (identity === undefined) return false
    try {
      return (await isSessionLive?.(identity)) === true
    } catch {
      return false
    }
  }

  async function sweepSessions(): Promise<number> {
    if (isSessionLive === undefined || closed) return 0
    // Snapshot first: the probe awaits, and a peer may drop meanwhile.
    const roster = [...subscribers]

    // One probe per distinct sessionId, not per subscriber: several open
    // streams commonly share one session (multiple tabs), and the production
    // probe re-reads admins.json on every call. Deduping here — rather than
    // in the probe itself — keeps `isSessionLive` a pure per-identity check
    // and makes the sharing a hub concern, run once per tick and concurrently
    // across the distinct sessions.
    const firstIdentityBySessionId = new Map<string, SseIdentity>()
    for (const [, identity] of roster) {
      if (identity !== undefined && !firstIdentityBySessionId.has(identity.sessionId)) {
        firstIdentityBySessionId.set(identity.sessionId, identity)
      }
    }
    const liveness = await Promise.all(
      [...firstIdentityBySessionId.entries()].map(
        async ([sessionId, identity]) => [sessionId, await isLive(identity)] as const,
      ),
    )
    const liveBySessionId = new Map(liveness)

    let ended = 0
    for (const [sink, identity] of roster) {
      const isSinkLive = identity !== undefined && (liveBySessionId.get(identity.sessionId) ?? false)
      if (isSinkLive) continue
      if (!subscribers.has(sink)) continue
      endStream(sink)
      ended += 1
    }
    return ended
  }

  function close(): void {
    if (closed) return
    closed = true
    scheduler.clearInterval(heartbeat)
    for (const sink of subscribers.keys()) {
      try {
        sink.end()
      } catch {
        // A stream already torn down by its peer needs nothing from us.
      }
    }
    subscribers.clear()
  }

  return Object.freeze({
    hasCapacity,
    subscribe,
    publish,
    subscriberCount,
    closeSession,
    closeForAdmin,
    sweepSessions,
    close,
  })
}
