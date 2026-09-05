import { errnoCodeOf } from '../errno.js'
import { FORCED_STOP_SETTLE_MS, STOP_POLL_MS } from './constants.js'
import { isProcessAlive, type KillFn } from './pid-file.js'

/**
 * The one way this manager makes a process go away (review TS-H1): SIGTERM,
 * a bounded wait, then SIGKILL — and the promise does not resolve until the
 * process is actually gone.
 *
 * `start` used to do its own escalation with an unref'd timer. That is dead
 * code in a CLI: `mcpcut start` returns, the process exits, and the SIGKILL
 * that was scheduled for later never happens — leaving a daemon that ignores
 * SIGTERM alive on the port whose pid file was just deleted. Waiting is
 * therefore not an implementation detail here; it is the promise, and both
 * `start` and `stop` make the same one.
 */

/** Sending a signal has two honest answers besides "it threw". */
export type SignalOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'refused'; readonly detail: string }

/**
 * Sends one signal, turning the two errnos that are answers rather than
 * failures into results. Honest narrowing without a cast, as
 * `cli/bind-failure.ts` does it.
 */
export function signalProcess(
  pid: number,
  signal: NodeJS.Signals,
  kill: KillFn = process.kill,
): SignalOutcome {
  try {
    kill(pid, signal)
    return { kind: 'sent' }
  } catch (error: unknown) {
    const code = errnoCodeOf(error)
    if (code === 'ESRCH') {
      return { kind: 'refused', detail: `pid ${pid} was already gone` }
    }
    if (code === 'EPERM') {
      return { kind: 'refused', detail: `pid ${pid} belongs to another user: mcpcut cannot signal it` }
    }
    throw error
  }
}

/** Seams of one termination; every default is the real thing. */
export interface TerminateOptions {
  /** How long SIGTERM is given before SIGKILL follows. */
  readonly escalationMs: number
  /** Gap between liveness checks. */
  readonly pollMs?: number
  /** How long SIGKILL is given to take effect before we stop watching. */
  readonly settleMs?: number
  readonly isAlive?: (pid: number) => boolean
  readonly signal?: (pid: number, signal: NodeJS.Signals) => SignalOutcome
}

/**
 * What became of the process. `refused` means the first signal was not
 * delivered at all — it was already gone, or it is not ours to signal — which
 * a caller must report rather than claim as a stop.
 */
export type TerminateOutcome =
  | { readonly kind: 'gone'; readonly forced: boolean }
  | { readonly kind: 'refused'; readonly detail: string }

/**
 * Terminates one process and waits for it.
 *
 * Real time, not an injected clock: elapsed wall time is not a thing a caller
 * gets to redefine, and a frozen test clock must not be able to wedge this
 * loop (the rule `manager-start.ts` states for its readiness deadline).
 */
export async function terminateProcess(
  pid: number,
  options: TerminateOptions,
): Promise<TerminateOutcome> {
  const alive = options.isAlive ?? isProcessAlive
  const send = options.signal ?? ((target, name) => signalProcess(target, name))
  const pollMs = options.pollMs ?? STOP_POLL_MS

  const sent = send(pid, 'SIGTERM')
  if (sent.kind === 'refused') return sent

  const deadline = Date.now() + options.escalationMs
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      send(pid, 'SIGKILL')
      await settleAfterKill(pid, alive, pollMs, options.settleMs ?? FORCED_STOP_SETTLE_MS)
      return { kind: 'gone', forced: true }
    }
    await sleep(pollMs)
  }
  return { kind: 'gone', forced: false }
}

/**
 * Gives SIGKILL a bounded moment to take effect — see `FORCED_STOP_SETTLE_MS`.
 * SIGKILL cannot be caught, so anything still here is in a state no signal
 * reaches (uninterruptible I/O, or a zombie waiting to be reaped) and waiting
 * longer buys nothing.
 */
async function settleAfterKill(
  pid: number,
  alive: (pid: number) => boolean,
  pollMs: number,
  settleMs: number,
): Promise<void> {
  const deadline = Date.now() + settleMs
  while (alive(pid) && Date.now() < deadline) {
    await sleep(pollMs)
  }
}

/** The shared sleep of the manager's poll loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
