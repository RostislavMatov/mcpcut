import type { SqliteHandle } from '../store/sqlite.js'
import { numberOf, textOf } from './db-row.js'
import {
  CHAIN_HEAD_ANCHOR_FORMAT_VERSION,
  signChainHeadAnchor,
  type SigningPrivateKeyLookup,
} from './signing.js'

/**
 * Retention pruning (M5 wave 6, task 6.1) -- the DELETE half of an
 * evidentiary journal, and the marker that keeps what remains provable.
 *
 * OWNER DECISION O6: a mechanism, never a default. Nothing in this codebase
 * calls `pruneRecordsOlderThan` on a timer; rows leave the journal only when
 * an operator runs `mcp-journal prune --older-than`. Deleting evidence is a
 * decision a person makes, and the first auditor who names a retention period
 * is the earliest point at which a default could be anything but a guess.
 *
 * WHY A MARKER AT ALL. Every surviving row's `prev_hash` names the row before
 * it. Delete a prefix and the oldest survivor points at a row that no longer
 * exists, so a plain `verify` would report a break -- pruning would look
 * exactly like tampering, and an operator who prunes would learn to ignore
 * the one signal the chain exists to give. The marker records where the chain
 * now starts (`headRecordHash`, the `record_hash` of the last deleted row), so
 * `verifyChain` re-anchors there and the remaining suffix is provable on its
 * own.
 *
 * WHAT THE MARKER DOES NOT PROVE. It is written by the same process, under the
 * same uid, that could have rewritten the journal outright -- it is the
 * operator's own claim about what was deleted, not independent evidence. What
 * makes it worth anything to an auditor is the SIGNATURE (when a key exists)
 * plus an out-of-band anchor taken earlier: a chain head recorded before the
 * prune, compared against the marker afterwards, is what turns "rows 1..N were
 * removed" from an assertion into something checkable. Said plainly wherever
 * this reaches an operator (`prune-cmd.ts`, `verify`, README).
 *
 * PREFIX, NOT PREDICATE. Rows are deleted as a contiguous `seq` prefix whose
 * every row is older than the cutoff -- never "every row whose `ts` is old".
 * `ts` is the record's own timestamp and does not have to rise with `seq`
 * (imported legacy sessions, a clock step, a slow writer). A timestamp
 * predicate would punch a hole in the middle of the chain, and a hole is
 * unrepairable: the rows after it can never be re-anchored to anything. So an
 * old row sitting behind a newer one survives its cutoff, and says so.
 */

/** The signature over a marker, present only when a signing key existed at prune time. */
export interface PruneMarkerSignature {
  readonly formatVersion: number
  readonly signedAt: string
  readonly keyFingerprint: string
  readonly signatureBase64: string
}

/** One recorded prune: which prefix left, when, and what the chain now hangs from. */
export interface PruneMarker {
  /** Highest `seq` that was deleted. Every surviving row has a higher `seq` (AUTOINCREMENT never reuses one). */
  readonly prunedThroughSeq: number
  /**
   * `record_hash` of the last deleted row -- the `prev_hash` the oldest
   * surviving row must carry. `null` when the deleted prefix was entirely
   * pre-chain rows (`db.ts`: written before attestation existed), in which
   * case the surviving chain still starts at genesis and there is nothing to
   * attest.
   */
  readonly headRecordHash: string | null
  readonly prunedAt: string
  readonly deletedCount: number
  readonly signature?: PruneMarkerSignature
}

export interface PruneOutcome {
  readonly deletedCount: number
  /** `null` when nothing was old enough: no rows left, so no marker was written. */
  readonly marker: PruneMarker | null
  /** Lowest `seq` still in the journal, or `null` when the journal is now empty. */
  readonly firstRemainingSeq: number | null
}

export interface PruneInput {
  /** Records with `ts` strictly less than this ISO instant are eligible. */
  readonly cutoffIso: string
  /** When the prune happened, stamped on the marker (and signed with it). */
  readonly nowIso: string
  /** The installation's key, if one exists. An absent key produces an UNSIGNED marker -- never a fake one. */
  readonly signingKey: SigningPrivateKeyLookup
}

/**
 * The first row (in `seq` order) that is NOT older than the cutoff. Everything
 * strictly before it is the deletable prefix -- see the module doc on why this
 * is a prefix query rather than `DELETE WHERE ts < ?`.
 */
