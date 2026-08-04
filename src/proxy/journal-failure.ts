import type { Writable } from 'node:stream'
import { SIGKILL_ESCALATION_MS } from '../config.js'
import { killWithEscalation, type ServerHandle } from './spawn.js'
import type { RelayWiring } from './wire-policy.js'

/**
 * Fail-closed journaling: "no audit record, no traffic".
 *
 * A record the sink could not write even after its retry is not a warning
 * here — it is the end of the session. The relay is stopped immediately (so
 * no further message crosses unjournaled), the wrapped child is killed, and
 * the run reports `EXIT_CODE_JOURNAL_FAILURE` instead of the child's own
 * exit code. This is exactly the guarantee an auditor buys: a session
 * either has a complete journal, or it visibly failed.
 *
 * Only armed when the flag is on (`--fail-closed`, or
 * `journal.failClosed` in the policy). Without it the sink keeps its M1
 * fail-open behavior and this controller is never consulted.
 */

/** Signal used to shut the wrapped child down after an unrecoverable journal failure. */
const SHUTDOWN_SIGNAL: NodeJS.Signals = 'SIGTERM'

export interface JournalFailureController {
  /** Whether an unrecoverable journal write failure ended this session. */
  hasFailed(): boolean
  /**
   * Supplies the shutdown targets. Separate from construction because the
   * sink — the thing that can fail — must exist before the child is spawned
   * and the relay is wired. A failure reported before arming is honored as
   * soon as arming happens.
   */
  arm(target: Pick<ServerHandle, 'kill' | 'exitCode'>, relay: Pick<RelayWiring, 'dispose'>): void
  /** The sink's `onWriteError`: one dropped record ends the session. */
  report(error: unknown, droppedCount: number): void
  /** Prints the final dropped-record count at exit, only if this run failed closed. */
  reportDropped(droppedCount: number): void
}

export interface JournalFailureControllerOptions {
  /** Where diagnostics are written. Defaults to process.stderr. */
  readonly diagnostics?: Writable
  /** Grace period before escalating the shutdown signal to SIGKILL. */
  readonly killEscalationMs?: number
}

export function createJournalFailureController(
  opts: JournalFailureControllerOptions = {},
): JournalFailureController {
  const diagnostics = opts.diagnostics ?? process.stderr
  const killEscalationMs = opts.killEscalationMs ?? SIGKILL_ESCALATION_MS
  let hasFailed = false
  let target: Pick<ServerHandle, 'kill' | 'exitCode'> | undefined
  let relay: Pick<RelayWiring, 'dispose'> | undefined

  /** Idempotent, and safe to call before `arm()` — it then simply waits for it. */
  function stopSession(): void {
    if (target === undefined || relay === undefined) {
      return
    }
    // Order matters: stop relaying first, so nothing else can cross while
    // the child is still dying.
    relay.dispose()
    killWithEscalation(target, SHUTDOWN_SIGNAL, killEscalationMs)
  }

  return {
    hasFailed: () => hasFailed,
    arm: (nextTarget, nextRelay) => {
      target = nextTarget
      relay = nextRelay
      if (hasFailed) {
        stopSession()
      }
    },
    report: (error) => {
      if (hasFailed) {
        return
      }
      hasFailed = true
      logJournalFailure(diagnostics, error)
      stopSession()
    },
    reportDropped: (droppedCount) => {
      if (!hasFailed) {
        return
      }
      diagnostics.write(`[wrap] journal records dropped this session: ${droppedCount}\n`)
    },
  }
}

function logJournalFailure(diagnostics: Writable, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  diagnostics.write(
    '[wrap] journal write failed and journaling is fail-closed; ' +
      `stopping traffic and shutting the wrapped server down: ${message}\n`,
  )
}
