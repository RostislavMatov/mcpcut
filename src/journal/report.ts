import { createIncrementalSha256, sha256Hex } from '../policy/hash.js'
import type { SqliteHandle } from '../store/sqlite.js'
import {
  latestAttestedChainHead,
  resolveChainStartPrevHash,
  verifyChain,
  type ChainBreak,
} from './chain-verify.js'
import { latestPruneMarker } from './prune.js'
import { renderReportSummary } from './report-summary.js'
import {
  streamRecords,
  withConsistentReadView,
  type ReportRecordSink,
  type StreamTally,
} from './report-stream.js'

export { ReportExportError, type ReportRecordSink } from './report-stream.js'

/**
 * The audit report's format core (M5 wave 5, tasks 5.1/5.2/5.5): the
 * versioned `report.json` manifest, the exported `records.jsonl` lines, and
 * the `summary.md` an auditor actually reads. CLI-free by the same split
 * `chain-verify.ts`/`verify-cmd.ts` uses -- `src/cli/` owns argv, files and
 * exit codes; this module owns what the format IS, so the format can be
 * tested and re-derived without a filesystem.
 *
 * WHY A SINK INSTEAD OF A RETURNED ARRAY. `records.sha256` is the manifest's
 * only binding claim about the bytes an auditor received, so it must digest
 * exactly the bytes that reach the file -- not a "re-serialization that
 * should be identical". Returning lines for the CLI to write would leave a
 * seam where a caller writes a different terminator, re-orders, drops or
 * re-encodes a line and still ships a manifest saying the file is intact.
 * Handing each line to a `ReportRecordSink` while feeding the SAME string
 * into the running digest closes that seam by construction. It is also what
 * keeps the export streaming: a multi-gigabyte journal is walked one row at
 * a time (`report-stream.ts`), never materialized.
 *
 * `doc` is emitted verbatim, exactly as `mcpcut export` already does
 * (`export-cmd.ts`) and exactly as `chain.ts` hashes it. Re-serializing it --
 * even through `canonicalJson` -- would break BOTH the chain re-fold (the
 * chain hashes stored bytes, not a reinterpretation of them) and the promise
 * that the export is evidence of what the journal holds rather than a view of
 * it. A row whose `doc` does not parse is therefore exported unchanged and
 * merely COUNTED as unparsable.
 */

/**
 * Version of the report format as a whole (`report.json`'s field set, the
 * `records.jsonl` line convention, and how `chain.recomputable` is defined).
 * v1's fields are deliberately the minimum an auditor needs to re-derive the
 * claims offline; the PRD's open question -- an actual interview with a
 * partner's auditor -- is expected to produce a v2 with more, which is why
 * every consumer must reject an unknown version outright instead of
 * best-effort parsing it (plan task 5.5, recorded in ADR-0007).
 */
export const REPORT_FORMAT_VERSION = 1

/**
 * The versioned as-of contract (plan task 5.2), embedded verbatim in
 * `report.json`'s `contract` field AND printed in `summary.md`. It is part
 * of the SIGNED bytes, so a report cannot be handed on with the caveats
 * quietly removed -- stripping this text invalidates the signature.
 *
 * The four statements are not decoration. Each one closes a specific way
 * this report could be over-read: (1) it is a snapshot, (2) it is history,
 * not present authority -- the ECZ-ID thread's core requirement, ROADMAP.md
 * lines 94/97, (3) a signature is evidence, not proof, and (4) the export
 * neither adds nor withholds relative to what the journal already stores.
 */
