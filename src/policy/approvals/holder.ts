import { randomUUID } from 'node:crypto'
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
 *
 * A pid alone is not an identity: it repeats after a restart (a container's
 * process is pid 1 every time) and two pid namespaces sharing a hostname and
 * a data volume see different processes under one number. So a holder also
 * carries a nonce of its process incarnation, and a process judges a row it
 * holds by what it really holds (`noteHeld`): its own row that it no longer
 * waits on — a withdrawal that failed, say — is gone, not alive (security
 * review of phase B, L2). A row under this pid with another nonce cannot be
 * told apart and stays `unknown`.
 */

/** The process holding a request: stored with its heartbeat. */
export interface HolderIdentity {
  readonly pid: number
  readonly host: string
  /** This incarnation of the process; random per start. */
  readonly nonce: string
}

/** What a liveness probe could establish about a holder. */
export type HolderLiveness = 'alive' | 'gone' | 'unknown'

/** Reads whether `holder` still holds `approvalId`; injectable so tests need no real dead pid. */
export type HolderLivenessProbe = (holder: HolderIdentity, approvalId: string) => HolderLiveness

/** A request's heartbeat and its holder, as stored. */
export interface HoldRecord {
  readonly heartbeatAt: string
  readonly holder: HolderIdentity
}

/** This incarnation of this process. */
const PROCESS_NONCE = randomUUID()

/** The requests a gate of this process is holding right now (the wait runs). */
const heldHere = new Set<string>()

/** This process, as the holder of every request it enqueues. */
export function currentHolder(): HolderIdentity {
  return { pid: process.pid, host: hostname(), nonce: PROCESS_NONCE }
}

/** A gate of this process started holding `approvalId` (its wait runs). */
export function noteHeld(approvalId: string): void {
  heldHere.add(approvalId)
}

/** The wait on `approvalId` ended in this process, however it ended. */
export function noteReleased(approvalId: string): void {
  heldHere.delete(approvalId)
}

/**
 * Signal 0 checks for existence without touching the process. `ESRCH` is the
 * one answer that means gone; `EPERM` means it exists under another user;
 * anything else is not knowledge, so it is `unknown` — and `unknown` never
 * withdraws anything.
 */
export function probeHolderLiveness(holder: HolderIdentity, approvalId: string): HolderLiveness {
  if (holder.host !== hostname()) return 'unknown'
  if (holder.pid === process.pid) {
    if (holder.nonce !== PROCESS_NONCE) return 'unknown'
    return heldHere.has(approvalId) ? 'alive' : 'gone'
  }
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
  approvalId: string,
  hold: HoldRecord | undefined,
  nowMs: number,
  probe: HolderLivenessProbe,
): boolean {
  if (hold === undefined || isFreshHeartbeat(hold.heartbeatAt, nowMs)) return false
  return probe(hold.holder, approvalId) === 'gone'
}
