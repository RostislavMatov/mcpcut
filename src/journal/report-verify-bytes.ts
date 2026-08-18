import type { ReportManifest } from './report.js'
import type { RecordStreamTally } from './report-verify-stream.js'
import { MAX_RECORD_LINE_BYTES } from './report-verify-stream.js'
import type { DigestedFile, ReportFilePresence, Verdict } from './report-verify.js'

/**
 * The verdicts derived from the exported FILES' bytes (M5 wave 5, task 5.3):
 * the `records.jsonl` digest and line count, the `summary.md` digest
 * (amendment A1), and the chain re-fold. Split out of `report-verify.ts` in
 * the wave-5 review round, which pushed that module past the project's
 * 400-line cap; the split is by responsibility -- bytes here, manifest
 * arithmetic in `report-verify-claims.ts`, key material in
 * `report-verify-signature.ts`, orchestration and the public shape in
 * `report-verify.ts`.
 *
 * Every builder answers with a status AND a reason, never a bare boolean:
 * `not-applicable` and `could-not-run` must be SAID, or a clean-looking
 * result implies more was checked than was.
 */

/**
 * The absent `records.jsonl`, in the terms the auditor can act on. The
 * parameter EXCLUDES the `present` state on purpose: a present file always
 * produces a tally, so a "records unavailable" verdict built from one would
 * be a lie the type system can rule out.
 *
 * MISSING AND UNREADABLE ARE DIFFERENT VERDICTS (amendment A6). The
 * distinction is whether the manifest CLAIMS this file. It does: it names
 * `records.jsonl` and states a sha256 and a line count over it, so the
 * file's absence CONTRADICTS a positive claim -- that is a finding (FAILED),
 * not a question left unanswered. The first cut of this module returned
 * could-not-run for both, which put an auditor's `verify --report || alert`
 * pipeline exactly the wrong way round: deleting the EVIDENCE file scored
 * exit 1 ("retry later") while deleting the far less important `summary.md`
 * scored 2. A file that is present but cannot be READ is the other case --
 * a fact about this machine, not about the export -- and stays
 * could-not-run.
 *
 * `attestedClaim` is what the manifest says about the file, so the message
 * names the claim the absence contradicts. Checks that merely NEED the file
 * (the recomputed counts, the chain re-fold) pass `null`: they establish
 * nothing either way without it, and reporting them as findings would claim
 * a disagreement nobody measured.
 */
export function recordsUnavailable(
  records: Exclude<ReportFilePresence, { status: 'present' }>,
  attestedClaim: string | null,
): Verdict {
  if (records.status === 'unreadable') {
    return {
      status: 'could-not-run',
      detail: `records.jsonl could not be read (${records.reason}), so this check had nothing to run against.`,
    }
  }
  if (attestedClaim === null) {
    return {
      status: 'could-not-run',
      detail:
        'records.jsonl is not in this directory, so there were no exported bytes to derive this from. ' +
        'The checks above report the absence itself.',
    }
  }
  return {
    status: 'failed',
    detail:
      `records.jsonl is not in this directory, but the manifest attests it: ${attestedClaim}. The ` +
      'exported records are the evidence this report is about, and they are absent -- this bundle was ' +
      'stripped, or was never complete. Ask for the whole export directory.',
  }
}

/** What the manifest claims about `records.jsonl`, phrased for the message above. */
export function digestClaimOf(manifest: ReportManifest): string {
  return `records.sha256 is ${manifest.records.sha256}`
}

export function lineCountClaimOf(manifest: ReportManifest): string {
  return `records.lineCount is ${manifest.records.lineCount}`
}

/**
 * The digest, and the only check in this module that still answers when the
 * line splitter gave up: a digest needs no line structure (see
 * `MAX_RECORD_LINE_BYTES`), so an overlong line never suppresses the one
 * question that can still be answered about those bytes.
 */
export function digestVerdict(manifest: ReportManifest, tally: RecordStreamTally): Verdict {
  const expected = manifest.records.sha256
  const exact = "sha256 of the file's exact bytes is"
  if (tally.digestHex === expected) {
    return { status: 'passed', detail: `${exact} ${expected}, matching records.sha256.` }
  }
  return {
    status: 'failed',
    detail:
      `${exact} ${tally.digestHex}, but the manifest claims ${expected}. ` +
      'The record bytes in this directory are not the bytes the manifest describes.',
  }
}

/** `summary.md`, the only artifact a non-technical reader consumes (amendment A1 / review finding V12). */
export function summaryVerdict(manifest: ReportManifest, summary: DigestedFile): Verdict {
  const expected = manifest.summary.sha256
  if (summary.status === 'missing') {
    return {
      status: 'failed',
      detail:
        `summary.md is not in this directory, but the manifest attests it with sha256 ${expected}. ` +
        'The summary is the part of a report a non-technical reader actually reads; its absence is a ' +
        'discrepancy in the export, not a missing convenience.',
    }
  }
  if (summary.status === 'unreadable') {
    return { status: 'could-not-run', detail: `summary.md could not be read (${summary.reason}).` }
  }
  if (summary.sha256 === expected) {
    return { status: 'passed', detail: `sha256 of summary.md's exact bytes is ${expected}, matching summary.sha256.` }
  }
  return {
    status: 'failed',
    detail:
      `sha256 of summary.md's exact bytes is ${summary.sha256}, but the manifest claims ${expected}. ` +
      'The human-readable summary in this directory is not the one this report attests to.',
  }
}

