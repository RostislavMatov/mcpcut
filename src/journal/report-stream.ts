import type { SqliteHandle } from '../store/sqlite.js'
import { numberOf, textOf } from './db-row.js'
import { parseJournalLine } from './line-source.js'
import type { PersistedDecisionInfo } from './record.js'
import { MAX_SUMMARY_DECISION_ROWS, type ReportDecisionRow } from './report-summary.js'

/**
 * How an audit report READS the journal (M5 wave 5, review round): one
 * snapshot, one pass. Split out of `report.ts` for the 400-line cap and
 * because it is a genuinely separate responsibility -- `report.ts` decides
 * what the manifest CLAIMS, this module decides what the export SAW, and the
 * whole correctness of the first depends on the second having seen one
 * consistent state.
 *
 * WHY A READ VIEW AT ALL (wave-5 review, CRITICAL). The first cut streamed
 * the rows in autocommit and then issued separate autocommit reads for the
 * chain walk, the chain head, the seq range and the session list. On a
 * RUNNING control plane -- the normal case, not an edge case -- rows land
 * between those reads, and it was reproduced 8 times out of 8: the manifest
 * attested a head at a `seq` that is not in `records.jsonl`, and the
 * auditor's own verifier then printed "the exported records do not chain to
 * the head this report attests to. Treat this export as evidence of a
 * discrepancy". The product accused its own operator of tampering because it
 * could not read its own database consistently. `.iterate()` is NOT a
 * snapshot on its own here, so "just stream it" does not fix it either.
 */

/**
 * Raised when the journal holds a row the export format cannot represent
 * faithfully. Distinct from an I/O failure: nothing is wrong with the disk,
 * the DATA is shaped in a way that makes an honest export impossible, and
 * the operator's next step is `mcpcut verify`, not a retry.
 */
export class ReportExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportExportError'
  }
}

/**
 * Runs `run` inside ONE deferred read transaction on `handle`, so every read
 * it performs -- the streaming pass and every aggregate after it -- sees the
 * same database state.
 *
 * `BEGIN DEFERRED`, not `handle.transaction()`: that helper takes the WRITE
 * lock (`BEGIN IMMEDIATE`) and requires a synchronous callback, and this pass
 * is both read-only and asynchronous (the sink is awaited for backpressure).
 * A write lock held for the length of a multi-gigabyte export would trade a
 * false-tamper bug for a control-plane-wide write stall, which is the worse
 * of the two.
 *
 * THE HONEST TRADE-OFF of the read lock we do take: in WAL mode (every
 * database this codebase opens) a read transaction does not block writers at
 * all -- the batch writer keeps committing throughout. What it does block is
 * WAL CHECKPOINTING: the `-wal` file cannot be truncated past this reader's
 * snapshot, so it grows for the duration of the export and is checkpointed
 * normally afterwards. Disk that comes back on its own is the right price for
 * an export that cannot slander its operator.
 *
 * The snapshot must be PINNED explicitly: `BEGIN DEFERRED` acquires nothing
 * until the first read, so a build that computed `asOf` or did any other work
 * before its first query would leave a window where rows still slip in. The
 * `SELECT` below is that first read, and everything after it -- `asOf`
 * included -- is inside the view.
 */
export async function withConsistentReadView<T>(
  handle: SqliteHandle,
  run: () => Promise<T>,
): Promise<T> {
  handle.db.exec('BEGIN DEFERRED')
  try {
    handle.db.prepare('SELECT MAX(seq) AS pinned FROM journal_records').get()
    const result = await run()
    handle.db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    // ROLLBACK must never mask the original failure (same rule as
    // `store/sqlite.ts`'s `runTransaction`); a leaked read transaction would
    // otherwise pin the WAL for the life of the process.
    try {
      handle.db.exec('ROLLBACK')
    } catch {
      // intentionally swallowed -- the original error is what matters
    }
    throw error
  }
}

/**
 * Where the exported record lines go. `writeLine` receives one line INCLUDING
 * its `\n` terminator, in `seq` order, and may return a promise to signal
 * backpressure -- the builder awaits it before pulling the next row, which is
 * what keeps a slow destination (a busy disk, a pipe) from letting the
 * journal accumulate in memory. Returning nothing is the un-awaited fast path.
 */
export interface ReportRecordSink {
  writeLine(line: string): Promise<void> | void
}

/** Everything one streaming pass over the in-scope rows produces. */
export interface StreamTally {
  readonly lineCount: number
  readonly digestHex: string
  readonly decisionCount: number
  readonly unparsableRows: number
  readonly unprovenanced: number
  readonly outcomeCounts: ReadonlyMap<string, number>
  readonly decisions: readonly ReportDecisionRow[]
  readonly omittedDecisionCount: number
  /** `null` when the export is empty -- an absent range, not a zero one. */
  readonly seqRange: { readonly firstSeq: number; readonly lastSeq: number } | null
  /** Sessions present in the export, ascending. */
  readonly sessionIds: readonly string[]
}

/** Digest interface, narrowed to what the pass uses; `policy/hash.ts` owns the implementation. */
export interface StreamDigest {
  update(chunk: string): void
  digestHex(): string
}

/**
 * `seq` and `session_id` travel with `doc` here, unlike the shared
 * `iterateAllDocs`/`iterateSessionDocs` which deliberately select `doc`
 * alone. Both extra columns are load-bearing for an EXPORT specifically and
 * for no other reader, which is why widening the shared iterators (and
 * slowing every page and search for this one caller) would be the wrong
 * trade:
 * - `seq` names the offending row when a `doc` cannot be represented (see
 *   below) and yields `seqRange` from the very rows that were exported,
 *   rather than from a second query that may see a different state;
 * - `session_id` yields `sessionIds` the same way. Taken from the COLUMN,
 *   not from the parsed doc: a row whose `doc` is unparsable still belongs to
 *   a session, and an auditor asking "whose traffic is in here" must not get
 *   an answer that omits exactly the rows that look tampered with.
 */
