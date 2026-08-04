import type { Readable, Writable } from 'node:stream'
import { ulid } from 'ulid'
import {
  createRecordBuilder,
  type ClientServerDirection,
  type JournalDirection,
  type RecordBuilder,
} from '../journal/record.js'
import { createJournalSink, type JournalSink } from '../journal/sink.js'
import { classify } from '../protocol/classify.js'
import { installSignalForwarding, spawnServer, type ServerHandle } from './spawn.js'
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

  const handle = spawnServer(command, args, opts.cwd !== undefined ? { cwd: opts.cwd } : {})
  const signalHandle = installSignalForwarding(handle)
  const shutdown = createShutdownController(handle)
  const wiring = wireStdio({
    handle,
    clientStdin: opts.stdin ?? process.stdin,
    clientStdout: opts.stdout ?? process.stdout,
    clientStderr: opts.stderr ?? process.stderr,
    recordBuilder,
    sink,
    shutdown,
  })

  try {
    const childExitCode = await handle.exitCode()
    // The child's stdio is drained, but its last chunks may still be in
    // flight to a slow client: never resolve before they have landed.
    await wiring.relayed
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

export interface ShutdownController {
  /** Whether an unrecoverable stream failure was seen during this run. */
  hasFailed(): boolean
  /** Routes one splice error: tap errors are logged, stream failures shut the child down. */
  report(channel: JournalDirection, error: unknown, origin: SpliceErrorOrigin): void
}

/**
 * Turns a stream error into a controlled shutdown: kill the child with
 * SIGTERM and let the normal exit path (drain, flush, uninstall) run, rather
 * than letting the error escape as an uncaught exception.
 *
 * Exported so this policy — which of the three channels may fail benignly —
 * can be asserted directly instead of through a racy broken-pipe integration.
 */
export function createShutdownController(target: Pick<ServerHandle, 'kill'>): ShutdownController {
  let hasFailed = false

  return {
    hasFailed: () => hasFailed,
    report: (channel, error, origin) => {
      if (origin === 'tap') {
        logTapError(error)
        return
      }
      if (isExpectedPipeShutdown(channel, origin, error)) {
        return
      }
      hasFailed = true
      logStreamError(channel, error)
      target.kill(SHUTDOWN_SIGNAL)
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
  const { handle, recordBuilder, sink, shutdown } = args
  const errorsOf =
    (channel: JournalDirection) =>
    (error: unknown, origin: SpliceErrorOrigin): void =>
      shutdown.report(channel, error, origin)

  const toServer = splice(
    args.clientStdin,
    handle.stdin,
    (line) => tapMessage(recordBuilder, sink, line, 'client→server'),
    { onError: errorsOf('client→server') },
  )

  const toClient = splice(
    handle.stdout,
    args.clientStdout,
    (line) => tapMessage(recordBuilder, sink, line, 'server→client'),
    { endDestination: false, onError: errorsOf('server→client') },
  )

  const stderrRelay = splice(
    handle.stderr,
    args.clientStderr,
    (line) => tapStderr(recordBuilder, sink, line),
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
): void {
  try {
    const classified = classify(line)
    sink.write(recordBuilder.buildRecord(classified, direction))
  } catch (error) {
    logTapError(error)
  }
}

/** Journals one raw stderr line from the wrapped server. Never throws into splice. */
function tapStderr(recordBuilder: RecordBuilder, sink: JournalSink, line: string): void {
  try {
    sink.write(recordBuilder.buildStderrRecord(line))
  } catch (error) {
    logTapError(error)
  }
}

function logTapError(error: unknown): void {
  process.stderr.write(`[wrap] failed to journal a line: ${describeError(error)}\n`)
}

function logStreamError(channel: JournalDirection, error: unknown): void {
  process.stderr.write(
    `[wrap] ${channel} stream failed, shutting the wrapped server down: ${describeError(error)}\n`,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
