import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from '../journal/db.js'
import {
  latestPruneMarker,
  planPruneOlderThan,
  pruneRecordsOlderThan,
  type PruneMarker,
  type PrunePlan,
} from '../journal/prune.js'
import { loadSigningPrivateKey } from '../journal/signing.js'
import { USAGE } from './usage.js'

/**
 * `mcp-journal prune --older-than <duration> [--yes]` (M5 wave 6, task 6.1).
 *
 * THE DEFAULT IS TO NOT DELETE. Without `--yes` the command prints exactly
 * what it would remove and stops. Every other read command in this CLI can be
 * re-run; this one destroys evidence, and an operator who mistyped `30d` for
 * `30h` cannot get those records back from anywhere. So the dangerous half is
 * behind a second, explicit word -- not behind a prompt, which a scripted
 * invocation would never see anyway.
 *
 * NO DEFAULT RETENTION EXISTS (owner decision O6). There is no configured
 * period, no timer, and nothing calls this module on its own; `--older-than`
 * has no default value because guessing one would be this project deciding how
 * long someone else's evidence is worth keeping.
 *
 * WHAT THE OUTPUT MUST SAY. A prune leaves a marker, and a marker is the
 * operator's own claim about what was deleted -- written by the same host that
 * could equally have deleted rows and recorded nothing. The output says so,
 * every time, and says whether the marker was signed: an unsigned marker is
 * evidence of nothing beyond "this host says so".
 */

/** Minimal writable-stream shape this command needs. */
export interface PruneCliWritable {
  write(chunk: string): unknown
}

export interface PruneCliIo {
  readonly stdout: PruneCliWritable
  readonly stderr: PruneCliWritable
}

export interface PruneCommandOptions {
  readonly journalDir?: string
  /** Injectable clock, so a test's cutoff is arithmetic rather than a race with the wall clock. */
  readonly clock?: () => number
}

const EXIT_OK = 0
const EXIT_USAGE_ERROR = 1

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * A retention period no operator will ever mean: a hundred years. The bound
 * exists because the arithmetic below feeds `new Date(now - ms)`, and a
 * duration past the Date range made `toISOString()` throw a bare `RangeError`
 * -- an uncaught stack trace where a usage error belongs (M5 wave-6 security
 * review). Refusing an absurd value by name is also the same rule the rest of
 * this parser follows: coerce nothing, name what was wrong.
 */
const MAX_RETENTION_DAYS = 36_500

/**
 * `<positive integer><unit>`, unit `h` or `d`. Deliberately not a general
 * duration grammar: an operator typing a retention period reaches for hours or
 * days, and every extra accepted spelling (`1w`, `90`, `1.5d`) is another
 * chance for a typo to be silently interpreted as a period the operator did
 * not mean. Anything else is refused by name rather than coerced.
 */
export function parseRetentionDuration(raw: string): number | null {
  const match = /^(\d+)([hd])$/.exec(raw)
  if (match === null) return null
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  const durationMs = amount * (match[2] === 'h' ? MS_PER_HOUR : MS_PER_DAY)
  return durationMs > MAX_RETENTION_DAYS * MS_PER_DAY ? null : durationMs
}