const SELECT_ALL_REPORT_ROWS =
  'SELECT seq, session_id AS sessionId, doc FROM journal_records ORDER BY seq'
const SELECT_SESSION_REPORT_ROWS =
  'SELECT seq, session_id AS sessionId, doc FROM journal_records WHERE session_id = ? ORDER BY seq'

/**
 * The single pass: one row read, one line written, one digest update. The
 * accumulators below are local `let`/`Map`/`Set` state, never a mutated
 * argument -- the same shape `verifyChain` uses for its walk.
 *
 * MUST run inside {@link withConsistentReadView}: everything the manifest
 * says about ranges, sessions and counts is derived here, and the chain block
 * derived by the caller has to describe the same rows.
 */
export async function streamRecords(
  handle: SqliteHandle,
  session: string | null,
  sink: ReportRecordSink,
  hasher: StreamDigest,
): Promise<StreamTally> {
  const outcomeCounts = new Map<string, number>()
  const sessionIds = new Set<string>()
  const decisions: ReportDecisionRow[] = []
  let lineCount = 0
  let decisionCount = 0
  let unparsableRows = 0
  let unprovenanced = 0
  let omittedDecisionCount = 0
  let firstSeq = 0
  let lastSeq = 0

  for (const row of rowsInScope(handle, session)) {
    const seq = numberOf(row['seq'])
    const doc = textOf(row['doc'])
    rejectUnrepresentableDoc(seq, doc)
    const line = `${doc}\n`
    hasher.update(line)
    lineCount += 1
    if (lineCount === 1) firstSeq = seq
    lastSeq = seq
    sessionIds.add(textOf(row['sessionId']))
    const pending = sink.writeLine(line)
    if (pending !== undefined) await pending

    const record = parseJournalLine(doc)
    if (record === null) {
      unparsableRows += 1
      continue
    }
    const decision = record.decision
    if (record.kind !== 'decision' || decision === undefined) continue
    decisionCount += 1
    if (decision.policyHash === undefined) unprovenanced += 1
    outcomeCounts.set(decision.outcome, (outcomeCounts.get(decision.outcome) ?? 0) + 1)
    if (decisions.length < MAX_SUMMARY_DECISION_ROWS) {
      decisions.push(decisionRowOf(record.sessionId, record.ts, decision))
    } else {
      omittedDecisionCount += 1
    }
  }

  return {
    lineCount,
    digestHex: hasher.digestHex(),
    decisionCount,
    unparsableRows,
    unprovenanced,
    outcomeCounts,
    decisions,
    omittedDecisionCount,
    seqRange: lineCount === 0 ? null : { firstSeq, lastSeq },
    sessionIds: [...sessionIds].sort(),
  }
}

/**
 * A `doc` holding a raw newline cannot be represented in `records.jsonl` --
 * one row would arrive as two lines -- and the export must not pretend it
 * did.
 *
 * WHY NOT ESCAPE IT (wave-5 review, HIGH). The chain hashes `doc` byte for
 * byte and the auditor re-hashes exactly the bytes they received, so any
 * re-encoding on the way out breaks the re-fold for every row after it. And
 * the failure this closes was not theoretical: the writer emitted `${doc}\n`
 * and counted DB rows while the verifier counts `\n`, so ONE planted row
 * (same-uid actor -- already inside the threat model) made every future
 * export of that installation verify as tampered, or buried a real finding
 * under the noise. Refusing loudly, naming the row, and sending the operator
 * to `mcpcut verify` is the only answer that neither lies nor hides.
 */
function rejectUnrepresentableDoc(seq: number, doc: string): void {
  if (!doc.includes('\n')) return
  throw new ReportExportError(
    `Refusing to export: the journal row at seq ${seq} holds a raw newline inside its stored ` +
      'record, which records.jsonl (one record per line) cannot represent faithfully. The ' +
      'record is not re-encoded, because the hash chain attests its exact bytes. Investigate ' +
      'the row first: mcpcut verify',
  )
}

/** Builds one summary row, keeping the codebase's "absent, not null" convention for every optional field. */
function decisionRowOf(
  sessionId: string,
  ts: string,
  decision: PersistedDecisionInfo,
): ReportDecisionRow {
  return {
    sessionId,
    ts,
    outcome: decision.outcome,
    rule: decision.rule,
    toolName: decision.toolName,
    // `argsHash` is NOT validated by `isDecisionShape` (`line-source.ts`
    // checks outcome/rule/toolName only), so a record read back from disk can
    // legitimately lack it. It is carried through as absent rather than
    // coerced: `report-summary.ts` renders the absence explicitly. Before the
    // wave-5 review this field was assumed present and the renderer threw
    // mid-write on the first such row.
    ...(typeof decision.argsHash === 'string' ? { argsHash: decision.argsHash } : {}),
    ...(decision.actor === undefined ? {} : { actor: decision.actor }),
    ...(decision.policyHash === undefined ? {} : { policyHash: decision.policyHash }),
    ...(decision.grantsHash === undefined ? {} : { grantsHash: decision.grantsHash }),
  }
}

function rowsInScope(
  handle: SqliteHandle,
  session: string | null,
): Iterable<Record<string, unknown>> {
  return session === null
    ? handle.db.prepare(SELECT_ALL_REPORT_ROWS).iterate()
    : handle.db.prepare(SELECT_SESSION_REPORT_ROWS).iterate(session)
}
