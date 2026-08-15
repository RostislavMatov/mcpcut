import type { Readable, Writable } from 'node:stream'
import { ulid } from 'ulid'
import { RELAY_DRAIN_TIMEOUT_MS, SIGKILL_ESCALATION_MS } from '../config.js'
import { createRecordBuilder, type JournalDirection } from '../journal/record.js'
import { createJournalSink, type JournalSinkOptions } from '../journal/sink.js'
import type { Policy } from '../policy/schema.js'
import type { GateAgentScope } from './gate.js'
import {
  createJournalFailureController,
  type JournalFailureController,
} from './journal-failure.js'
import { logTapError, wireRelay, type RelayArgs } from './relay.js'
import {
  DEFAULT_FORWARDED_SIGNALS,
  installSignalForwarding,
  killWithEscalation,
  spawnServer,
  type ServerHandle,
} from './spawn.js'
import type { SpliceErrorOrigin } from './splice.js'
import { autoServerName } from './wire-policy.js'

/**
 * Orchestrates one `mcp-journal wrap` run: spawns the wrapped MCP server,
 * relays client stdio through it in both directions, journals every line
 * (redacted) plus stderr, and forwards signals to the child.
 *
 * Two relay modes, chosen by whether a policy was supplied:
 *  - **Mode A (no policy)** — the M1 behavior, unchanged: byte-for-byte
 *    splices with a passive journal tap. Nothing is ever intercepted.
 *  - **Mode B (policy active)** — message pipelines around the policy gate
 *    (`wire-policy.ts`), which may answer a `tools/call` locally instead of
 *    forwarding it. Byte identity holds per message rather than per chunk.
 *
 * The policy itself is *never* loaded here: the caller (CLI) resolves and
 * validates it, so a bad policy fails before anything is spawned and this
 * module stays testable without touching disk.
 *
 * This is the only module that wires spawn + relay + classify + journal
 * together — each of those stays ignorant of the others, so this module is
 * the one place that can break the architectural invariant. Keep it thin.
 */

/** Exit code reported when a stream failure forced a shutdown but the child still exited 0. */
const STREAM_FAILURE_EXIT_CODE = 1

/**
 * Exit code reported when fail-closed journaling could not write a record:
 * "no audit record, no traffic". Distinct from every child exit code the
 * proxy passes through, so a supervisor can tell the two apart.
 */
export const EXIT_CODE_JOURNAL_FAILURE = 3

/** Signal used to shut the wrapped child down after an unrecoverable stream failure. */
const SHUTDOWN_SIGNAL: NodeJS.Signals = 'SIGTERM'

/** Error codes meaning "the other end of this pipe is already gone". */
const PIPE_GONE_ERROR_CODES: readonly string[] = [
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]

export interface RunWrapOptions {
  /** Journal directory. Defaults to JOURNAL_DIR via createJournalSink. */
  readonly dir?: string
  /** Injectable session id, for deterministic tests. Defaults to a fresh ulid(). */
  readonly sessionId?: string
  /** Injectable clock for the record builder, for deterministic tests. */
  readonly now?: () => number
  /** Client-facing input stream. Defaults to process.stdin. */
  readonly stdin?: Readable
  /** Client-facing output stream. Defaults to process.stdout. */
  readonly stdout?: Writable
  /** Client-facing stderr passthrough stream. Defaults to process.stderr. */
  readonly stderr?: Writable
  /** Working directory for the spawned server. */
  readonly cwd?: string
  /**
   * Grace period after forwarding a shutdown signal to the child before
   * escalating to SIGKILL. Defaults to SIGKILL_ESCALATION_MS. Injectable so
   * tests do not have to wait out the real grace period.
   */
  readonly killEscalationMs?: number
  /**
   * Max time to wait for the server→client relay to drain after the child
   * has exited, before proceeding with shutdown anyway. Defaults to
   * RELAY_DRAIN_TIMEOUT_MS. Injectable so tests do not have to wait out the
   * real timeout.
   */
  readonly relayDrainTimeoutMs?: number
  /**
   * Pre-loaded, already-validated policy. Its presence is what selects mode
   * B; omitting it keeps the exact M1 splice relay. Loading is the caller's
   * job (see the module doc comment).
   */
  readonly policy?: Policy
  /**
   * Identity this server is known by in policy rules and quarantine.
   * Defaults to `auto:<sha256(command+args) prefix>`.
   */
  readonly serverName?: string
  /** Approvals queue root. Defaults to `<journal dir>/approvals`. */
  readonly approvalsBaseDir?: string
  /** Tool inventory store file. Defaults to `<journal dir>/tool-inventory.json`. */
  readonly inventoryStorePath?: string
  /** Agent scope (M3, set by `connect`; never by ad-hoc `wrap` — exactly M2). Mode B only. */
  readonly agentScope?: GateAgentScope
  /**
   * Forces fail-closed journaling on regardless of `policy.journal.failClosed`
   * (the `--fail-closed` flag). Never forces it *off*: a policy that asks for
   * fail-closed always gets it.
   */
  readonly failClosed?: boolean
  /**
   * @internal test-only seam for injecting a failing journal batch commit, so
   * fail-closed behavior can be exercised without an unwritable disk.
   */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}

