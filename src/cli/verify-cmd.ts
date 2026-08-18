import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import {
  sessionChainSpan,
  verifyChain,
  type ChainBreakReason,
  type ChainVerifyResult,
  type SessionChainSpan,
} from '../journal/chain-verify.js'
import { openJournalDbIfPresent } from '../journal/db.js'
import { isValidSessionId } from '../journal/session-id.js'

/**
 * `mcp-journal verify [--session <id>]` -- the operator/auditor-facing half
 * of the M5 wave 3 hash chain (`journal/chain-verify.ts` does the walk; this
 * module is argv, output formatting, and the exit code). Mirrors
 * `export-cmd.ts`'s shape: a journal-dir test seam, a probe-only DB open
 * (`openJournalDbIfPresent` never creates the file), and no positional
 * arguments beyond the flags below.
 *
 * What this command does NOT claim: a clean report means the stored chain
 * is internally consistent, not that the database was never touched by
 * whatever process wrote it -- see `chain-verify.ts`'s module doc for the
 * exact limits (tail deletion, same-uid rewrite). The wording below is
 * deliberately literal about what was checked rather than reaching for a
 * stronger-sounding label.
 */

/** Minimal writable-stream shape this command needs, so tests can inject capture objects. */
export interface VerifyCliWritable {
  write(chunk: string): unknown
}

export interface VerifyCliIo {
  readonly stdout: VerifyCliWritable
  readonly stderr: VerifyCliWritable
}

/** Test seam: journal directory override. */
export interface VerifyCommandOptions {
  readonly journalDir?: string
}

/**
 * Exit codes, documented here because an auditor scripts against them:
 * - 0: the command ran and found no break (includes the "nothing to verify
 *   yet" cases: an empty journal, or a journal that is entirely pre-chain).
 * - 1: the command could not answer the question as asked -- a bad
 *   argument, no database at all, or (with `--session`) no records for the
 *   named session. Not a finding about the chain, a failure to run.
 * - 2: the walk found a break -- a record's own hash disagreed with its
 *   content, or a record's recorded predecessor disagreed with what
 *   actually precedes it.
 */
const EXIT_OK = 0
const EXIT_USAGE_ERROR = 1
const EXIT_CHAIN_BROKEN = 2

const USAGE =
  'Usage: mcp-journal verify [--session <id>]\n' +
  'Recomputes the record hash chain (seq order) and reports where it stays\n' +
  'consistent with what is stored, and where it does not.\n' +
  'Exit codes: 0 = no break found (including an empty or fully pre-chain\n' +
  'journal), 1 = could not run (bad argument, missing database, unknown\n' +
  'session), 2 = a break was found.\n'

export async function runVerifyCommand(
  args: readonly string[],
  io: VerifyCliIo,
  opts: VerifyCommandOptions = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { session: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 0) {
    io.stderr.write(`verify takes no positional arguments (got: ${positionals.join(' ')})\n\n${USAGE}`)
    return EXIT_USAGE_ERROR
  }
  const sessionId = values.session
  if (sessionId !== undefined && !isValidSessionId(sessionId)) {
    io.stderr.write(
      `Invalid --session "${sessionId}": expected 1-128 characters matching [A-Za-z0-9_-]\n\n${USAGE}`,
    )
    return EXIT_USAGE_ERROR
  }

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  // Probe-only: a read command must never bring a database into existence
  // (see `openJournalDbIfPresent`'s own doc) -- verifying is not a reason to
  // create the thing being verified.
  const handle = await openJournalDbIfPresent(journalDir)
  if (handle === null) {
    io.stderr.write(
      `No journal database found under "${journalDir}"; nothing has been journaled there yet.\n`,
    )
    return EXIT_USAGE_ERROR
  }

  const result = verifyChain(handle)
  io.stdout.write(summaryLines(result))

  if (sessionId !== undefined) {
    const span = sessionChainSpan(handle, sessionId)
    if (span === null) {
      io.stderr.write(`No records found for session "${sessionId}".\n`)
      return EXIT_USAGE_ERROR
    }
    io.stdout.write(sessionLines(span, result))
  }

  return result.break === null ? EXIT_OK : EXIT_CHAIN_BROKEN
}

function summaryLines(result: ChainVerifyResult): string {
  if (result.totalRowCount === 0) {
    return 'Journal is empty; nothing to verify.\n'
  }

  const lines: string[] = []
  if (result.unattestedCount > 0) {
    lines.push(
      `${result.unattestedCount} record(s) predate the hash chain and are not attested ` +
        '(written before this feature existed) -- not verified, but not a finding either: ' +
        'there is simply no chain to check them against.\n',
    )
  }
  if (result.attestedCount === 0 && result.break === null) {
    lines.push('No chained records to verify beyond that.\n')
    return lines.join('')
  }

  lines.push(
    result.intactThroughSeq === null
      ? 'Chain intact through: none (the break is at the first attested record).\n'
      : `Chain intact through seq ${result.intactThroughSeq} (${result.attestedCount} record(s) checked).\n`,
  )
  if (result.break !== null) {
    lines.push(`BROKEN at seq ${result.break.seq}: ${breakDescription(result.break.reason)}\n`)
  }
  return lines.join('')
}

function breakDescription(reason: ChainBreakReason): string {
  return reason === 'modified'
    ? "this record's content does not match its recorded hash -- it was changed after being written."
    : "this record's recorded predecessor hash does not match the record actually before it -- " +
        'a record was deleted, inserted, or reordered.'
}

/**
 * The `--session` addendum: where this session's own rows sit relative to
 * the unattested prefix and the break (if any). Deliberately does not claim
 * more than the chain can prove -- see the module doc's tail-deletion
 * caveat, which this text cannot rule out either.
 */
function sessionLines(span: SessionChainSpan, result: ChainVerifyResult): string {
  const lines = [
    `Session "${span.sessionId}": ${span.rowCount} record(s), seq ${span.firstSeq}..${span.lastSeq}.\n`,
  ]

  const unattestedThrough = result.unattestedThroughSeq
  const spansUnattestedPrefix = unattestedThrough !== null && span.firstSeq <= unattestedThrough
  if (spansUnattestedPrefix) {
    lines.push(
      span.lastSeq <= (unattestedThrough as number)
        ? "All of this session's records predate the hash chain; none are attested.\n"
        : "Some of this session's earliest records predate the hash chain and are not attested; " +
            'only the rest are covered by the check below.\n',
    )
  }

  if (result.break !== null && result.break.seq <= span.lastSeq) {
    lines.push(
      `WARNING: the chain break at seq ${result.break.seq} falls within or before this session's ` +
        "range -- one or more of this session's records may be missing or altered.\n",
    )
  } else if (!spansUnattestedPrefix || span.lastSeq > (unattestedThrough as number)) {
    lines.push("This session's attested records are fully covered by the verified chain.\n")
  }

  return lines.join('')
}