const SELECT_FIRST_RETAINED_SEQ =
  'SELECT seq FROM journal_records WHERE ts >= ? ORDER BY seq LIMIT 1'

/** The prefix's last row: its `seq` bounds the delete, its `record_hash` becomes the marker head. */
const SELECT_PREFIX_HEAD =
  'SELECT seq, record_hash AS recordHash FROM journal_records WHERE seq < ? ORDER BY seq DESC LIMIT 1'

/** Same, for the case where NO row is young enough: the whole journal is the prefix. */
const SELECT_LAST_ROW = 'SELECT seq, record_hash AS recordHash FROM journal_records ORDER BY seq DESC LIMIT 1'

const COUNT_PREFIX = 'SELECT COUNT(*) AS n FROM journal_records WHERE seq <= ?'
const DELETE_PREFIX = 'DELETE FROM journal_records WHERE seq <= ?'
const SELECT_FIRST_SEQ = 'SELECT seq FROM journal_records ORDER BY seq LIMIT 1'

const INSERT_MARKER =
  'INSERT INTO journal_prune_marker ' +
  '(pruned_through_seq, head_record_hash, pruned_at, deleted_count, signature_format_version, signed_at, key_fingerprint, signature) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

export const SELECT_LATEST_PRUNE_MARKER =
  'SELECT pruned_through_seq AS prunedThroughSeq, head_record_hash AS headRecordHash, ' +
  'pruned_at AS prunedAt, deleted_count AS deletedCount, signature_format_version AS signatureFormatVersion, ' +
  'signed_at AS signedAt, key_fingerprint AS keyFingerprint, signature ' +
  'FROM journal_prune_marker ORDER BY pruned_through_seq DESC LIMIT 1'

/** What a prune WOULD do, without doing it: the `--yes`-less half of `prune-cmd.ts`. */
export interface PrunePlan {
  readonly prunedThroughSeq: number
  readonly headRecordHash: string | null
  readonly deletedCount: number
  readonly firstSeq: number
}

/**
 * The prefix a prune with this cutoff would delete, or `null` when nothing is
 * old enough. Read-only and outside any transaction: it informs an operator's
 * decision, it does not reserve anything, and the real prune re-derives the
 * boundary inside its own transaction rather than trusting this answer -- rows
 * can arrive between the two, and a boundary computed before the write lock
 * would be exactly the stale-head bug `insertRecordRows` warns about.
 */
export function planPruneOlderThan(handle: SqliteHandle, cutoffIso: string): PrunePlan | null {
  const boundary = prefixBoundaryOf(handle.db, cutoffIso)
  if (boundary === null) return null
  const firstSeq = firstSeqOf(handle.db)
  if (firstSeq === null) return null
  return {
    prunedThroughSeq: boundary.seq,
    headRecordHash: boundary.recordHash,
    deletedCount: numberOf((handle.db.prepare(COUNT_PREFIX).get(boundary.seq) as { n: unknown }).n),
    firstSeq,
  }
}

/**
 * Deletes the leading run of records older than `cutoffIso` and records one
 * marker for it, in a SINGLE transaction: a delete that committed without its
 * marker would leave a journal whose surviving rows verify against nothing,
 * and there would be no way afterwards to tell that state apart from tampering
 * (the head hash it needed died with the rows). One transaction is what makes
 * "pruned" a state the journal can be IN, rather than a state it can be caught
 * halfway into.
 */
export function pruneRecordsOlderThan(handle: SqliteHandle, input: PruneInput): PruneOutcome {
  return handle.transaction((db): PruneOutcome => {
    const boundary = prefixBoundaryOf(db, input.cutoffIso)
    if (boundary === null) {
      return { deletedCount: 0, marker: null, firstRemainingSeq: firstSeqOf(db) }
    }

    const deletedCount = numberOf((db.prepare(COUNT_PREFIX).get(boundary.seq) as { n: unknown }).n)
    db.prepare(DELETE_PREFIX).run(boundary.seq)
    const marker = markerFor(boundary, deletedCount, input)
    db.prepare(INSERT_MARKER).run(
      marker.prunedThroughSeq,
      marker.headRecordHash,
      marker.prunedAt,
      marker.deletedCount,
      marker.signature?.formatVersion ?? null,
      marker.signature?.signedAt ?? null,
      marker.signature?.keyFingerprint ?? null,
      marker.signature?.signatureBase64 ?? null,
    )
    return { deletedCount, marker, firstRemainingSeq: firstSeqOf(db) }
  })
}