/**
 * Runs the wrapped server to completion and resolves with its mapped exit
 * code. Rejects only if the child could not be spawned at all (see
 * spawnServer's SpawnServerError) — journal write failures never throw.
 *
 * Shutdown order matters and is asserted by tests: drain the relay, cancel
 * anything still waiting on a human, then detach the relay, then flush the
 * journal, then uninstall signal handlers.
 */
export async function runWrap(
  command: string,
  args: readonly string[] = [],
  opts: RunWrapOptions = {},
): Promise<number> {
  const sessionId = opts.sessionId ?? ulid()
  const recordBuilder = createRecordBuilder(sessionId, opts.now !== undefined ? { now: opts.now } : {})
  const clientStderr = opts.stderr ?? process.stderr
  const killEscalationMs = opts.killEscalationMs ?? SIGKILL_ESCALATION_MS
  const relayDrainTimeoutMs = opts.relayDrainTimeoutMs ?? RELAY_DRAIN_TIMEOUT_MS
  const isFailClosed = failClosedOf(opts)
  const journalFailure = createJournalFailureController({ diagnostics: clientStderr, killEscalationMs })
  const sink = createJournalSink(sessionId, sinkOptionsOf(opts, isFailClosed, journalFailure))

  const handle = spawnServer(command, args, opts.cwd !== undefined ? { cwd: opts.cwd } : {})
  const signalHandle = installSignalForwarding(handle, DEFAULT_FORWARDED_SIGNALS, { killEscalationMs })
  const shutdown = createShutdownController(handle, { diagnostics: clientStderr, killEscalationMs })
  const wiring = wireRelay({
    handle,
    clientStdin: opts.stdin ?? process.stdin,
    clientStdout: opts.stdout ?? process.stdout,
    clientStderr,
    recordBuilder,
    sink,
    reportError: (channel, error, origin) => shutdown.report(channel, error, origin),
    sessionId,
    policy: effectivePolicyOf(opts, isFailClosed),
    serverName: opts.serverName ?? autoServerName(command, args),
    ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
    ...policyLocationsOf(opts),
  })
  journalFailure.arm(handle, wiring)

  try {
    const childExitCode = await handle.exitCode()
    await drainRelay(wiring.relayed, relayDrainTimeoutMs, clientStderr)
    // Before the writers go away in `dispose()`: a cancelled approval
    // answers the client with a timeout error, which still has to reach it.
    await wiring.cancelPending()
    return exitCodeOf({ childExitCode, shutdown, journalFailure })
  } finally {
    wiring.dispose()
    await sink.close()
    journalFailure.reportDropped(sink.droppedRecordCount())
    signalHandle.uninstall()
  }
}

/**
 * The child's stdio is drained, but its last chunks may still be in flight
 * to a slow client: never resolve before they have landed — and never wait
 * forever for a client that has stopped reading, either.
 */
function drainRelay(
  relayed: Promise<void>,
  timeoutMs: number,
  diagnostics: Writable,
): Promise<void> {
  return drainWithTimeout({
    relayed,
    timeoutMs,
    onTimeout: () => logRelayDrainTimeout(diagnostics, timeoutMs),
  })
}

interface ExitCodeArgs {
  readonly childExitCode: number
  readonly shutdown: ShutdownController
  readonly journalFailure: JournalFailureController
}

/**
 * A journal failure outranks every other outcome: the session was cut short
 * precisely because its audit trail could not be written, and that must not
 * be reported as the child's own (possibly successful) exit.
 */
function exitCodeOf(args: ExitCodeArgs): number {
  if (args.journalFailure.hasFailed()) {
    return EXIT_CODE_JOURNAL_FAILURE
  }
  return args.shutdown.hasFailed() ? failureExitCode(args.childExitCode) : args.childExitCode
}

/** Upgrades a successful child exit to non-zero when the proxy itself hit a stream failure. */
function failureExitCode(childExitCode: number): number {
  return childExitCode === 0 ? STREAM_FAILURE_EXIT_CODE : childExitCode
}

/** Forwards only the on-disk locations that were actually specified, so each keeps its own default. */
function policyLocationsOf(
  opts: RunWrapOptions,
): Pick<RelayArgs, 'journalDir' | 'approvalsBaseDir' | 'inventoryStorePath'> {
  return {
    ...(opts.dir !== undefined ? { journalDir: opts.dir } : {}),
    ...(opts.approvalsBaseDir !== undefined ? { approvalsBaseDir: opts.approvalsBaseDir } : {}),
    ...(opts.inventoryStorePath !== undefined
      ? { inventoryStorePath: opts.inventoryStorePath }
      : {}),
  }
}

/** The `--fail-closed` flag only ever turns fail-closed *on*, never off. */
function failClosedOf(opts: RunWrapOptions): boolean {
  return opts.failClosed === true || opts.policy?.journal.failClosed === true
}

