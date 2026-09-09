import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { JOURNAL_FILE_MODE } from '../config.js'
import { captureBothIo, type CaptureWritable } from '../setup/capture-io.js'
import { savedPartiallyLine, savedToLine } from './constants.js'

/**
 * Where a run's output goes (mcpcut phase 4, task 8).
 *
 * The console shows a command's output in a pane it holds in memory, which is
 * the right answer for `admin list` and the wrong one for `export`: a journal
 * export is unbounded, and a console that buffered one would die of it. So an
 * action may name an output path, and then stdout goes to a file while the
 * pane shows a single line of receipt — how much went where.
 *
 * Both cases are one interface, so the effect that runs a command does not
 * branch on which it got: it opens a sink, dispatches into `sink.io`, closes
 * the sink, and reads `out()`/`err()` back. The differences live here.
 *
 * The file is created `wx` at 0600 — the same exclusive create the signing
 * key and the preflight probe use (`src/journal/signing.ts`,
 * `src/setup/checks.ts`). Exclusivity is not tidiness: without it an export
 * would truncate whatever the path already named, and a symbolic link planted
 * at that path would redirect the write into a file of someone else's
 * choosing. `EEXIST` is the refusal both of those deserve.
 */

/**
 * The writable a sink hands the command as its stdout: `CaptureWritable`,
 * plus the optional `once('drain')` of `ExportCliWritable` (`export-cmd.ts`).
 * A file sink forwards it to the real stream, so an export of a large journal
 * parks on backpressure instead of buffering the whole of it in memory.
 *
 * `once('drain')` is a RELEASE, not a plain event forward. `export-cmd.ts`
 * awaits it whenever a write is refused, and a stream that has errored never
 * emits `'drain'` again — so a naive forward left the command parked for
 * ever, and with it the effect, the `Msg`, and a console stuck on `busy`.
 * Whatever ends the wait — a real drain, the error, the close — releases the
 * listener exactly once (phase 4 review, H1).
 */
export interface SinkWritable extends CaptureWritable {
  once?(event: 'drain', listener: () => void): unknown
}

/** Somewhere for one run's two streams to go, and a way to close it. */
export interface RunSink {
  readonly io: { readonly stdout: SinkWritable; readonly stderr: CaptureWritable }
  /** What the output pane shows as stdout: the text, or the file's receipt. */
  out(): string
  /** Everything written to stderr, exactly as the command wrote it. */
  err(): string
  /** True once a write past the limit was dropped from a captured stream. */
  truncated(): boolean
  /** Flushes and closes what needs closing; rejects with the write failure, if any. */
  finish(): Promise<void>
}

/** The sink the output pane draws from: both streams kept in memory, nothing to close. */
export function memorySink(limitChars: number): RunSink {
  const captured = captureBothIo(limitChars)
  return {
    io: captured.io,
    out: captured.out,
    err: captured.err,
    truncated: captured.truncated,
    finish: () => Promise.resolve(),
  }
}

/** How the file is opened. Exported so the one test that needs the stream opens it this way too. */
export type SinkStreamFactory = (path: string) => WriteStream

/** Exclusive create at `JOURNAL_FILE_MODE` (0600): an existing path or symlink is `EEXIST`. */
export function exclusiveStream(path: string): WriteStream {
  return createWriteStream(path, { flags: 'wx', mode: JOURNAL_FILE_MODE })
}

/**
 * A sink whose stdout is a file and whose stderr is still captured — the
 * refusals and hints a command prints belong on screen, however much data
 * went to disk.
 *
 * Rejects when the file cannot be created (`EEXIST`, `ENOENT`, `EACCES`); the
 * caller turns that into a failed run and never dispatches, because there is
 * nowhere to put what the command would print.
 */
export async function fileSink(
  path: string,
  limitChars: number,
  openStream: SinkStreamFactory = exclusiveStream,
): Promise<RunSink> {
  const stream = openStream(path)
  // `once` from `node:events` rejects on an `'error'` that arrives before
  // `'open'`, and consumes it: a second listener before this point would take
  // the same event twice. After it, one is mandatory — an ENOSPC on a stream
  // nobody listens to is an `uncaughtException`, and that would close the
  // console rather than fail one run.
  await once(stream, 'open')
  const captured = captureBothIo(limitChars)
  let failure: Error | undefined
  let incomplete = false
  // `on`, not `once`: closing an already-failed stream can emit a second
  // error, and the whole point of the listener is that none of them escapes.
  // The first is the one that explains the rest, so later ones are dropped.
  stream.on('error', (error: Error) => {
    failure ??= error
  })
  // `destroy()` marks the stream at once but emits its `'error'` a tick
  // later, so the flag alone would miss the window in between — and in that
  // window `write` still answers `false` and `'drain'` is already impossible.
  const hasFailed = (): boolean => failure !== undefined || stream.destroyed

  return {
    io: {
      stdout: {
        // Once the stream has failed the chunk is dropped and the write
        // SUCCEEDS. The file is already lost — `finish()` says so — and the
        // only thing a `false` could still buy is another writer parked on a
        // `'drain'` that is never coming.
        write: (chunk: string) => (hasFailed() ? true : stream.write(chunk)),
        once: (_event: 'drain', listener: () => void) =>
          releaseOnSettled(stream, hasFailed(), listener),
      },
      stderr: captured.io.stderr,
    },
    out: () =>
      incomplete ? savedPartiallyLine(path, stream.bytesWritten) : savedToLine(path, stream.bytesWritten),
    err: captured.err,
    truncated: captured.truncated,
    finish: async () => {
      stream.end()
      const closeFailure = await closedQuietly(stream)
      const problem = failure ?? closeFailure
      if (problem === undefined) return
      incomplete = true
      throw problem
    },
  }
}

/**
 * Releases a writer parked on backpressure, whatever ends the wait.
 *
 * The three events are one-shot together: the first to arrive calls the
 * listener and detaches the other two, so a `'close'` following an `'error'`
 * cannot call a command's continuation twice. A stream that has ALREADY
 * failed or been destroyed releases on the next microtask instead — the event
 * that would have freed the writer has gone by, and waiting for it would be
 * the very deadlock this exists to prevent.
 */
function releaseOnSettled(stream: WriteStream, hasFailed: boolean, listener: () => void): void {
  if (hasFailed) {
    queueMicrotask(listener)
    return
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    for (const event of SETTLING_EVENTS) stream.off(event, release)
    listener()
  }
  for (const event of SETTLING_EVENTS) stream.once(event, release)
}

/** Everything that can end a wait for backpressure to clear: it drained, or it will never drain. */
const SETTLING_EVENTS: readonly string[] = ['drain', 'error', 'close']

/**
 * Waits for the stream to be done with, and answers with the failure instead
 * of throwing it — so the caller may prefer the error the write itself
 * reported over the one closing derived from it.
 */
async function closedQuietly(stream: WriteStream): Promise<Error | undefined> {
  try {
    await finished(stream)
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
