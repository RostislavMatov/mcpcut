import { open, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import { sessionChainSpan } from '../journal/chain-verify.js'
import { openJournalDbIfPresent } from '../journal/db.js'
import {
  buildJournalReport,
  REPORT_FILES,
  type JournalReport,
  type ReportManifest,
  type ReportRecordSink,
} from '../journal/report.js'
import { signReportManifest, type ReportSignatureFile } from '../journal/report-signing.js'
import { isValidSessionId } from '../journal/session-id.js'
import { loadSigningPrivateKey } from '../journal/signing.js'
import type { SqliteHandle } from '../store/sqlite.js'
import type { ExportCliIo } from './export-cmd.js'
import { prepareReportOutDir, type PreparedOutDir } from './report-out-dir.js'

/**
 * `mcpcut export --report` (M5 wave 5, task 5.1, part B): the
 * filesystem half of the evidentiary report. `journal/report.ts` owns what
 * the format IS (streamed to a `ReportRecordSink`, digested as it goes);
 * this module owns argv-adjacent concerns the format core is deliberately
 * kept free of -- where the four files land, what mode they are created
 * with, whether a signing key exists, and the exit code an operator's
 * script would key off of. Split into its own file (rather than growing
 * `export-cmd.ts`) purely for the project's 400-line cap -- the plan's own
 * task note calls this split out explicitly.
 *
 * ORDERING OF CHECKS. Every failure path below runs BEFORE the first byte
 * touches disk: argument shape, then "does a database exist", then "does
 * the requested session exist", then "is the output directory usable" --
 * and all of them inside the command's own error path, so an unusable
 * `--out` is a reported exit 1 and never an escaped exception (wave-5
 * review, LOW: `--out` at a FILE raised ENOTDIR straight past this
 * function).
 *
 * A FAILED EXPORT LEAVES NOTHING OF ITS OWN BEHIND. The first cut let a
 * mid-write failure keep whatever had already been flushed, which then made
 * the retry refuse ("the directory already exists and is not empty") --
 * observed for real, since a decision record without `argsHash` crashed the
 * renderer mid-export. An operator must always be able to re-run the same
 * command, so this command removes exactly what IT created and nothing else:
 * the directory if it created it, otherwise only the files it wrote into a
 * directory that already existed.
 */

const EXIT_OK = 0
const EXIT_ERROR = 1

/** Default `--out` target: relative to the process CWD, not `JOURNAL_DIR` -- a report is a deliverable an operator hands to someone else, not journal state. */
const DEFAULT_REPORT_DIR_NAME = 'mcpcut-report'

export interface ExportReportCommandOptions {
  readonly journalDir: string
  readonly session?: string
  readonly outDir?: string
}

export async function runExportReportCommand(
  io: ExportCliIo,
  opts: ExportReportCommandOptions,
): Promise<number> {
  const session = opts.session
  if (session !== undefined && !isValidSessionId(session)) {
    io.stderr.write(`Invalid --session "${session}": expected 1-128 characters matching [A-Za-z0-9_-]\n`)
    return EXIT_ERROR
  }

  const handle = await openJournalDbIfPresent(opts.journalDir)
  if (handle === null) {
    io.stderr.write(
      `No journal database found under "${opts.journalDir}"; nothing has been journaled there yet.\n`,
    )
    return EXIT_ERROR
  }

  if (session !== undefined && sessionChainSpan(handle, session) === null) {
    io.stderr.write(`No records found for session "${session}".\n`)
    return EXIT_ERROR
  }

  const outDir = opts.outDir ?? join(process.cwd(), DEFAULT_REPORT_DIR_NAME)
  try {
    const prepared = await prepareReportOutDir(outDir)
    if (prepared.refusal !== undefined) {
      io.stderr.write(prepared.refusal)
      return EXIT_ERROR
    }
    return await writeReport(handle, opts.journalDir, session, prepared, io)
  } catch (error: unknown) {
    // An I/O failure mid-export must not print the success summary below.
    // `writeReport` has already discarded what it created, so the exit code,
    // stderr and the filesystem all say the same thing: nothing happened.
    io.stderr.write(`export --report failed: ${errorMessage(error)}\n`)
    return EXIT_ERROR
  }
}

/**
 * Everything that touches disk: streams `records.jsonl`, signs if a key
 * exists, writes the remaining files, fsyncs each one AND the directory, and
 * prints the success summary. Assumes the caller already ruled out every
 * refusal -- this function's only remaining failure mode is a genuine I/O
 * error, which it cleans up after and rethrows for `runExportReportCommand`
 * to report.
 */
async function writeReport(
  handle: SqliteHandle,
  journalDir: string,
  session: string | undefined,
  outDir: PreparedOutDir,
  io: ExportCliIo,
): Promise<number> {
  const written: string[] = []
  try {
    const report = await writeRecordsFile(handle, session, outDir.path, written)
    const { manifest, signature } = await signIfKeyPresent(journalDir, report.manifest, io)

    await writeReportFile(join(outDir.path, REPORT_FILES.manifest), manifestJsonOf(manifest), written)
    await writeReportFile(join(outDir.path, REPORT_FILES.summary), report.summaryMarkdown, written)
    if (signature !== null) {
      const signatureJson = `${JSON.stringify(signature, null, 2)}\n`
      await writeReportFile(join(outDir.path, REPORT_FILES.signature), signatureJson, written)
    }
    // The FILES are each fsynced as they close, but a crash could still lose
    // the directory entries naming them -- leaving a manifest that claims
    // files the directory does not list (wave-5 review, MEDIUM).
    await syncDirectory(outDir.path)

    io.stdout.write(successSummary(outDir.realPath, manifest, signature))
    return EXIT_OK
  } catch (error: unknown) {
    await discardPartialExport(outDir, written)
    throw error
  }
}

/** `report.json`: 2-space indent and a trailing newline, per the frozen format contract. */
function manifestJsonOf(manifest: ReportManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Removes exactly what this command created, and nothing else: the whole
 * directory when `mkdir` created it, otherwise the individual files written
 * into a directory that already existed. Best-effort per path -- a cleanup
 * failure must never replace the original error, which is what the operator
 * actually needs to see.
 */
async function discardPartialExport(outDir: PreparedOutDir, written: readonly string[]): Promise<void> {
  if (outDir.createdRoot !== undefined) {
    await rm(outDir.createdRoot, { recursive: true, force: true }).catch(() => undefined)
    return
  }
  for (const path of written) {
    await unlink(path).catch(() => undefined)
  }
}

/**
 * Streams the in-scope records to `records.jsonl`, honoring backpressure by
 * awaiting each write before `buildJournalReport` pulls the next row (see
 * `ReportRecordSink`'s doc) -- a multi-gigabyte journal is never buffered
 * whole in memory. `wx` (exclusive create) is this codebase's convention for
 * writing a fresh, permission-sensitive file (`journal/signing.ts`'s
 * `createFileExclusive`); it also means a race with something else creating
 * the same path fails loudly instead of silently overwriting.
 *
 * The path is recorded in `written` BEFORE the first byte, so a failure
 * partway through is cleaned up rather than left behind.
 */
async function writeRecordsFile(
  handle: SqliteHandle,
  session: string | undefined,
  outDir: string,
  written: string[],
): Promise<JournalReport> {
  const path = join(outDir, REPORT_FILES.records)
  const fileHandle = await open(path, 'wx', JOURNAL_FILE_MODE)
  written.push(path)
  try {
    const sink: ReportRecordSink = {
      writeLine: (line) => writeAllBytes(fileHandle, line),
    }
    const report = await buildJournalReport(
      handle,
      session === undefined ? {} : { session },
      sink,
    )
    await fileHandle.sync()
    return report
  } finally {
    await fileHandle.close()
  }
}

/** The one write primitive both artifact writers use; see {@link writeAllBytes}. */
export interface ByteSink {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ readonly bytesWritten: number }>
}

/**
 * Writes the WHOLE of `text` as UTF-8, looping until every byte is
 * acknowledged.
 *
 * `fs.write` is allowed to write fewer bytes than it was given (a signal
 * during the syscall, a pipe-backed destination) and does not loop for you.
 * The first cut discarded `bytesWritten` entirely, so a short write produced
 * a TRUNCATED `records.jsonl` while the command still printed
 * "Report written to: ..." and exited 0 -- an export whose digest an auditor
 * would then find intact over the wrong bytes, or find broken with no
 * explanation of why (wave-5 review, HIGH). A destination that accepts zero
 * bytes is a failure, not a spin: reported loudly rather than looped forever.
 */
export async function writeAllBytes(sink: ByteSink, text: string): Promise<void> {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await sink.write(buffer, offset, buffer.length - offset)
    if (bytesWritten <= 0) {
      throw new Error(
        `write stalled after ${offset} of ${buffer.length} bytes: the destination accepted none ` +
          'of the remaining bytes. The export is incomplete and has been discarded.',
      )
    }
    offset += bytesWritten
  }
}