/**
 * Applies a `--fail-closed` override to the policy the gate will read, so
 * there is exactly one source of truth for the flag inside the session.
 * Returns the original object when nothing changes (no needless copy).
 */
function effectivePolicyOf(opts: RunWrapOptions, isFailClosed: boolean): Policy | undefined {
  const policy = opts.policy
  if (policy === undefined || policy.journal.failClosed === isFailClosed) {
    return policy
  }
  return { ...policy, journal: { ...policy.journal, failClosed: isFailClosed } }
}

/**
 * Builds the sink options for this run. `onWriteError` is installed *only*
 * when fail-closed: without the flag the sink keeps its M1 fail-open
 * behavior, byte for byte.
 */
function sinkOptionsOf(
  opts: RunWrapOptions,
  isFailClosed: boolean,
  journalFailure: JournalFailureController,
): JournalSinkOptions {
  return {
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(opts.journalCommitBatchImpl !== undefined
      ? { commitBatchImpl: opts.journalCommitBatchImpl }
      : {}),
    ...(isFailClosed ? { onWriteError: journalFailure.report } : {}),
  }
}

interface DrainWithTimeoutArgs {
  /** Never rejects — see splice's RelayTracker, which only ever resolves. */
  readonly relayed: Promise<void>
  readonly timeoutMs: number
  /** Called once, only if the timeout wins the race. */
  readonly onTimeout: () => void
}

/**
 * Waits for the relay to drain, but proceeds regardless once `timeoutMs`
 * elapses — a client that has stopped reading must not hold the proxy open
 * forever. The timer is unref'd so it can never itself keep the event loop
 * alive, and is always cleared once one side of the race settles first.
 */
function drainWithTimeout(args: DrainWithTimeoutArgs): Promise<void> {
  const { relayed, timeoutMs, onTimeout } = args
  return new Promise((resolve) => {
    let hasSettled = false

    const timer = setTimeout(() => {
      if (hasSettled) {
        return
      }
      hasSettled = true
      onTimeout()
      resolve()
    }, timeoutMs)
    timer.unref()

    relayed.then(() => {
      if (hasSettled) {
        return
      }
      hasSettled = true
      clearTimeout(timer)
      resolve()
    })
  })
}

export interface ShutdownController {
  /** Whether an unrecoverable stream failure was seen during this run. */
  hasFailed(): boolean
  /** Routes one splice error: tap errors are logged, stream failures shut the child down. */
  report(channel: JournalDirection, error: unknown, origin: SpliceErrorOrigin): void
}

export interface ShutdownControllerOptions {
  /** Where diagnostics are written. Defaults to process.stderr. */
  readonly diagnostics?: Writable
  /**
   * Grace period before escalating the shutdown signal to SIGKILL. Defaults
   * to SIGKILL_ESCALATION_MS.
   */
  readonly killEscalationMs?: number
}

/**
 * Turns a stream error into a controlled shutdown: kill the child with
 * SIGTERM (escalating to SIGKILL if it does not exit — see
 * spawn.ts's killWithEscalation) and let the normal exit path (drain, flush,
 * uninstall) run, rather than letting the error escape as an uncaught
 * exception.
 *
 * Exported so this policy — which of the three channels may fail benignly —
 * can be asserted directly instead of through a racy broken-pipe integration.
 */
export function createShutdownController(
  target: Pick<ServerHandle, 'kill' | 'exitCode'>,
  opts: ShutdownControllerOptions = {},
): ShutdownController {
  let hasFailed = false
  const diagnostics = opts.diagnostics ?? process.stderr
  const killEscalationMs = opts.killEscalationMs ?? SIGKILL_ESCALATION_MS

  return {
    hasFailed: () => hasFailed,
    report: (channel, error, origin) => {
      if (origin === 'tap') {
        logTapError(diagnostics, error)
        return
      }
      if (isExpectedPipeShutdown(channel, origin, error)) {
        return
      }
      hasFailed = true
      logStreamError(diagnostics, channel, error)
      killWithEscalation(target, SHUTDOWN_SIGNAL, killEscalationMs)
    },
  }
}

/**
 * A broken pipe on the child's stdin means the child is already gone and the
 * client merely wrote one more message into a closing session — a normal
 * shutdown, not a proxy failure.
 */
function isExpectedPipeShutdown(
  channel: JournalDirection,
  origin: SpliceErrorOrigin,
  error: unknown,
): boolean {
  return channel === 'client→server' && origin === 'destination' && isPipeGoneError(error)
}

/** True when a stream error's code says the pipe's peer has gone away. */
export function isPipeGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  return code !== undefined && PIPE_GONE_ERROR_CODES.includes(code)
}

function logStreamError(diagnostics: Writable, channel: JournalDirection, error: unknown): void {
  diagnostics.write(
    `[wrap] ${channel} stream failed, shutting the wrapped server down: ${describeError(error)}\n`,
  )
}

function logRelayDrainTimeout(diagnostics: Writable, timeoutMs: number): void {
  diagnostics.write(
    `[wrap] relay did not drain within ${timeoutMs}ms of the child exiting; shutting down anyway\n`,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
