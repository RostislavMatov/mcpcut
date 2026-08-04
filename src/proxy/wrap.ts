import type { Readable, Writable } from 'node:stream'
import { ulid } from 'ulid'
import { RELAY_DRAIN_TIMEOUT_MS, SIGKILL_ESCALATION_MS } from '../config.js'
import {
  createRecordBuilder,
  type ClientServerDirection,
  type JournalDirection,
  type RecordBuilder,
} from '../journal/record.js'
import { createJournalSink, type JournalSink } from '../journal/sink.js'
import { classify } from '../protocol/classify.js'
import {
  DEFAULT_FORWARDED_SIGNALS,
  installSignalForwarding,
  killWithEscalation,
  spawnServer,
  type ServerHandle,
} from './spawn.js'
import { splice, type SpliceErrorOrigin, type SpliceHandle } from './splice.js'

/**
 * Orchestrates one `mcp-journal wrap` run: spawns the wrapped MCP server,
 * splices client stdio through it in both directions, journals every line
 * (redacted) plus stderr, and forwards signals to the child.
 *
 * This is the only module that wires spawn + splice + classify + journal
 * together — each of those stays ignorant of the others, so this module is
 * the one place that can break the architectural invariant. Keep it thin.
 */

/** Exit code reported when a stream failure forced a shutdown but the child still exited 0. */
const STREAM_FAILURE_EXIT_CODE = 1

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
}

/**
 * Runs the wrapped server to completion and resolves with its mapped exit
 * code. Rejects only if the child could not be spawned at all (see
 * spawnServer's SpawnServerError) — journal write failures never throw.
 *
 * Shutdown order matters and is asserted by tests: drain the relay, then
 * detach the splices, then flush the journal, then uninstall signal handlers.
 */
export async function runWrap(
  command: string,
  args: readonly string[] = [],
  opts: RunWrapOptions = {},
): Promise<number> {
  const sessionId = opts.sessionId ?? ulid()
  const recordBuilder = createRecordBuilder(sessionId, opts.now !== undefined ? { now: opts.now } : {})
  const sink = createJournalSink(sessionId, opts.dir !== undefined ? { dir: opts.dir } : {})
  const clientStderr = opts.stderr ?? process.stderr
  const killEscalationMs = opts.killEscalationMs ?? SIGKILL_ESCALATION_MS
  const relayDrainTimeoutMs = opts.relayDrainTimeoutMs ?? RELAY_DRAIN_TIMEOUT_MS

  const handle = spawnServer(command, args, opts.cwd !== undefined ? { cwd: opts.cwd } : {})
  const signalHandle = installSignalForwarding(handle, DEFAULT_FORWARDED_SIGNALS, { killEscalationMs })
  const shutdown = createShutdownController(handle, { diagnostics: clientStderr, killEscalationMs })
  const wiring = wireStdio({
    handle,
    clientStdin: opts.stdin ?? process.stdin,
    clientStdout: opts.stdout ?? process.stdout,
    clientStderr,
    recordBuilder,
    sink,
    shutdown,
  })

  try {
    const childExitCode = await handle.exitCode()
    // The child's stdio is drained, but its last chunks may still be in
    // flight to a slow client: never resolve before they have landed — but
    // never wait forever for a client that has stopped reading, either.
    await drainWithTimeout({
      relayed: wiring.relayed,
      timeoutMs: relayDrainTimeoutMs,
      onTimeout: () => logRelayDrainTimeout(clientStderr, relayDrainTimeoutMs),
    })
    return shutdown.hasFailed() ? failureExitCode(childExitCode) : childExitCode
  } finally {
    wiring.dispose()
    await sink.close()
    signalHandle.uninstall()
  }
}

/** Upgrades a successful child exit to non-zero when the proxy itself hit a stream failure. */
function failureExitCode(childExitCode: number): number {
  return childExitCode === 0 ? STREAM_FAILURE_EXIT_CODE : childExitCode
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

interface WiringArgs {
  readonly handle: ServerHandle
  readonly clientStdin: Readable
  readonly clientStdout: Writable
  readonly clientStderr: Writable
  readonly recordBuilder: RecordBuilder
  readonly sink: JournalSink
  readonly shutdown: ShutdownController
}

interface StdioWiring {
  /** Detaches every listener the splices installed, in all three directions. */
  readonly dispose: () => void
  /** Resolves once all server→client output (stdout and stderr) has been relayed. */
  readonly relayed: Promise<void>
}

/** Splices client stdio through the child in both directions, tapping each line into the journal. */
function wireStdio(args: WiringArgs): StdioWiring {
  const { handle, clientStderr, recordBuilder, sink, shutdown } = args
  const errorsOf =
    (channel: JournalDirection) =>
    (error: unknown, origin: SpliceErrorOrigin): void =>
      shutdown.report(channel, error, origin)

  const toServer = splice(
    args.clientStdin,
    handle.stdin,
    (line) => tapMessage(recordBuilder, sink, line, 'client→server', clientStderr),
    { onError: errorsOf('client→server') },
  )

  const toClient = splice(
    handle.stdout,
    args.clientStdout,
    (line) => tapMessage(recordBuilder, sink, line, 'server→client', clientStderr),
    { endDestination: false, onError: errorsOf('server→client') },
  )

  const stderrRelay = splice(
    handle.stderr,
    clientStderr,
    (line) => tapStderr(recordBuilder, sink, line, clientStderr),
    { endDestination: false, onError: errorsOf('server-stderr') },
  )

  const all: readonly SpliceHandle[] = [toServer, toClient, stderrRelay]
  return {
    dispose: () => {
      for (const spliceHandle of all) {
        spliceHandle.dispose()
      }
    },
    // Deliberately excludes toServer: the client's stdin may stay open long
    // after the child exited, and waiting on it would hang the proxy.
    relayed: Promise.all([toClient.relayed, stderrRelay.relayed]).then(() => undefined),
  }
}

/**
 * Classifies and journals one client<->server line. Wrapped defensively so
 * a classify/build/write failure can never propagate into splice's forwarding
 * path, even though splice already isolates tap errors on its own.
 */
function tapMessage(
  recordBuilder: RecordBuilder,
  sink: JournalSink,
  line: string,
  direction: ClientServerDirection,
  diagnostics: Writable,
): void {
  try {
    const classified = classify(line)
    sink.write(recordBuilder.buildRecord(classified, direction))
  } catch (error) {
    logTapError(diagnostics, error)
  }
}

/** Journals one raw stderr line from the wrapped server. Never throws into splice. */
function tapStderr(
  recordBuilder: RecordBuilder,
  sink: JournalSink,
  line: string,
  diagnostics: Writable,
): void {
  try {
    sink.write(recordBuilder.buildStderrRecord(line))
  } catch (error) {
    logTapError(diagnostics, error)
  }
}

function logTapError(diagnostics: Writable, error: unknown): void {
  diagnostics.write(`[wrap] failed to journal a line: ${describeError(error)}\n`)
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