export const AS_OF_CONTRACT = `This report attests to the history recorded in this journal, and to the
integrity of those records, AS OF the "asOf" instant named in this
manifest. It says nothing about anything written after that instant.

It is NOT a statement about the current rights, permissions or authority of
any subject named in it. What an agent, an administrator or a tool is
allowed to do right now is resolved elsewhere, by whatever system owns those
facts; this report is built to COMPOSE with such a resolver, not to replace
it. A grant that was in force when a decision was made may have been revoked
since, and this report will still -- correctly -- show the decision that was
made under it.

If this export is signed, the signature proves only that it was produced by
the holder of this installation's private key. It does NOT prove that the
host was never tampered with: a process running under the same uid that
wrote the journal can rewrite the hash chain end to end and re-sign it, and
the result is indistinguishable from an untouched one. Tampering becomes
detectable only when an earlier anchor was kept OUT OF BAND, somewhere this
host cannot also rewrite, and is compared against this one.

The inputs to the decisions recorded here are not exported. Redaction is
applied when a record is written, so the journal never held them; this
export re-reads what is stored, never re-redacts, and therefore can reveal
neither more nor less than the journal already holds.`

/**
 * The frozen export-directory layout. Shared rather than spelled out at each
 * call site because the command that WRITES a report and the one that
 * VERIFIES it are separate: a rename on one side alone would make every
 * report this installation produces unverifiable, with nothing failing until
 * an auditor tried. `signature` is written only when a signing key exists --
 * its absence means UNSIGNED, never "verified".
 */
export const REPORT_FILES = {
  manifest: 'report.json',
  records: 'records.jsonl',
  summary: 'summary.md',
  signature: 'signature.json',
} as const

/** `report.json`, v1. Field-for-field the frozen wave-5 contract; see `REPORT_FORMAT_VERSION`. */
export interface ReportManifest {
  readonly formatVersion: number
  /** ISO 8601 instant the export ran. */
  readonly asOf: string
  /** `session: null` means the whole journal. */
  readonly scope: { readonly session: string | null }
  readonly records: {
    readonly file: typeof REPORT_FILES.records
    readonly lineCount: number
    /** sha256 hex over the EXACT bytes written to `records.jsonl`. */
    readonly sha256: string
  }
  /**
   * Amendment A1: the manifest attests `summary.md` too. It is the only
   * artifact a non-technical reader consumes, and it was outside every
   * integrity mechanism -- it could be edited or deleted with the report
   * still verifying clean.
   */
  readonly summary: {
    readonly file: typeof REPORT_FILES.summary
    /** sha256 hex over the EXACT bytes written to `summary.md`. */
    readonly sha256: string
  }
  /** `null` when the export is empty -- an absent range, not a zero one. */
  readonly seqRange: { readonly firstSeq: number; readonly lastSeq: number } | null
  /** Sessions present in the export, ascending. */
  readonly sessionIds: readonly string[]
  readonly counts: ReportCounts
  readonly chain: ReportChainInfo
  /** Present iff `signature.json` was written; stamped by `report-signing.ts` from the key that actually signed. */
  readonly keyFingerprint?: string
  /** {@link AS_OF_CONTRACT}, verbatim. */
  readonly contract: string
}

export interface ReportCounts {
  readonly records: number
  readonly decisions: number
  /** Rows exported verbatim that do not parse as a journal record. */
  readonly unparsableRows: number
  /** Decision records carrying no `policyHash` -- pre-M5 rows (see `PersistedDecisionInfo`). */
  readonly unprovenanced: number
  /** Decision outcome -> count, keys ascending. */
  readonly byOutcome: Readonly<Record<string, number>>
}

export interface ReportChainInfo {
  /** `verifyChain()` over the database found no break at export time. */
  readonly verifiedAtExport: boolean
  readonly break: ChainBreak | null
  readonly unattestedCount: number
  readonly head: { readonly seq: number; readonly recordHash: string } | null
  /** See {@link isChainRecomputable}. */
  readonly recomputable: boolean
  /** Present iff `recomputable`; where an offline re-fold starts. */
  readonly startPrevHash?: string
  /**
   * Highest `seq` a retention prune deleted (M5 wave 6), or `null` on a
   * journal that was never pruned. Always PRESENT, never merely absent: an
   * absent key would be indistinguishable from a build that did not look, and
   * "records before seq N were deleted" is exactly the fact an auditor cannot
   * infer from anything else in the report. It explains both halves of what
   * they would otherwise see unexplained -- a `seqRange` that does not start
   * at 1, and a `startPrevHash` that is not genesis.
   */
  readonly prunedThroughSeq: number | null
}