/** The `seq`/`record_hash` of the last row in the deletable prefix, or `null` when there is no such prefix. */
function prefixBoundaryOf(
  db: DatabaseLike,
  cutoffIso: string,
): { readonly seq: number; readonly recordHash: string | null } | null {
  const firstRetained = db.prepare(SELECT_FIRST_RETAINED_SEQ).get(cutoffIso) as { seq: unknown } | undefined
  const row =
    firstRetained === undefined
      ? (db.prepare(SELECT_LAST_ROW).get() as PrefixHeadRow | undefined)
      : (db.prepare(SELECT_PREFIX_HEAD).get(numberOf(firstRetained.seq)) as PrefixHeadRow | undefined)
  if (row === undefined) return null
  return { seq: numberOf(row.seq), recordHash: typeof row.recordHash === 'string' ? row.recordHash : null }
}

interface PrefixHeadRow {
  readonly seq: unknown
  readonly recordHash: unknown
}

/**
 * Builds the marker, signing it when a key is present AND there is a hash to
 * sign. The statement signed is the same shape `verify --sign` produces -- "at
 * this instant, the chain head at seq N was H" -- reusing
 * `signChainHeadAnchor` rather than inventing a second signed statement: two
 * formats would mean two verification paths for one claim, and an auditor
 * checking a marker would need tooling they do not need for an anchor.
 *
 * A key that exists but a prefix with no hash (all pre-chain rows) produces an
 * UNSIGNED marker on purpose: signing `null` would either require a
 * placeholder hash -- a statement about a chain position that never existed --
 * or a second format for "nothing was attested". The marker says what it knows.
 */
function markerFor(
  boundary: { readonly seq: number; readonly recordHash: string | null },
  deletedCount: number,
  input: PruneInput,
): PruneMarker {
  const base: PruneMarker = {
    prunedThroughSeq: boundary.seq,
    headRecordHash: boundary.recordHash,
    prunedAt: input.nowIso,
    deletedCount,
  }
  if (!input.signingKey.present || boundary.recordHash === null) return base

  const signed = signChainHeadAnchor(input.signingKey.privateKeyPem, {
    formatVersion: CHAIN_HEAD_ANCHOR_FORMAT_VERSION,
    seq: boundary.seq,
    recordHash: boundary.recordHash,
    signedAt: input.nowIso,
  })
  return {
    ...base,
    signature: {
      formatVersion: signed.anchor.formatVersion,
      signedAt: signed.anchor.signedAt,
      keyFingerprint: signed.anchor.keyFingerprint,
      signatureBase64: signed.signatureBase64,
    },
  }
}

function firstSeqOf(db: DatabaseLike): number | null {
  const row = db.prepare(SELECT_FIRST_SEQ).get() as { seq: unknown } | undefined
  return row === undefined ? null : numberOf(row.seq)
}

/**
 * The most recent marker, or `null` on a journal that was never pruned.
 * "Most recent" is by `pruned_through_seq`, not by `pruned_at`: `seq` is
 * assigned by the database and only moves forward, while a timestamp comes
 * from a clock that can step backwards.
 */
export function latestPruneMarker(handle: SqliteHandle): PruneMarker | null {
  const row = handle.db.prepare(SELECT_LATEST_PRUNE_MARKER).get() as Record<string, unknown> | undefined
  return row === undefined ? null : markerOf(row)
}

export function markerOf(row: Record<string, unknown>): PruneMarker {
  const base: PruneMarker = {
    prunedThroughSeq: numberOf(row['prunedThroughSeq']),
    headRecordHash: typeof row['headRecordHash'] === 'string' ? row['headRecordHash'] : null,
    prunedAt: textOf(row['prunedAt']),
    deletedCount: numberOf(row['deletedCount']),
  }
  const signature = row['signature']
  if (typeof signature !== 'string') return base
  return {
    ...base,
    signature: {
      formatVersion: numberOf(row['signatureFormatVersion']),
      signedAt: textOf(row['signedAt']),
      keyFingerprint: textOf(row['keyFingerprint']),
      signatureBase64: signature,
    },
  }
}

/** The minimum of `node:sqlite`'s database this module uses, so it never imports the runtime API directly. */
interface DatabaseLike {
  prepare(sql: string): {
    get(...params: readonly unknown[]): unknown
    run(...params: readonly unknown[]): unknown
  }
}
