import type { ReportManifest } from './report.js'
import type { ReportSignatureFile } from './report-signing.js'
import {
  chainVerdict,
  digestClaimOf,
  digestVerdict,
  lineCountClaimOf,
  lineCountVerdict,
  recordsUnavailable,
  summaryVerdict,
} from './report-verify-bytes.js'
import { consistencyVerdict, recomputedClaimsVerdict } from './report-verify-claims.js'
import { signatureVerdict } from './report-verify-signature.js'
import { digestBytes, streamRecordBytes, type RecordStreamTally } from './report-verify-stream.js'

export { MAX_RECORD_LINE_BYTES } from './report-verify-stream.js'
export { readVerifyingKey, type VerifyingKeyLookup } from './report-verify-signature.js'

/**
 * The auditor's offline procedure (M5 wave 5, task 5.3): everything that can
 * be established about an exported report while holding ONLY the export
 * directory and a public key. No database, no filesystem layout, no
 * printing -- `src/cli/verify-report.ts` owns argv, files and exit codes,
 * exactly the way `chain-verify.ts` and `verify-cmd.ts` are split. This
 * module is the shape and the order; the verdicts live in
 * `report-verify-bytes.ts` (file digests, line count, chain re-fold),
 * `report-verify-claims.ts` (the manifest's numbers) and
 * `report-verify-signature.ts` (key material), a split the wave-5 review
 * forced when the checks it added pushed one file past 400 lines.
 *
 * NO DATABASE IS A DESIGN CONSTRAINT, NOT AN OPTIMIZATION. The point of the
 * report is that a third party who does not (and must not) have access to
 * the control plane can check it. Any path reaching for `journal.db` would
 * work on the operator's machine -- where it is never exercised as a real
 * check -- and fail on the only machine that matters. So this module takes a
 * manifest, streams of bytes, and an optional key; nothing else.
 *
 * BYTES, NOT TEXT, and ONE PASS: digest, line count, chain re-fold and every
 * recomputed count fold into a single pass over the same chunks, so "the
 * digest passed but the counts were computed over something else" cannot
 * happen. Why bytes rather than decoded text is finding V2's story, told in
 * `report-verify-stream.ts`.
 *
 * WHAT A SIGNATURE IS WORTH, and why this module recomputes (amendment A2):
 * the signature proves only that the AUDITED PARTY authored the numbers. The
 * one class of claim an auditor can establish independently is arithmetic
 * over the exported bytes, so every claim derivable from `records.jsonl` is
 * re-derived and compared rather than read out of the manifest.
 *
 * STATUSES, NOT A BOOLEAN. Collapsing these is how a report gets over-read:
 * `failed` (checked, does not hold), `not-applicable` (does not apply here,
 * and why -- a session-scoped chain, an unsigned export), `could-not-run`
 * (applies, but something needed was missing). Only `failed` is a finding;
 * the other two must be SAID, never silently omitted, or a clean-looking
 * result implies more was checked than was. A real `failed` is NEVER
 * downgraded to `could-not-run` because a different file was unreadable --
 * that inversion was finding V5, where a truncated `signature.json`
 * suppressed the byte checks entirely and a tamperer who corrupted two files
 * got a lower exit code than one who corrupted one.
 *
 * THE HONEST LIMIT, as everywhere in M5: these checks prove the directory's
 * bytes match the signed manifest and that the manifest was signed by the
 * holder of that installation's key. They do NOT prove the host was never
 * tampered with -- a process under the same uid can rewrite the journal,
 * re-export and re-sign, and pass every check here. Only an anchor kept out
 * of band makes that detectable; `AS_OF_CONTRACT` says so inside the signed
 * bytes, and the CLI repeats it.
 */

/** Which check a result line is about. Stable identifiers, so a caller addresses a check without matching on prose. */
export type ReportCheckId =
  | 'records-digest'
  | 'records-line-count'
  | 'summary-digest'
  | 'manifest-consistency'
  | 'recomputed-claims'
  | 'chain-refold'
  | 'signature'

/** See the module doc for why these four are distinct and why only `failed` is a finding. */
export type ReportCheckStatus = 'passed' | 'failed' | 'not-applicable' | 'could-not-run'

/** A builder's answer before labelling; ids and labels live in one table here so the builders cannot drift apart. */
export interface Verdict {
  readonly status: ReportCheckStatus
  readonly detail: string
}

export interface ReportCheck {
  readonly id: ReportCheckId
  /** Short human name of what was examined. */
  readonly label: string
  readonly status: ReportCheckStatus
  /** What was found -- or, for the other statuses, WHY there is no verdict. Never empty. */
  readonly detail: string
}

export interface ReportVerifyResult {
  /** Every check, in the frozen contract's order, including the ones that did not apply. */
  readonly checks: readonly ReportCheck[]
  readonly failedCount: number
  readonly couldNotRunCount: number
  /** Whether a usable signature file was present at all. `false` means UNSIGNED -- never "verified". */
  readonly signed: boolean
}

/** A public key an auditor was handed, with the fingerprint DERIVED from it -- never a fingerprint taken on anyone's word. */
export interface VerifyingKey {
  readonly pem: string
  readonly fingerprint: string
}

/**
 * One file of the export, as the caller found it. `missing` and `unreadable`
 * are deliberately distinct: an absent file is a statement about the export
 * (and, for `summary.md`, a finding), while an unreadable one is a statement
 * about this machine and can only ever be could-not-run.
 */