export interface ReportBuildOptions {
  /**
   * Clock for `manifest.asOf`, called ONCE, INSIDE the consistent read view.
   * A caller-stamped instant (what this was before the wave-5 review) is
   * taken before the snapshot exists, so records committed between the stamp
   * and the first read would post-date the instant the contract text says
   * bounds them. Injectable so tests are deterministic; defaults to the wall
   * clock in ISO 8601, which is what `manifest.asOf` is defined to be.
   */
  readonly now?: () => string
  /** Session to scope the export to. Absent (never `null`) means the whole journal. */
  readonly session?: string
}

export interface JournalReport {
  readonly manifest: ReportManifest
  /** `summary.md`'s full text. */
  readonly summaryMarkdown: string
}

/**
 * Builds one audit report: streams the in-scope `doc` rows to `sink` in
 * `seq` order while digesting exactly those bytes, then assembles the
 * manifest and renders `summary.md`.
 *
 * EVERYTHING HAPPENS INSIDE ONE READ VIEW (wave-5 review, CRITICAL). The
 * stream, `asOf`, the chain walk and the chain head are all read from the
 * same snapshot, because they are claims about ONE state of the journal: a
 * head read after the stream on a running control plane names records that
 * are not in `records.jsonl`, and the auditor's verifier then reports the
 * export as evidence of a discrepancy. `report-stream.ts` owns the view and
 * the honest cost of holding it.
 *
 * The chain block is still derived from a SECOND pass (`verifyChain`) rather
 * than from the streamed rows: the streamed rows carry only `doc`, and
 * folding the chain from them would re-derive the very hashes that are
 * supposed to be checked AGAINST what is stored. Two passes over the same
 * SNAPSHOT is the honest shape -- one asks "what does the journal say", the
 * other "does what it says hold together".
 *
 * ORDER OF ASSEMBLY (amendment A1). The manifest core is built first,
 * `summary.md` is rendered from it, and the summary's digest is folded into
 * the final manifest. The summary therefore shows every manifest field
 * except its own digest -- it cannot contain a hash of itself -- and says so
 * in its own text.
 */
export async function buildJournalReport(
  handle: SqliteHandle,
  options: ReportBuildOptions,
  sink: ReportRecordSink,
): Promise<JournalReport> {
  const session = options.session ?? null
  const now = options.now ?? (() => new Date().toISOString())
  return withConsistentReadView(handle, async () => {
    const tally = await streamRecords(handle, session, sink, createIncrementalSha256())
    const core = manifestCoreOf(handle, session, now(), tally)
    const summaryMarkdown = renderReportSummary({
      manifest: core,
      decisions: tally.decisions,
      omittedDecisionCount: tally.omittedDecisionCount,
    })
    return {
      // Spreading over a key the core already carries REPLACES the value and
      // keeps its position, so `summary` stays beside `records` in
      // `report.json` where a reader looks for it. (Field order does not
      // reach the signature -- `canonicalJson` sorts keys -- so this is for
      // the human reading the file.)
      manifest: {
        ...core,
        summary: { file: REPORT_FILES.summary, sha256: sha256Hex(summaryMarkdown) },
      },
      summaryMarkdown,
    }
  })
}

/**
 * The digest the summary is rendered against, standing in for a value that
 * cannot exist yet: `summary.sha256` is computed FROM the rendered text. It
 * never reaches disk -- the final manifest replaces it -- and
 * `report-summary.ts` deliberately never prints this field at all (A1),
 * which is why an empty placeholder is safe rather than a lie waiting to be
 * read. It exists so the renderer takes a whole `ReportManifest` instead of
 * a near-copy of the type.
 */
