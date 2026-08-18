import type { SqliteHandle } from '../store/sqlite.js'
import { GENESIS_PREV_HASH, linkHashOf } from './chain.js'
import { numberOf, textOf } from './db-row.js'

/**
 * `mcp-journal verify`'s reusable core (M5 wave 3, task 3.3): walks
 * `journal_records` in `seq` order, re-derives every stored `record_hash`
 * from `linkHashOf(prevHash, doc)`, and reports the first point at which the
 * recomputed chain and the stored one disagree. Pure of CLI concerns --
 * `src/cli/verify-cmd.ts` is the argv/output half, kept in its own file
 * because this project caps files at 400 lines and later waves (`verify
 * --sign`, `verify --report`) extend this same module.
 *
 * Streamed, not materialized: `handle.db.prepare(...).iterate()` mirrors
 * `db-read.ts`'s `iterateAllDocs` (a 1M-row journal must not be held in
 * memory to be verified), but this walk needs `seq`/`prev_hash`/`record_hash`
 * alongside `doc`, which `iterateAllDocs` does not select -- hence a
 * dedicated query here rather than reusing that generator.
 *
 * Two DISAGREEMENT PATTERNS are distinguishable from stored columns alone
 * (plan design decision 4, "honest threat model") -- but they are labels for
 * which column check failed, NOT a claim that the underlying tamper action
 * is identifiable from that label. That claim would overstate what two
 * columns per row can prove:
 * - a row's `record_hash` does not match `linkHashOf` of its OWN recorded
 *   `prev_hash` and CURRENT `doc` -- that row's `doc` was changed WITHOUT
 *   also recomputing its own hash to match ("modified"). This is what a
 *   NAIVE edit, or plain corruption, looks like, and it is unambiguous: no
 *   other real-world event produces this exact pattern.
 * - a row's `prev_hash` does not match the `record_hash` actually produced
 *   by the row before it in the walk ("gap"). Reported at the `seq` of the
 *   SURVIVING row immediately after the break, since a deleted row has no
 *   `seq` left to name. A genuine deletion, insertion, or reorder produces
 *   this pattern -- but so does a CAREFUL edit of the PRECEDING row that
 *   also recomputes THAT row's own `record_hash` from its own stored
 *   `prev_hash`, exactly as a legitimate write would: the edited row is then
 *   internally self-consistent (the "modified" check at ITS OWN seq finds
 *   nothing wrong), and the disagreement only becomes visible one row later,
 *   reported as a "gap" that never actually happened there. The two stored
 *   columns per row cannot tell a careful single-row edit apart from a
 *   genuine deletion/insertion/reorder -- there is no fix for that within
 *   this data shape, only honest reporting of it (`verify-cmd.ts`'s
 *   `breakDescription` states both causes for a "gap"; a dedicated test in
 *   `chain-verify.test.ts` forges exactly this case and pins the result, so
 *   this is not later "fixed" into a false claim of finer distinction).
 *
 * A chain (and, later, its signature) proves tamper-EVIDENCE, not
 * tamper-PROOF: a process running under the same uid that wrote the database
 * can rewrite it end to end, recomputing every hash consistently, and a
 * chain trimmed from its TAIL (the newest rows deleted, nothing after them
 * left to disagree with) verifies as perfectly clean -- there is no gap to
 * find because nothing remains to point at what used to be there. Nothing in
 * this module can detect that; only an external anchor (an exported,
 * separately-stored chain head -- a later wave) can. Say so plainly wherever
 * this result reaches an operator; do not imply a stronger guarantee.
 */

/** One kind of detected break, named exactly as an auditor would ask about it. */
export type ChainBreakReason = 'modified' | 'gap'

export interface ChainBreak {
  readonly seq: number
  readonly reason: ChainBreakReason
}

