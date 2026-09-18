import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseReportManifestJson, parseReportSignatureJson } from '../journal/report-parse.js'
import { REPORT_FILES, type ReportManifest } from '../journal/report.js'
import {
  readVerifyingKey,
  verifyReportExport,
  type ReportFilePresence,
  type ReportSignaturePresence,
  type ReportVerifyResult,
  type VerifyingKey,
} from '../journal/report-verify.js'
import { renderResult } from './verify-report-render.js'

/**
 * `mcpcut verify --report <dir> [--pub <path>] [--require-signature]`
 * (M5 wave 5, task 5.3): the auditor's procedure. Files, formatting and the
 * exit code live here; the checks themselves are in
 * `journal/report-verify.ts`, the untrusted-input validation in
 * `journal/report-parse.ts`, and the printing in `verify-report-render.ts`.
 * Split out of `verify-cmd.ts` for the same reason `verify-sign.ts` was:
 * that file is at the project's 400-line cap.
 *
 * THIS PATH OPENS NO DATABASE, and does not probe for one. That is not an
 * incidental property to be preserved by care -- it is the feature. The
 * command has to run on a laptop that holds nothing but the export directory
 * and a public key someone handed over. Anything that reached for
 * `journal.db` would work on the operator's machine (where it is never
 * exercised as a real check) and fail on the only machine that matters,
 * which is why `--report` is rejected outright when combined with the
 * database-mode flags rather than quietly ignoring them.
 *
 * ONE FILE'S PROBLEM NEVER SILENCES ANOTHER FILE'S CHECK (M5 wave-5 review,
 * finding V5 / amendment A5). This function used to return could-not-run the
 * moment `signature.json` failed to parse -- BEFORE any check ran. With
 * `records.jsonl` replaced AND `signature.json` truncated, it exited 1 with
 * empty stdout, having examined not one byte: a tamperer who corrupted two
 * files got a LOWER exit code than one who corrupted one. Now every file is
 * read into an explicit present/missing/unreadable state, all the checks
 * that can run do run, and only an unreadable `report.json` short-circuits,
 * because then there is nothing to check anything against.
 *
 * EVERY WHOLE-FILE READ IS BOUNDED (finding V10). `report.json`,
 * `signature.json` and the public key are read into memory, so a ~2 GB
 * `report.json` in a hostile bundle was read whole before `JSON.parse` ever
 * saw it. The size is taken from the OPEN HANDLE (`fstat`), not from a
 * separate `stat` of the path, so the file cannot be swapped between the
 * check and the read. `records.jsonl` and `summary.md` are streamed instead,
 * and never held whole.
 *
 * `journalDir` is used for ONE thing here: resolving the default `--pub`
 * path, as a convenience for the operator who verifies their own export on
 * the host that produced it. An auditor always passes `--pub` explicitly,
 * and a missing default file is a could-not-run, never a failed check.
 */

/** Minimal writable shape, structurally identical to `verify-cmd.ts`'s so tests can inject capture objects. */
export interface ReportVerifyIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
}

export interface ReportVerifyRequest {
  /** The export directory, exactly as the operator typed it -- echoed in every message so they can see what was resolved. */
  readonly reportDir: string
  /** Resolved public-key path (`--pub`, or `<journalDir>/signing.pub`). */
  readonly pubPath: string
  /** Whether `--pub` was given explicitly; only changes the wording when the file is absent. */
  readonly pubExplicit: boolean
  /** `--require-signature` (amendment A4): an unsigned or unattributable export becomes a FAILED check, hence exit 2. */
  readonly requireSignature: boolean
}

/**
 * Exit codes, frozen with the report format and mirrored from
 * `verify-cmd.ts`'s own contract:
 * - 0: every check that APPLIED passed. An unsigned export with intact
 *   bytes is 0 -- printed as UNSIGNED, never as verified-and-signed --
 *   unless `--require-signature` was given, which makes it a finding.
 * - 1: could not run -- a missing export directory, a `report.json` that is
 *   absent or that this build cannot read, an unreadable (as opposed to
 *   absent) file, or a signature with no public key to check it against.
 *   Not a finding about the report, a failure to examine it.
 * - 2: a check FAILED. Wins over 1 whenever both apply, for exactly the
 *   reason `verify-cmd.ts` spells out: an auditor's script escalates on 2
 *   and defers on 1, so letting a missing key file downgrade a digest
 *   mismatch would mean the alert never fires. Hence the checks are run
 *   even when something is missing: whatever CAN be established, is.
 *
 * A MISSING FILE IS NOT AUTOMATICALLY A "COULD NOT RUN" (amendment A6,
 * which amends the frozen contract's original "missing dir/files -> 1").
 * The question is whether the manifest CLAIMS the file. `records.jsonl` and
 * `summary.md` are each named in it WITH a digest, so their absence
 * contradicts a positive, signed claim and exits 2 -- it is evidence the
 * bundle was stripped. The export directory and `report.json` are claimed by
 * nothing, so their absence stays 1. Under the original rule an auditor's
 * `verify --report || alert` pipeline treated deletion of the EVIDENCE file
 * as "retry later" while deletion of the far less important summary raised
 * the alarm.
 */