interface SignOutcome {
  readonly manifest: ReportManifest
  readonly signature: ReportSignatureFile | null
}

/**
 * Signs `manifest` iff this installation has a signing key. There is no
 * third outcome: a key present but unusable would throw out of
 * `signReportManifest`, not be swallowed into a fake-unsigned result --
 * `loadSigningPrivateKey`'s discriminated lookup (`signing.ts`) is
 * pattern-matched here exactly as `verify-sign.ts` does, so no code path can
 * reach a signed-looking report without a real key having produced it.
 */
async function signIfKeyPresent(
  journalDir: string,
  manifest: ReportManifest,
  io: ExportCliIo,
): Promise<SignOutcome> {
  const keyLookup = await loadSigningPrivateKey(journalDir)
  if (!keyLookup.present) {
    io.stderr.write(
      'No signing key present; writing an UNSIGNED report. ' +
        'Generate one first with: mcpcut keygen\n',
    )
    return { manifest, signature: null }
  }
  const signed = signReportManifest(keyLookup.privateKeyPem, manifest)
  return { manifest: signed.manifest, signature: signed.signature }
}

/** Exclusive-create at `JOURNAL_FILE_MODE`, fully written and fsynced before the handle closes. */
async function writeReportFile(path: string, content: string, written: string[]): Promise<void> {
  const fileHandle = await open(path, 'wx', JOURNAL_FILE_MODE)
  written.push(path)
  try {
    await writeAllBytes(fileHandle, content)
    await fileHandle.sync()
  } finally {
    await fileHandle.close()
  }
}