export type ReportFilePresence =
  | { readonly status: 'present'; readonly chunks: AsyncIterable<Uint8Array> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string }

/** The same three states after the bytes have been digested. */
export type DigestedFile =
  | { readonly status: 'present'; readonly sha256: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string }

/** `signature.json`, which has a third state of its own: absent means UNSIGNED, a normal outcome. */
export type ReportSignaturePresence =
  | { readonly status: 'present'; readonly signature: ReportSignatureFile }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly reason: string }

export interface ReportVerifyInput {
  readonly manifest: ReportManifest
  /** `records.jsonl` as raw BYTE chunks in file order -- never decoded text; see `report-verify-stream.ts`. */
  readonly records: ReportFilePresence
  /** `summary.md` as raw byte chunks; the manifest attests it since amendment A1. */
  readonly summary: ReportFilePresence
  readonly signature: ReportSignaturePresence
  /** The key to verify with, or `null` when none was available -- which makes the signature check could-not-run, not failed. */
  readonly key: VerifyingKey | null
  /** `--require-signature` (amendment A4): an unsigned or unattributable export becomes a FAILED check. */
  readonly requireSignature?: boolean
}

/**
 * Runs every applicable check, in the frozen contract's order, returns the
 * full list -- including checks that did not apply -- and never throws for
 * anything the input can express. An I/O error from a chunk stream
 * propagates: only the caller that opened the stream can describe it.
 */
export async function verifyReportExport(input: ReportVerifyInput): Promise<ReportVerifyResult> {
  const { manifest, records } = input
  // One read of `records.jsonl`, whose two outcomes are modelled rather than
  // signalled with a null: either there is a tally every records-derived
  // check answers from, or there is the single reason none of them can.
  const read: RecordsRead =
    records.status === 'present'
      ? { tally: await streamRecordBytes(records.chunks, foldStartOf(manifest)) }
      : { absent: records }
  // `attestedClaim` is what the manifest CLAIMS about `records.jsonl` for
  // this particular check, or `null` for a check that merely needs the file.
  // Amendment A6 turns the first kind into a FAILED check when the file is
  // absent: the manifest's claim is contradicted, not merely uncheckable.
  const fromRecords = (
    build: (found: RecordStreamTally) => Verdict,
    attestedClaim: string | null,
  ): Verdict => ('tally' in read ? build(read.tally) : recordsUnavailable(read.absent, attestedClaim))
  const summary = await digestOf(input.summary)

  const checks: readonly ReportCheck[] = [
    labelled('records-digest', fromRecords((found) => digestVerdict(manifest, found), digestClaimOf(manifest))),
    labelled('records-line-count', fromRecords((found) => lineCountVerdict(manifest, found), lineCountClaimOf(manifest))),
    labelled('summary-digest', summaryVerdict(manifest, summary)),
    labelled('manifest-consistency', consistencyVerdict(manifest)),
    labelled('recomputed-claims', fromRecords((found) => recomputedClaimsVerdict(manifest, found), null)),
    labelled('chain-refold', chainVerdict(manifest, 'tally' in read ? read.tally : null)),
    labelled('signature', signatureVerdict(signatureInputOf(input))),
  ]

  return {
    checks,
    failedCount: countByStatus(checks, 'failed'),
    couldNotRunCount: countByStatus(checks, 'could-not-run'),
    signed: input.signature.status === 'present',
  }
}

/** The one place a check id becomes human-readable prose, so the CLI never invents its own names. */
const CHECK_LABELS: Readonly<Record<ReportCheckId, string>> = {
  'records-digest': 'records.jsonl digest',
  'records-line-count': 'records.jsonl line count',
  'summary-digest': 'summary.md digest',
  'manifest-consistency': 'manifest self-consistency',
  'recomputed-claims': 'claims recomputed from records.jsonl',
  'chain-refold': 'chain re-fold',
  signature: 'manifest signature',
}

function labelled(id: ReportCheckId, verdict: Verdict): ReportCheck {
  return { id, label: CHECK_LABELS[id], status: verdict.status, detail: verdict.detail }
}

/** The two outcomes of reading `records.jsonl`: a tally, or the state the file was found in. */
type RecordsRead =
  | { readonly tally: RecordStreamTally }
  | { readonly absent: Exclude<ReportFilePresence, { status: 'present' }> }

function signatureInputOf(input: ReportVerifyInput): {
  readonly manifest: ReportManifest
  readonly signature: ReportSignaturePresence
  readonly key: VerifyingKey | null
  readonly requireSignature: boolean
} {
  return {
    manifest: input.manifest,
    signature: input.signature,
    key: input.key,
    requireSignature: input.requireSignature === true,
  }
}

async function digestOf(file: ReportFilePresence): Promise<DigestedFile> {
  if (file.status !== 'present') return file
  return { status: 'present', sha256: await digestBytes(file.chunks) }
}

const countByStatus = (checks: readonly ReportCheck[], status: ReportCheckStatus): number =>
  checks.filter((entry) => entry.status === status).length

/**
 * Where an offline fold starts, or `null` when no fold is possible from this
 * export. `startPrevHash` is required whenever `recomputable`
 * (`report-parse.ts` enforces it), so an absent one here means a manifest
 * built in-process rather than parsed -- `chainVerdict` reports that as a
 * contradiction rather than as evidence that could not be gathered.
 */
function foldStartOf({ chain }: ReportManifest): string | null {
  if (!chain.recomputable || chain.head === null || chain.startPrevHash === undefined) return null
  return chain.startPrevHash
}