const EXIT_OK = 0
const EXIT_COULD_NOT_RUN = 1
const EXIT_CHECK_FAILED = 2

/**
 * Ceilings for the files this command reads WHOLE. Generous next to what the
 * exporter writes (a manifest is a few kilobytes, a signature and a PEM a
 * few hundred bytes) and far below what a hostile bundle would need to
 * exhaust an auditor's laptop. Exceeding one is a could-not-run naming the
 * limit, never a silent truncation.
 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_SIGNATURE_BYTES = 64 * 1024
const MAX_PUBLIC_KEY_BYTES = 64 * 1024

export async function runReportVerification(
  request: ReportVerifyRequest,
  io: ReportVerifyIo,
): Promise<number> {
  const manifestLookup = await loadManifest(request.reportDir)
  if (!manifestLookup.ok) {
    io.stderr.write(manifestLookup.message)
    return EXIT_COULD_NOT_RUN
  }
  const { manifest } = manifestLookup

  // Deliberately NOT an early return on failure any more: see the module
  // doc's A5 paragraph. Each of these three resolves to a state the checks
  // can reason about, and every check that still applies still runs.
  const signature = await loadSignature(request.reportDir, io)
  const key = signature.status === 'present' ? await loadKey(request, io) : null
  const records = await presenceOf(join(request.reportDir, REPORT_FILES.records))
  const summary = await presenceOf(join(request.reportDir, REPORT_FILES.summary))
  if (records.status === 'missing') {
    io.stderr.write(`No "${REPORT_FILES.records}" in "${request.reportDir}"; the exported records are missing.\n`)
  }

  let result: ReportVerifyResult
  try {
    result = await verifyReportExport({
      manifest,
      records,
      summary,
      signature,
      key,
      requireSignature: request.requireSignature,
    })
  } catch (error) {
    // A read error mid-stream: a file existed a moment ago and now cannot be
    // read to the end. Nothing partial is reported, because a digest over
    // half a file is not a result -- it is a different question's answer.
    io.stderr.write(`Could not read the exported files under "${request.reportDir}": ${messageOf(error)}\n`)
    return EXIT_COULD_NOT_RUN
  }

  io.stdout.write(renderResult({ reportDir: request.reportDir, requireSignature: request.requireSignature }, manifest, result))
  if (result.failedCount > 0) return EXIT_CHECK_FAILED
  return result.couldNotRunCount > 0 ? EXIT_COULD_NOT_RUN : EXIT_OK
}

type ManifestLookup =
  | { readonly ok: true; readonly manifest: ReportManifest }
  | { readonly ok: false; readonly message: string }

/** The ONE short-circuit: with no readable manifest there is nothing to check anything against. */
async function loadManifest(reportDir: string): Promise<ManifestLookup> {
  const path = join(reportDir, REPORT_FILES.manifest)
  const text = await readTextIfPresent(path, MAX_MANIFEST_BYTES)
  if (text.status === 'missing') {
    return {
      ok: false,
      message:
        `No "${REPORT_FILES.manifest}" at "${path}". Point --report at the directory an ` +
        '"mcpcut export --report" run produced (it holds report.json, records.jsonl and summary.md).\n',
    }
  }
  if (text.status === 'error') {
    return { ok: false, message: `Could not read "${path}": ${text.message}\n` }
  }

  const parsed = parseReportManifestJson(text.text)
  if (parsed.ok) return { ok: true, manifest: parsed.value }
  return {
    ok: false,
    message: `"${path}" is not a report manifest this build can read:\n${bulletLines(parsed.errors)}`,
  }
}