/**
 * The full-journal walk's outcome. `unattestedCount` counts the LEADING run
 * of pre-chain rows (both hash columns `NULL` -- see `db.ts`'s module doc
 * for what that means): they are reported, never silently folded into
 * "verified", so an operator cannot mistake "written before attestation
 * existed" for "checked and intact" -- there is no retroactive signing.
 */
export interface ChainVerifyResult {
  readonly totalRowCount: number
  readonly unattestedCount: number
  /**
   * Highest `seq` among the leading unattested rows, or `null` when there is
   * no such prefix. Lets a caller (the `--session` report) tell whether a
   * session's own `seq` range predates the chain entirely, straddles the
   * boundary, or sits wholly after it -- `unattestedCount` alone gives the
   * count but not where the boundary falls.
   */
  readonly unattestedThroughSeq: number | null
  readonly attestedCount: number
  /** Highest `seq` confirmed intact, or `null` when no row has been attested yet. */
  readonly intactThroughSeq: number | null
  /** `null` when the walk found no disagreement anywhere it looked. */
  readonly break: ChainBreak | null
}

/**
 * Resolves the `prevHash` the walk starts its attested rows from. Today this
 * is always `GENESIS_PREV_HASH`: there is no prune-marker table yet.
 * Retention pruning (a later wave) will delete an old prefix of
 * `journal_records` and record a marker holding the head of the deleted
 * prefix; THAT wave fills this function in to read the marker, so a pruned
 * database's remaining suffix still verifies from a trusted starting point
 * instead of every walk failing against a genesis whose row 1 no longer
 * exists. Callers must call this function rather than hardcode
 * `GENESIS_PREV_HASH`, so the later wave has exactly one place to change.
 */
export function resolveChainStartPrevHash(_handle: SqliteHandle): string {
  return GENESIS_PREV_HASH
}

/** One row as the walk needs it; nullable hash columns keep pre-chain rows distinguishable from tampered ones. */
interface ChainRow {
  readonly seq: number
  readonly doc: string
  readonly prevHash: string | null
  readonly recordHash: string | null
}

const SELECT_CHAIN_ROWS =
  'SELECT seq, doc, prev_hash AS prevHash, record_hash AS recordHash FROM journal_records ORDER BY seq'

/**
 * Walks the whole journal once, in `seq` order, streamed via `.iterate()`
 * (never `.all()` -- see the module doc). Stops at the first break it finds:
 * once the chain has diverged from what is recorded, nothing past that point
 * can be trusted as a "prev" to keep checking against, and re-anchoring on
 * the tampered row's own claim would defeat the point of checking it.
 */
export function verifyChain(handle: SqliteHandle): ChainVerifyResult {
  let totalRowCount = 0
  let unattestedCount = 0
  let unattestedThroughSeq: number | null = null
  let attestedCount = 0
  let intactThroughSeq: number | null = null
  let chainStarted = false
  let prev = resolveChainStartPrevHash(handle)
  let brokenAt: ChainBreak | null = null

  for (const row of handle.db.prepare(SELECT_CHAIN_ROWS).iterate()) {
    const chainRow = chainRowOf(row)
    totalRowCount += 1

    if (!chainStarted && chainRow.prevHash === null && chainRow.recordHash === null) {
      // A leading pre-chain row (db.ts: written before the chain existed).
      // Never mistaken for a break -- see ChainVerifyResult's doc.
      unattestedCount += 1
      unattestedThroughSeq = chainRow.seq
      continue
    }
    chainStarted = true

    if (chainRow.prevHash !== prev) {
      brokenAt = { seq: chainRow.seq, reason: 'gap' }
      break
    }
    const expectedHash = linkHashOf(prev, chainRow.doc)
    if (chainRow.recordHash !== expectedHash) {
      brokenAt = { seq: chainRow.seq, reason: 'modified' }
      break
    }
    prev = chainRow.recordHash
    intactThroughSeq = chainRow.seq
    attestedCount += 1
  }

  return {
    totalRowCount,
    unattestedCount,
    unattestedThroughSeq,
    attestedCount,
    intactThroughSeq,
    break: brokenAt,
  }
}