export async function runPruneCommand(
  args: readonly string[],
  io: PruneCliIo,
  opts: PruneCommandOptions = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: { 'older-than': { type: 'string' }, yes: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return EXIT_USAGE_ERROR
  }
  const { values, positionals } = parsed
  if (positionals.length > 0) {
    io.stderr.write(`prune takes no positional arguments (got: ${positionals.join(' ')})\n\n${USAGE}`)
    return EXIT_USAGE_ERROR
  }

  const rawDuration = values['older-than']
  if (rawDuration === undefined) {
    io.stderr.write(`prune requires --older-than <duration>, e.g. --older-than 90d\n\n${USAGE}`)
    return EXIT_USAGE_ERROR
  }
  const durationMs = parseRetentionDuration(rawDuration)
  if (durationMs === null) {
    io.stderr.write(
      `Invalid --older-than "${rawDuration}": expected a positive whole number of hours or days, ` +
        `no longer than ${MAX_RETENTION_DAYS} days -- e.g. 36h or 90d\n\n${USAGE}`,
    )
    return EXIT_USAGE_ERROR
  }

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  // Probe-only, like `verify`: asking to delete old records is not a reason to
  // bring a journal database into existence.
  const handle = await openJournalDbIfPresent(journalDir)
  if (handle === null) {
    io.stderr.write(`No journal database found under "${journalDir}"; nothing has been journaled there yet.\n`)
    return EXIT_USAGE_ERROR
  }

  const nowMs = (opts.clock ?? Date.now)()
  const cutoffIso = new Date(nowMs - durationMs).toISOString()
  const plan = planPruneOlderThan(handle, cutoffIso)
  if (plan === null) {
    io.stdout.write(`Nothing to prune: no record is older than ${cutoffIso} (--older-than ${rawDuration}).\n`)
    return EXIT_OK
  }

  const signingKey = await loadSigningPrivateKey(journalDir)
  if (values.yes !== true) {
    io.stdout.write(dryRunReport(plan, cutoffIso, rawDuration, signingKey.present))
    return EXIT_OK
  }

  const outcome = pruneRecordsOlderThan(handle, {
    cutoffIso,
    nowIso: new Date(nowMs).toISOString(),
    signingKey,
  })
  io.stdout.write(appliedReport(outcome.deletedCount, outcome.marker, outcome.firstRemainingSeq))
  return EXIT_OK
}

function dryRunReport(plan: PrunePlan, cutoffIso: string, rawDuration: string, signed: boolean): string {
  return (
    'Retention prune -- NOTHING HAS BEEN DELETED.\n' +
    `  cutoff:        ${cutoffIso} (--older-than ${rawDuration})\n` +
    `  would delete:  ${plan.deletedCount} record(s), seq ${plan.firstSeq}..${plan.prunedThroughSeq}\n` +
    `  chain head of that prefix: ${plan.headRecordHash ?? '(none -- those records predate the chain)'}\n` +
    `  marker would be: ${signed ? 'signed with this installation\'s key' : 'UNSIGNED (no signing key; run `mcp-journal keygen` first if you want one)'}\n` +
    '\nRe-run with --yes to delete. This cannot be undone, and the deleted records exist nowhere\n' +
    'else unless you exported them first (mcp-journal export --report).\n'
  )
}

function appliedReport(deletedCount: number, marker: PruneMarker | null, firstRemainingSeq: number | null): string {
  if (marker === null) {
    // Defensive: the plan found a prefix, the transaction found none. Nothing
    // was deleted, and saying "0" is the only honest report of that.
    return 'Nothing to prune: the journal changed between planning and pruning; no record was deleted.\n'
  }
  const lines = [
    `Deleted ${deletedCount} record(s) (through seq ${marker.prunedThroughSeq}).`,
    `  chain now starts from: ${marker.headRecordHash ?? '(genesis -- the deleted records predated the chain)'}`,
    `  marker recorded at:    ${marker.prunedAt}`,
    marker.signature === undefined
      ? '  signature:             UNSIGNED -- nothing ties this marker to any key'
      : `  signature:             ed25519 by key ${marker.signature.keyFingerprint}`,
    firstRemainingSeq === null
      ? '  remaining journal:     empty (the next record chains onto the marker, not onto genesis)'
      : `  remaining journal:     starts at seq ${firstRemainingSeq}`,
  ]
  return (
    `${lines.join('\n')}\n\n` +
    'What this marker is worth: it is this host\'s own statement about what it deleted. A process\n' +
    'running as the same user could have deleted records and written no marker at all. Only an\n' +
    'anchor you recorded OUT OF BAND before the prune (mcp-journal verify --sign, or a report\'s\n' +
    'chain head) lets anyone check this claim against something this host cannot rewrite.\n'
  )
}

/** Re-exported for callers that report retention state without pruning (e.g. `verify`). */
export { latestPruneMarker }
