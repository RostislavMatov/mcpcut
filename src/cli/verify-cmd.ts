import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import {
  sessionChainSpan,
  verifyChain,
  type ChainBreak,
  type ChainVerifyResult,
  type SessionChainSpan,
} from '../journal/chain-verify.js'
import { openJournalDbIfPresent } from '../journal/db.js'
import { isValidSessionId } from '../journal/session-id.js'
import { attemptSignChainHead } from './verify-sign.js'

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
 *   argument, no database at all, an unknown `--session`, or (with `--sign`)
 *   no key or nothing to sign -- AND the chain walk itself found no break.
 *   Not a finding about the chain, a failure to run.
 * - 2: the walk found a break -- a record's own hash disagreed with its
 *   content, or a record's recorded predecessor disagreed with what
 *   actually precedes it. This WINS over 1 whenever both apply: an
 *   unresolvable `--session` or a failed `--sign` are both "could not do the
 *   EXTRA thing also asked for", never a reason to hide that the walk
 *   (which already ran and already printed its result) found real tampering.
 *   An auditor's script treats 2 as "alert" and 1 as "low priority, retry
 *   later" -- letting an ordinary pre-`keygen` host or a typo'd session id
 *   downgrade a real break to 1 would mean the alert never fires. See the
 *   `--sign` block below for where this is enforced.
 */
const EXIT_OK = 0
const EXIT_USAGE_ERROR = 1
const EXIT_CHAIN_BROKEN = 2

const USAGE =
  'Usage: mcp-journal verify [--session <id>] [--sign]\n' +
  'Recomputes the record hash chain (seq order) and reports where it stays\n' +
  'consistent with what is stored, and where it does not.\n' +
  '--sign additionally signs the current chain HEAD (not every record) with\n' +
  'this installation\'s Ed25519 key ("mcp-journal keygen"); see its own output\n' +
  'for what that anchor does and does not prove.\n' +
  'Exit codes: 0 = no break found (including an empty or fully pre-chain\n' +
  'journal), 1 = could not run (bad argument, missing database, unknown\n' +
  'session, or -- with --sign -- no key or nothing to sign) and no break was\n' +
  'found either; 2 = a break was found (wins over 1 whenever both apply).\n'

export async function runVerifyCommand(
  args: readonly string[],
  io: VerifyCliIo,
  opts: VerifyCommandOptions = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { session: { type: 'string' }, sign: { type: 'boolean', default: false } },
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
      // The walk above already ran and already printed its own result: an
      // unresolvable session name is "could not do the EXTRA thing asked
      // for", not a reason to hide a break the walk already found. See the
      // exit-code doc above.
      return result.break === null ? EXIT_USAGE_ERROR : EXIT_CHAIN_BROKEN
    }
    io.stdout.write(sessionLines(span, result))
  }

  if (values.sign === true) {
    // A sign-specific failure (no key, nothing attested yet to sign) is "the
    // command could not do the EXTRA thing also asked for" -- it must be
    // reported (stderr, below) but must NEVER downgrade a break the walk
    // already found and already printed: "no signing key yet" is an
    // ordinary state on a fresh install before `keygen` has run, and an
    // auditor's script escalates only on exit 2. A SUCCESSFUL sign falls
    // through to the same break-based exit code: the anchor is appended to
    // stdout either way (including when a break was also found), never
    // silently swapped in for a break report.
    const signOutcome = await attemptSignChainHead(handle, journalDir, result)
    if (!signOutcome.ok) {
      io.stderr.write(signOutcome.message)
      if (result.break !== null) return EXIT_CHAIN_BROKEN
      return EXIT_USAGE_ERROR
    }
    io.stdout.write(signOutcome.message)
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
    lines.push(`BROKEN at seq ${result.break.seq}: ${breakDescription(result.break)}\n`)
  }
  return lines.join('')
}

/**
 * `'modified'` and `'gap'` are labels for which stored-column check failed,
 * not a claim that the underlying tamper action is identifiable from that
 * label alone -- see `chain-verify.ts`'s module doc. A `'gap'` in
 * particular has TWO indistinguishable real-world causes (a genuine
 * deletion/insertion/reorder, or a careful edit of the PRECEDING record that
 * also recomputed that record's own hash to match), so its wording says
 * both rather than naming only the first -- naming only one would be a
 * false claim of precision the stored columns cannot back up. `'modified'`
 * has no such ambiguity: it names a row whose `doc` was changed WITHOUT
 * also recomputing its own hash, which is exactly what it says.
 */
function breakDescription(chainBreak: ChainBreak): string {
  if (chainBreak.reason === 'modified') {
    return "this record's content does not match its recorded hash -- it was changed after being written."
  }
  const precedingSeq = chainBreak.seq - 1
  return (
    "this record's recorded predecessor hash does not match the record actually before it. " +
    'Two things produce this, indistinguishable from what is stored: a record was deleted, ' +
    `inserted, or reordered near this point, OR the record immediately before it (seq ${precedingSeq}) ` +
    'was edited and had its own hash recomputed from its own stored predecessor to match -- a careful ' +
    `tamper that leaves seq ${precedingSeq} looking intact and only surfaces here. Inspect both seq ` +
    `${chainBreak.seq} and seq ${precedingSeq}.`
  )
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
