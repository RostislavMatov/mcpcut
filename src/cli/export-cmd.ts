import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from '../journal/db.js'
import { iterateAllDocs, iterateSessionDocs } from '../journal/db-read.js'
import { listUnimportedLegacySessions } from '../journal/import.js'
import { assertValidSessionId } from '../journal/session-id.js'
import { runExportReportCommand } from './report-cmd.js'

/**
 * `mcpcut export` — streams the journal's records as JSONL to stdout,
 * one `doc` per line, verbatim as persisted. Whole-journal export walks
 * `journal.db` in `seq` order (global write order — the order M5's hash
 * chain will attest); `--session <id>` narrows to one session's own `seq`
 * order.
 *
 * `doc` is written exactly as `journal_records` stores it: redaction-only
 * persistence (`config.ts`'s redaction pass runs before a record ever
 * reaches the sink) holds by construction, so export never re-validates or
 * re-redacts. A `doc` row that fails to parse as JSON is exported verbatim
 * too — export is evidence of what the journal holds, not a validator of it;
 * a reader that wants skip-counted, re-validated records wants `show`
 * instead.
 */

/** Minimal writable-stream shape this command needs, so tests can inject capture objects. */
export interface ExportCliWritable {
  write(chunk: string): unknown
  /**
   * Present on a real stream, optional for a capture object: an export of a
   * multi-gigabyte journal piped into a slow consumer must park on
   * backpressure instead of buffering the whole journal in memory (see
   * `writeDocs`).
   */
  once?(event: 'drain', listener: () => void): unknown
}

export interface ExportCliIo {
  readonly stdout: ExportCliWritable
  readonly stderr: ExportCliWritable
}

/** Test seam: journal directory override. */
export interface ExportCommandOptions {
  readonly journalDir?: string
}

const USAGE =
  'Usage: mcpcut export [--session <id>]\n' +
  '       mcpcut export --report [--session <id>] [--out <dir>]\n' +
  'Export journal records as JSONL to stdout, or (--report) as an\n' +
  'evidentiary report directory -- report.json, records.jsonl, summary.md,\n' +
  'and signature.json when a signing key exists ("mcpcut keygen").\n' +
  '--out defaults to "mcpcut-report" under the current directory and\n' +
  'must be an empty or nonexistent directory.\n'

/**
 * Dispatches `export`. Probes `journal.db` (never creates it): a fresh
 * install with no database yields exit 0 and empty stdout, same as no
 * matching rows. The un-imported-legacy hint (`journal-cmds.ts`'s wording)
 * is printed on stderr after the data, unconditionally attempted, same
 * best-effort contract as `sessions`/`show`.
 *
 * `--report` (M5 wave 5, task 5.1) delegates to `report-cmd.ts` entirely --
 * it is a different output shape (a directory of files, not a stdout
 * stream) with its own refusal and exit-code rules, so this function's only
 * job for that branch is argv parsing shared with plain `export`.
 */
export async function runExportCommand(
  args: readonly string[],
  io: ExportCliIo,
  opts: ExportCommandOptions = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      session: { type: 'string' },
      report: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
    allowPositionals: true,
  })
  if (positionals.length > 0) {
    io.stderr.write(`export takes no positional arguments (got: ${positionals.join(' ')})\n\n${USAGE}`)
    return 1
  }

  if (values.out !== undefined && values.report !== true) {
    // A flag the operator actually typed must never be silently dropped --
    // especially one that names WHERE evidence lands. Swallowing `--out`
    // here would mean a mistyped invocation prints JSONL to stdout with no
    // directory and no word of explanation, discovered only once the
    // missing evidence is actually needed.
    io.stderr.write(
      `--out only applies together with --report (got: --out ${values.out} without --report)\n` +
        `Did you mean: mcpcut export --report --out ${values.out}\n\n${USAGE}`,
    )
    return 1
  }

  const journalDir = opts.journalDir ?? JOURNAL_DIR

  if (values.report === true) {
    return runExportReportCommand(io, {
      journalDir,
      ...(values.session === undefined ? {} : { session: values.session }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
    })
  }

  const handle = await openJournalDbIfPresent(journalDir)
  if (handle !== null) {
    await writeDocs(io, docsToExport(handle, values.session))
  }

  await writeLegacyHint(io, journalDir)
  return 0
}

function docsToExport(
  handle: NonNullable<Awaited<ReturnType<typeof openJournalDbIfPresent>>>,
  sessionId: string | undefined,
): Generator<string> {
  if (sessionId === undefined) {
    return iterateAllDocs(handle)
  }
  assertValidSessionId(sessionId)
  return iterateSessionDocs(handle, sessionId)
}

/**
 * Streams the docs out, treating the destination's backpressure signal as
 * authoritative the way `proxy/writer.ts` does: a `write()` that answers
 * exactly `false` means the stream's buffer is full, and continuing to push
 * into it grows RSS without bound — a whole journal's worth, when the export
 * is piped into gzip or a socket. A capture object that answers `undefined`
 * (no backpressure signal, no `once`) never parks.
 */
async function writeDocs(io: ExportCliIo, docs: Generator<string>): Promise<void> {
  for (const doc of docs) {
    if (io.stdout.write(`${doc}\n`) === false) {
      await drained(io.stdout)
    }
  }
}

/** Resolves on the stream's next `'drain'`; a writable without `once` resolves at once. */
function drained(stdout: ExportCliWritable): Promise<void> {
  const once = stdout.once
  if (typeof once !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    once.call(stdout, 'drain', () => resolve())
  })
}

/**
 * Best-effort, matching `journal-cmds.ts`'s `unimportedLegacySessions`: a
 * directory that cannot be probed degrades to no hint rather than failing a
 * command whose real output already succeeded.
 */
async function writeLegacyHint(io: ExportCliIo, journalDir: string): Promise<void> {
  try {
    const unimported = await listUnimportedLegacySessions(journalDir)
    if (unimported.length > 0) {
      io.stderr.write(
        `${unimported.length} legacy *.jsonl session file(s) are not imported; ` +
          'run `mcpcut migrate` to see them.\n',
      )
    }
  } catch {
    // best-effort hint; the command's real output already succeeded
  }
}