/**
 * `signature.json` as one of three states. An ABSENT file means UNSIGNED --
 * a normal outcome the checks handle (and, when the manifest names a key,
 * a FAILED one: amendment A3). A present-but-unusable file is `unreadable`,
 * which makes the signature check could-not-run and touches nothing else.
 */
async function loadSignature(reportDir: string, io: ReportVerifyIo): Promise<ReportSignaturePresence> {
  const path = join(reportDir, REPORT_FILES.signature)
  const text = await readTextIfPresent(path, MAX_SIGNATURE_BYTES)
  if (text.status === 'missing') return { status: 'absent' }
  if (text.status === 'error') {
    io.stderr.write(`Could not read "${path}": ${text.message}\n`)
    return { status: 'unreadable', reason: text.message }
  }

  const parsed = parseReportSignatureJson(text.text)
  if (parsed.ok) return { status: 'present', signature: parsed.value }
  io.stderr.write(`"${path}" is not a signature file this build can read:\n${bulletLines(parsed.errors)}`)
  return { status: 'unreadable', reason: parsed.errors.join('; ') }
}

/**
 * Loads the verifying key, or returns `null` and says why on stderr. `null`
 * is deliberately NOT an early return: the byte checks still run and still
 * report, so an auditor who mistyped `--pub` learns whether the records
 * themselves hold up rather than being sent away with one error line.
 */
async function loadKey(request: ReportVerifyRequest, io: ReportVerifyIo): Promise<VerifyingKey | null> {
  const text = await readTextIfPresent(request.pubPath, MAX_PUBLIC_KEY_BYTES)
  if (text.status === 'missing') {
    io.stderr.write(
      `No public key at "${request.pubPath}"${request.pubExplicit ? '' : ' (the default location)'}. ` +
        'This export is signed, so pass the public key the operator handed over: ' +
        'mcpcut verify --report <dir> --pub <path to signing.pub>\n',
    )
    return null
  }
  if (text.status === 'error') {
    io.stderr.write(`Could not read the public key at "${request.pubPath}": ${text.message}\n`)
    return null
  }

  const lookup = readVerifyingKey(text.text)
  if (lookup.ok) return lookup.key
  io.stderr.write(`The file at "${request.pubPath}" is ${lookup.message}.\n`)
  return null
}

type TextLookup =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly message: string }

/**
 * Reads a whole file, bounded (finding V10), distinguishing "not there" from
 * "there but unreadable". Collapsing those two would make an absent
 * `signature.json` (UNSIGNED, a normal state) indistinguishable from one
 * that exists but cannot be opened -- and the second must never be reported
 * as the first. `EISDIR`/`ENOTDIR` join `ENOENT` because pointing `--report`
 * at a file, or at a path whose parent is a file, produces them for exactly
 * the same user-visible reason: nothing is there.
 *
 * The size comes from the OPEN HANDLE, so the file that is measured is the
 * file that is read.
 */
async function readTextIfPresent(path: string, maxBytes: number): Promise<TextLookup> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return missingOrError(error)
  }
  try {
    const size = (await handle.stat()).size
    if (size > maxBytes) {
      return {
        status: 'error',
        message:
          `the file is ${size} bytes, past this command's ${maxBytes}-byte limit for it. A report ` +
          'directory holding a file that large did not come from "mcpcut export --report".',
      }
    }
    return { status: 'ok', text: await handle.readFile('utf8') }
  } catch (error) {
    return missingOrError(error)
  } finally {
    await handle.close()
  }
}

function missingOrError(error: unknown): TextLookup {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return { status: 'missing' }
  return { status: 'error', message: messageOf(error) }
}

/**
 * One STREAMED file as a present/missing/unreadable state. Raw bytes, never
 * decoded text (finding V2): `records.jsonl`'s digest is the manifest's
 * claim about the file's exact bytes, and a UTF-8 decode is lossy enough
 * that two different files reached the same digest. A stream, never
 * `readFile`: this is the evidence file and it can be gigabytes, and the
 * auditor's laptop is the least likely machine to have the memory for it.
 */
async function presenceOf(path: string): Promise<ReportFilePresence> {
  try {
    if (!(await stat(path)).isFile()) return { status: 'missing' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
    return { status: 'unreadable', reason: messageOf(error) }
  }
  return { status: 'present', chunks: readByteChunks(path) }
}

async function* readByteChunks(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) {
    yield chunk as Uint8Array
  }
}

function bulletLines(lines: readonly string[]): string {
  return lines.map((line) => `  - ${line}\n`).join('')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