export function lineCountVerdict(manifest: ReportManifest, tally: RecordStreamTally): Verdict {
  const overlong = overlongVerdict(tally, 'The line count')
  if (overlong !== null) return overlong

  const expected = manifest.records.lineCount
  // Said out loud: a file whose last line lost its terminator still counts
  // that line, and the digest check reports the byte difference. Without the
  // note, a passing line count beside a failing digest reads as a
  // contradiction.
  const tailNote = tally.unterminatedTail
    ? ' NOTE: the last line carries no newline terminator; it is counted, and the digest check covers the byte difference.'
    : ''
  if (tally.lineCount === expected) {
    return { status: 'passed', detail: `${tally.lineCount} line(s), matching records.lineCount.${tailNote}` }
  }
  return {
    status: 'failed',
    detail:
      `${tally.lineCount} line(s) present, but the manifest claims ${expected}. ` +
      `Records were added or removed after the manifest was written.${tailNote}`,
  }
}

/**
 * The offline chain re-fold. Reachable only when the manifest says the chain
 * IS recomputable AND that claim survived recomputation
 * (`report-verify-claims.ts` recomputes the predicate itself -- review
 * finding V3, where a flipped flag was an attacker-settable off switch for
 * this very check).
 *
 * `head === null` or an absent `startPrevHash` under `recomputable` is a
 * FAILED check, not a could-not-run: the parser (`report-parse.ts`) already
 * refuses such a manifest, so reaching here means a caller built one
 * directly, and a manifest that claims a re-fold while withholding what the
 * re-fold needs is contradicting itself, not withholding evidence.
 */
export function chainVerdict(manifest: ReportManifest, tally: RecordStreamTally | null): Verdict {
  const { chain } = manifest
  if (!chain.recomputable) return { status: 'not-applicable', detail: notRecomputableReason(manifest) }

  const claims = 'the manifest claims chain.recomputable but '
  if (chain.head === null) {
    return { status: 'failed', detail: `${claims}names no chain.head to compare a re-fold against.` }
  }
  if (chain.startPrevHash === undefined) {
    return { status: 'failed', detail: `${claims}names no chain.startPrevHash, so nothing says where the re-fold starts.` }
  }
  if (tally === null) return { status: 'could-not-run', detail: 'records.jsonl was not available to re-fold.' }
  const overlong = overlongVerdict(tally, 'The chain re-fold')
  if (overlong !== null) return overlong
  return foldComparison(chain.head, chain.startPrevHash, tally)
}

function foldComparison(
  head: { readonly seq: number; readonly recordHash: string },
  startPrevHash: string,
  tally: RecordStreamTally,
): Verdict {
  if (tally.foldedHash === head.recordHash) {
    return {
      status: 'passed',
      detail:
        `folding ${tally.lineCount} link(s) from startPrevHash ` +
        `${startPrevHash === '' ? '(genesis)' : startPrevHash} reproduces chain.head.recordHash ` +
        `${head.recordHash} at seq ${head.seq}.`,
    }
  }
  return {
    status: 'failed',
    detail:
      `folding ${tally.lineCount} link(s) from startPrevHash produced ${tally.foldedHash ?? '(nothing)'}, but ` +
      `the manifest's chain.head.recordHash is ${head.recordHash} (seq ${head.seq}). The exported records ` +
      'do not chain to the head this report attests to.',
  }
}

/**
 * The shared answer for every line-derived check once the splitter hit
 * {@link MAX_RECORD_LINE_BYTES} (review finding V7). Explicitly could-not
 * -run, naming the bound: an auditor must be able to tell "this file is not
 * shaped like an export" apart from a check that quietly returned nothing.
 */
function overlongVerdict(tally: RecordStreamTally, subject: string): Verdict | null {
  if (tally.overlongLineBytes === null) return null
  return {
    status: 'could-not-run',
    detail:
      `records.jsonl carries a line of at least ${tally.overlongLineBytes} bytes, past this verifier's ` +
      `${MAX_RECORD_LINE_BYTES}-byte limit for a single record. ${subject} needs the file's line ` +
      'structure and cannot be established. The digest above still covers the bytes; a file shaped like ' +
      'this did not come from "mcp-journal export --report".',
  }
}

/**
 * WHY the chain could not be re-derived, in the manifest's own terms.
 * Silence would let a clean-looking result imply the chain was checked when
 * it was not -- the over-reading `isChainRecomputable`'s doc warns about.
 * Every condition that made it false is named: more than one can hold, and
 * an auditor deciding what to ask for next needs all of them.
 *
 * The fallback ("the exporter marked the chain as not re-derivable") is now
 * unreachable through the CLI and stays as a total-function guard only: a
 * manifest whose flag names no condition is exactly the lie review finding
 * V3 describes, and `report-verify-claims.ts` fails it before this text is
 * ever rendered.
 */
function notRecomputableReason(manifest: ReportManifest): string {
  const { chain, scope } = manifest
  const reasons: string[] = []
  if (scope.session !== null) {
    reasons.push(`this export is scoped to session "${scope.session}", omitting other sessions' records the stored chain was folded over`)
  }
  if (chain.unattestedCount > 0) reasons.push(`${chain.unattestedCount} record(s) predate the hash chain and were never folded into it`)
  if (chain.break !== null) reasons.push(`the exporter found a chain break at seq ${chain.break.seq} (${chain.break.reason})`)
  if (chain.head === null) reasons.push('the journal has no attested chain head to compare against')

  const why = reasons.length > 0 ? reasons.join('; ') : 'the exporter marked the chain as not re-derivable'
  return (
    `NOT CHECKED -- the chain is not re-derivable from this export: ${why}. The digest, line count and ` +
    'signature checks still apply; re-deriving the chain needs a whole-journal export, or a check run ' +
    'against the journal itself (mcp-journal verify).'
  )
}
