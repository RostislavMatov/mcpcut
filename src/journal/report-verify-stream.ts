import { createIncrementalSha256 } from '../policy/hash.js'
import { linkHashOf } from './chain.js'
import { parseJournalLine } from './line-source.js'

/**
 * The one streaming pass an offline verifier makes over `records.jsonl`
 * (M5 wave 5, task 5.3; rewritten in the wave-5 review round). Digest, line
 * count, chain re-fold and every count the manifest claims are derived from
 * the SAME chunks, so "the digest passed but the counts were computed over
 * something else" cannot happen.
 *
 * BYTES, NOT TEXT (review finding V2 -- CRITICAL). The previous version
 * opened the file with `{ encoding: 'utf8' }` and hashed the decoded chunks.
 * Decoding is lossy: every invalid byte becomes U+FFFD, so two files
 * differing at one byte (0x80 vs 0xff) digested identically and both passed
 * against one signature -- while the manifest, the CLI output and the README
 * all promise "sha256 hex over the EXACT bytes". So chunks arrive as bytes,
 * the digest sees them verbatim, and lines are split on the BYTE 0x0A rather
 * than on a decoded '\n'.
 *
 * Each line is decoded to a string only where the chain's own definition
 * requires it: `linkHashOf(prev, doc)` and `parseJournalLine(doc)` are
 * defined over the `doc` STRING, which is how the producing side computed
 * both. A line that is not valid UTF-8 cannot have come from this journal
 * (the stored `doc` is JSON text), and the byte digest above is what catches
 * it -- the fold merely produces a mismatch, which is the correct direction.
 *
 * THE LINE BUFFER IS BOUNDED (review finding V7). `pending += chunk` held a
 * whole line, so a `records.jsonl` with no newline at all was held whole: a
 * measured 200 MB single-line file peaked at 1.41 GB RSS over 58 seconds on
 * an auditor's laptop -- the machine this module's own doc singles out as
 * least likely to have the memory -- and one crafted file in a hostile
 * bundle triggers it. Past the bound the pass stops assembling lines and
 * keeps digesting: the digest needs no line structure, so the check that can
 * still answer still answers, and everything line-derived becomes an
 * explicit could-not-run instead of an OOM or a `RangeError` wearing an I/O
 * error's clothes.
 */

/**
 * The longest single line this verifier will assemble, in bytes. A journal
 * `doc` is one JSON record; 8 MiB is orders of magnitude above anything the
 * writing side can produce (payloads are redacted and truncated long before
 * they are stored) and small enough that a hostile file cannot exhaust an
 * auditor's laptop. Exceeding it is reported, never silently truncated.
 */
export const MAX_RECORD_LINE_BYTES = 8 * 1024 * 1024

/** The line terminator, as a BYTE. The export writes `\n` (0x0A) and nothing else. */
const NEWLINE_BYTE = 0x0a

/** Everything one pass over `records.jsonl` establishes. `foldedHash` is `null` when no fold was requested. */
export interface RecordStreamTally {
  readonly digestHex: string
  readonly lineCount: number
  readonly foldedHash: string | null
  /** A last line with no `\n`: counted, never dropped -- dropping it would let a mid-line truncation look like a smaller-but-tidy export. */
  readonly unterminatedTail: boolean
  /** Set to the offending length when a line exceeded {@link MAX_RECORD_LINE_BYTES}; every line-derived field above and below is then incomplete and must be reported as could-not-run. */
  readonly overlongLineBytes: number | null
  readonly decisions: number
  readonly unparsableRows: number
  readonly unprovenanced: number
  /** Decision outcome -> count, re-derived from the exported bytes. */
  readonly byOutcome: ReadonlyMap<string, number>
  /** Sessions actually present in the exported records (from each record's own `sessionId`). */
  readonly sessionIds: ReadonlySet<string>
}

/** Mutable accumulator, local to one pass -- never a mutated argument. Mirrors the shape `report.ts`'s own streaming pass uses. */
interface Accumulator {
  lineCount: number
  folded: string | null
  decisions: number
  unparsableRows: number
  unprovenanced: number
  readonly byOutcome: Map<string, number>
  readonly sessionIds: Set<string>
}

