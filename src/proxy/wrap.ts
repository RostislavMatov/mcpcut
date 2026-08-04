import type { Readable, Writable } from 'node:stream'
import { ulid } from 'ulid'
import {
  createRecordBuilder,
  type ClientServerDirection,
  type RecordBuilder,
} from '../journal/record.js'
import { createJournalSink, type JournalSink } from '../journal/sink.js'
import { classify } from '../protocol/classify.js'
import { installSignalForwarding, spawnServer, type ServerHandle } from './spawn.js'
import { splice } from './splice.js'

/**
 * Orchestrates one `mcp-journal wrap` run: spawns the wrapped MCP server,
 * splices client stdio through it in both directions, journals every line
 * (redacted) plus stderr, and forwards signals to the child.
 *
 * This is the only module that wires spawn + splice + classify + journal
 * together — each of those stays ignorant of the others, so this module is
 * the one place that can break the architectural invariant. Keep it thin.
 */

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
 */
export async function runWrap(
  command: string,
  args: readonly string[] = [],
  opts: RunWrapOptions = {},
): Promise<number> {
  const sessionId = opts.sessionId ?? ulid()
  const recordBuilder = createRecordBuilder(sessionId, opts.now !== undefined ? { now: opts.now } : {})
  const sink = createJournalSink(sessionId, opts.dir !== undefined ? { dir: opts.dir } : {})

  const clientStdin = opts.stdin ?? process.stdin
  const clientStdout = opts.stdout ?? process.stdout
  const clientStderr = opts.stderr ?? process.stderr

  const handle = spawnServer(command, args, opts.cwd !== undefined ? { cwd: opts.cwd } : {})
  const signalHandle = installSignalForwarding(handle)

  wireStdio(handle, clientStdin, clientStdout, clientStderr, recordBuilder, sink)

  try {
    return await handle.exitCode()
  } finally {
    signalHandle.uninstall()
    await sink.close()
  }
}

/** Splices client stdio through the child in both directions, tapping each line into the journal. */
function wireStdio(
  handle: ServerHandle,
  clientStdin: Readable,
  clientStdout: Writable,
  clientStderr: Writable,
  recordBuilder: RecordBuilder,
  sink: JournalSink,
): void {
  splice(clientStdin, handle.stdin, (line) => tapMessage(recordBuilder, sink, line, 'client→server'))

  splice(
    handle.stdout,
    clientStdout,
    (line) => tapMessage(recordBuilder, sink, line, 'server→client'),
    { endDestination: false },
  )

  splice(handle.stderr, clientStderr, (line) => tapStderr(recordBuilder, sink, line), {
    endDestination: false,
  })
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
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[wrap] failed to journal a line: ${message}\n`)
}