function chainRowOf(row: Record<string, unknown>): ChainRow {
  return {
    seq: numberOf(row['seq']),
    doc: typeof row['doc'] === 'string' ? row['doc'] : '',
    prevHash: nullableTextOf(row['prevHash']),
    recordHash: nullableTextOf(row['recordHash']),
  }
}

/**
 * A TEXT column's value, preserving `NULL` as `null` -- unlike `db-row.ts`'s
 * `textOf`, which folds absence into `''` and would make a pre-chain row
 * indistinguishable from one whose hash happened to BE the empty string.
 */
function nullableTextOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The chain's current, most-recent attested position: what `verify --sign` (M5 wave 4) signs. */
export interface ChainHead {
  readonly seq: number
  readonly recordHash: string
}

const SELECT_LATEST_ATTESTED_HEAD =
  'SELECT seq, record_hash AS recordHash FROM journal_records ' +
  'WHERE record_hash IS NOT NULL ORDER BY seq DESC LIMIT 1'

/**
 * The chain head available to be SIGNED (`verify --sign`, M5 wave 4, task
 * 4.3): the highest-`seq` row that actually carries a `record_hash`, i.e.
 * was written after the chain existed. `null` covers BOTH traps a signer
 * must not paper over (plan wave 4: "signing a head that does not exist, or
 * signing an all-unattested journal as though it were attested, are both
 * traps"):
 * - an empty journal -- there is no row at all;
 * - a journal that predates the chain entirely -- every row's hash columns
 *   are `NULL` (see `ChainVerifyResult`'s doc), so none of them may be
 *   presented as attested.
 *
 * This does not need to walk the whole table or reason about breaks: a
 * chained row can never be followed by a `NULL` one (`verifyChain`'s
 * `chainStarted` only advances one way, matching how `insertRecordRows`
 * only ever appends chained rows once the chain has begun), so the
 * highest `seq` with a non-`NULL` hash is simply the highest `seq` whenever
 * ANY chained row exists. A signed head is not a claim that everything
 * before it is intact -- see this module's top-of-file threat-model note and
 * `verify-cmd.ts`'s `--sign` output, which says so explicitly when a break
 * was also found in the same run.
 */
export function latestAttestedChainHead(handle: SqliteHandle): ChainHead | null {
  const row = handle.db.prepare(SELECT_LATEST_ATTESTED_HEAD).get()
  if (row === undefined) return null
  return { seq: numberOf(row['seq']), recordHash: textOf(row['recordHash']) }
}

/** One session's footprint in the chain: how many of its rows exist and the `seq` range they span. */
export interface SessionChainSpan {
  readonly sessionId: string
  readonly rowCount: number
  readonly firstSeq: number
  readonly lastSeq: number
}

const SELECT_SESSION_SEQ_SPAN =
  'SELECT COUNT(*) AS rowCount, MIN(seq) AS firstSeq, MAX(seq) AS lastSeq ' +
  'FROM journal_records WHERE session_id = ?'

/**
 * One session's row count and `seq` range, or `null` when the database holds
 * no row for it. A dedicated query rather than reuse of
 * `db-read-session.ts`'s helpers: that module answers "what are the
 * records", this answers "where does this session sit in the chain's
 * order" -- `seq`, not `doc`.
 */
export function sessionChainSpan(handle: SqliteHandle, sessionId: string): SessionChainSpan | null {
  const row = handle.db.prepare(SELECT_SESSION_SEQ_SPAN).get(sessionId)
  if (row === undefined) return null
  const rowCount = numberOf(row['rowCount'])
  if (rowCount === 0) return null
  return { sessionId, rowCount, firstSeq: numberOf(row['firstSeq']), lastSeq: numberOf(row['lastSeq']) }
}
