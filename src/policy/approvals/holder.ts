import { hostname } from 'node:os'
import { APPROVAL_HEARTBEAT_STALE_MS } from '../constants.js'

/**
 * Who holds a pending request, and whether that holder is gone (decision M36,
 * review R3). The heartbeat alone cannot tell a dead process from a sleeping
 * one: a laptop that slept for an hour wakes with every heartbeat stale, and
 * the first list or UI poll after wake would withdraw live calls whose agents
 * are still waiting. So the process holding a request records its pid and
 * host beside the heartbeat, and a stale heartbeat counts as "the holder is
 * lost" only when that process is provably gone — on this host, by pid. A
 * holder on another host, or one whose liveness cannot be read, is never
 * judged: only the request's own 24-hour cap settles it.
 */

/** The process holding a request: stored with its heartbeat. */
export interface HolderIdentity {
  readonly pid: number
  readonly host: string
}

/** What a liveness probe could establish about a holder. */
export type HolderLiveness = 'alive' | 'gone' | 'unknown'

/** Reads whether `holder` still runs; injectable so tests need no real dead pid. */
export type HolderLivenessProbe = (holder: HolderIdentity) => HolderLiveness

/** A request's heartbeat and its holder, as stored. */
export interface HoldRecord {
  readonly heartbeatAt: string
  readonly holder: HolderIdentity
}

/** This process, as the holder of every request it enqueues. */
export function currentHolder(): HolderIdentity {
  return { pid: process.pid, host: hostname() }
}

/**
 * Signal 0 checks for existence without touching the process. `ESRCH` is the
 * one answer that means gone; `EPERM` means it exists under another user;
 * anything else is not knowledge, so it is `unknown` — and `unknown` never
 * withdraws anything.
 */
export function probeHolderLiveness(holder: HolderIdentity): HolderLiveness {
  if (holder.host !== hostname()) return 'unknown'
  if (holder.pid === process.pid) return 'alive'
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown'
  try {
    process.kill(holder.pid, 0)
    return 'alive'
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    if (code === 'ESRCH') return 'gone'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

/** A heartbeat no older than the stale limit; the limit itself is still fresh. */
export function isFreshHeartbeat(heartbeatAt: string, nowMs: number): boolean {
  const atMs = Date.parse(heartbeatAt)
  return !Number.isNaN(atMs) && nowMs - atMs <= APPROVAL_HEARTBEAT_STALE_MS
}

/**
 * True when nothing can deliver an answer to this request any more: its
 * heartbeat went stale AND its holder is provably gone. A request without a
 * hold record (an older build enqueued it) is never judged lost.
 */
export function isHolderLost(
  hold: HoldRecord | undefined,
  nowMs: number,
  probe: HolderLivenessProbe,
): boolean {
  if (hold === undefined || isFreshHeartbeat(hold.heartbeatAt, nowMs)) return false
  return probe(hold.holder) === 'gone'
}