const SUMMARY_DIGEST_PENDING = ''

function manifestCoreOf(
  handle: SqliteHandle,
  session: string | null,
  asOf: string,
  tally: StreamTally,
): ReportManifest {
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    asOf,
    scope: { session },
    records: { file: REPORT_FILES.records, lineCount: tally.lineCount, sha256: tally.digestHex },
    summary: { file: REPORT_FILES.summary, sha256: SUMMARY_DIGEST_PENDING },
    // `seqRange` and `sessionIds` are derived from the rows that were
    // ACTUALLY exported (`report-stream.ts`), not from separate aggregates:
    // that is what makes "sessionIds non-empty iff lineCount > 0" and
    // "seqRange spans the exported records" true by construction rather than
    // by two queries happening to agree.
    seqRange: tally.seqRange,
    sessionIds: tally.sessionIds,
    counts: countsOf(tally),
    chain: chainInfoOf(handle, session),
    contract: AS_OF_CONTRACT,
  }
}

/**
 * `byOutcome` keys ascending, so two exports of the same journal produce
 * byte-identical manifests.
 *
 * `Object.fromEntries`, not `byOutcome[outcome] = n` on an object literal
 * (wave-5 review, MEDIUM): `outcome` is attacker-controlled -- only a
 * non-empty-string check guards it -- and assigning the key `__proto__`
 * reaches `Object.prototype`'s setter, which ignores a number and drops the
 * count silently. A count vanishing from SIGNED evidence with no error is
 * exactly the failure this format exists to prevent.
 * `Object.fromEntries` defines own properties instead, so `__proto__` is a
 * key like any other and survives the JSON round trip into `report.json`.
 */
function countsOf(tally: StreamTally): ReportCounts {
  const byOutcome = Object.fromEntries(
    [...tally.outcomeCounts.keys()].sort().map((outcome) => [outcome, tally.outcomeCounts.get(outcome) ?? 0]),
  )
  return {
    records: tally.lineCount,
    decisions: tally.decisionCount,
    unparsableRows: tally.unparsableRows,
    unprovenanced: tally.unprovenanced,
    byOutcome,
  }
}

function chainInfoOf(handle: SqliteHandle, session: string | null): ReportChainInfo {
  const walk = verifyChain(handle)
  const head = latestAttestedChainHead(handle)
  const recomputable = isChainRecomputable(session, walk.unattestedCount, walk.break, head !== null)
  return {
    verifiedAtExport: walk.break === null,
    break: walk.break,
    unattestedCount: walk.unattestedCount,
    head,
    recomputable,
    ...(recomputable ? { startPrevHash: resolveChainStartPrevHash(handle) } : {}),
    prunedThroughSeq: latestPruneMarker(handle)?.prunedThroughSeq ?? null,
  }
}

/**
 * Whether an auditor holding ONLY the export directory can re-derive
 * `chain.head.recordHash` by folding `linkHashOf(prev, doc)` over
 * `records.jsonl`'s lines, starting from `startPrevHash`. All four
 * conditions are necessary, and each one names a different way the fold
 * would silently produce a wrong answer:
 * - a session-scoped export omits every other session's rows, so the fold
 *   would be missing links the stored head was computed over;
 * - a pre-chain (`NULL`-hash) row is exported like any other but was never
 *   folded into the chain, so including it shifts every subsequent link;
 * - past a break, the stored head no longer descends from the rows before
 *   it, so nothing an honest fold produces can match it;
 * - with no attested head there is simply nothing to compare against.
 *
 * When this is `false` the export is not worthless -- the digest and the
 * signature still hold -- but the offline verifier must SAY that the chain
 * was not re-derivable from this export, and why (`verify --report`).
 */
export function isChainRecomputable(
  session: string | null,
  unattestedCount: number,
  chainBreak: ChainBreak | null,
  hasHead: boolean,
): boolean {
  return session === null && unattestedCount === 0 && chainBreak === null && hasHead
}