/** fsyncs the directory itself, so the entries naming the files survive a crash as the files' contents already do. */
async function syncDirectory(path: string): Promise<void> {
  const dirHandle = await open(path, 'r')
  try {
    await dirHandle.sync()
  } finally {
    await dirHandle.close()
  }
}

function successSummary(
  outDirRealPath: string,
  manifest: ReportManifest,
  signature: ReportSignatureFile | null,
): string {
  const files: string[] = [REPORT_FILES.manifest, REPORT_FILES.records, REPORT_FILES.summary]
  if (signature !== null) files.push(REPORT_FILES.signature)
  const head = manifest.chain.head
  return [
    // The RESOLVED path: `--out` may have been relative, and an operator
    // handing this directory to an auditor needs to know where it actually is.
    `Report written to: ${outDirRealPath}\n`,
    `Files: ${files.join(', ')}\n`,
    `Scope: ${manifest.scope.session === null ? 'whole journal' : `session ${manifest.scope.session}`}\n`,
    `Records: ${manifest.counts.records}  Decisions: ${manifest.counts.decisions}\n`,
    head === null
      ? 'Chain head: no attested head\n'
      : `Chain head: seq ${head.seq} (${head.recordHash})\n`,
    `Chain verified at export: ${manifest.chain.verifiedAtExport}\n`,
    ...chainWarningLines(manifest),
    `Key fingerprint: ${manifest.keyFingerprint ?? 'UNSIGNED'}\n`,
  ].join('')
}

/**
 * A broken chain is a finding, not a failed command: the export DID succeed
 * and the manifest carries the break, so the exit code stays 0 (an operator's
 * script must be able to tell "could not export" from "exported, and here is
 * what it found"). But a `false` buried in a field is not something an
 * operator reads at 2am, so the finding also gets a line they cannot miss
 * (wave-5 review, LOW).
 */
function chainWarningLines(manifest: ReportManifest): readonly string[] {
  if (manifest.chain.verifiedAtExport) return []
  const chainBreak = manifest.chain.break
  const where = chainBreak === null ? 'somewhere in the journal' : `at seq ${chainBreak.seq} (${chainBreak.reason})`
  return [
    '\n',
    `!! WARNING: the hash chain did NOT verify at export time -- a break ${where}.\n`,
    '!! This report is still a faithful export of what the journal holds, and report.json\n',
    '!! records the break, but the records are NOT provably unbroken. Investigate before\n',
    '!! handing this to an auditor: mcpcut verify\n',
    '\n',
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