/**
 * Digests the chunks verbatim while splitting and folding the lines they
 * carry. `foldFrom` is the chain start (`null` when no fold applies).
 */
export async function streamRecordBytes(
  chunks: AsyncIterable<Uint8Array>,
  foldFrom: string | null,
): Promise<RecordStreamTally> {
  const hasher = createIncrementalSha256()
  const acc = newAccumulator(foldFrom)
  let pending: Buffer[] = []
  let pendingBytes = 0
  let overlongLineBytes: number | null = null

  for await (const chunk of chunks) {
    hasher.update(chunk)
    if (overlongLineBytes !== null) continue
    const buffer = bufferOf(chunk)
    let start = 0
    let newlineAt = buffer.indexOf(NEWLINE_BYTE, start)
    while (newlineAt !== -1) {
      takeLine(acc, joinLine(pending, buffer.subarray(start, newlineAt)))
      pending = []
      pendingBytes = 0
      start = newlineAt + 1
      newlineAt = buffer.indexOf(NEWLINE_BYTE, start)
    }
    const rest = buffer.subarray(start)
    if (rest.length === 0) continue
    if (pendingBytes + rest.length > MAX_RECORD_LINE_BYTES) {
      overlongLineBytes = pendingBytes + rest.length
      pending = []
      pendingBytes = 0
      continue
    }
    // Copied, not retained as a view: a stream's chunk buffer can be far
    // larger than the tail we need, and holding the view would pin all of it.
    pending.push(Buffer.from(rest))
    pendingBytes += rest.length
  }

  const unterminatedTail = pendingBytes > 0
  if (unterminatedTail) takeLine(acc, joinLine(pending, EMPTY_BUFFER))
  return tallyOf(acc, hasher.digestHex(), unterminatedTail, overlongLineBytes)
}

/** Digests a file whose line structure is irrelevant (`summary.md`), through the same byte path. */
export async function digestBytes(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hasher = createIncrementalSha256()
  for await (const chunk of chunks) hasher.update(chunk)
  return hasher.digestHex()
}

const EMPTY_BUFFER = Buffer.alloc(0)

function newAccumulator(foldFrom: string | null): Accumulator {
  return {
    lineCount: 0,
    folded: foldFrom,
    decisions: 0,
    unparsableRows: 0,
    unprovenanced: 0,
    byOutcome: new Map<string, number>(),
    sessionIds: new Set<string>(),
  }
}

function tallyOf(
  acc: Accumulator,
  digestHex: string,
  unterminatedTail: boolean,
  overlongLineBytes: number | null,
): RecordStreamTally {
  return {
    digestHex,
    lineCount: acc.lineCount,
    foldedHash: acc.folded,
    unterminatedTail,
    overlongLineBytes,
    decisions: acc.decisions,
    unparsableRows: acc.unparsableRows,
    unprovenanced: acc.unprovenanced,
    byOutcome: acc.byOutcome,
    sessionIds: acc.sessionIds,
  }
}

/** A `Buffer` view over whatever the caller yielded, without copying when it already is one. */
function bufferOf(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

/** One line's bytes: the fast path (no carry-over) hands back the view itself. */
function joinLine(pending: readonly Buffer[], tail: Buffer): Buffer {
  return pending.length === 0 ? tail : Buffer.concat([...pending, tail])
}

/**
 * One line, counted the way the PRODUCER counted it. `parseJournalLine` is
 * the exporter's own helper, reused deliberately: a private re-implementation
 * of "what is a decision" here would let the two sides drift, and the only
 * place that drift would surface is an auditor's laptop, where nothing fails
 * loudly.
 */
function takeLine(acc: Accumulator, lineBytes: Buffer): void {
  acc.lineCount += 1
  const doc = lineBytes.toString('utf8')
  if (acc.folded !== null) acc.folded = linkHashOf(acc.folded, doc)

  const record = parseJournalLine(doc)
  if (record === null) {
    acc.unparsableRows += 1
    return
  }
  acc.sessionIds.add(record.sessionId)
  const decision = record.decision
  if (record.kind !== 'decision' || decision === undefined) return
  acc.decisions += 1
  if (decision.policyHash === undefined) acc.unprovenanced += 1
  acc.byOutcome.set(decision.outcome, (acc.byOutcome.get(decision.outcome) ?? 0) + 1)
}
