import { isChainRecomputable, type ReportManifest } from './report.js'
import type { RecordStreamTally } from './report-verify-stream.js'
import type { Verdict } from './report-verify.js'

/**
 * The two verdicts about the manifest's NUMBERS (M5 wave-5 review, findings
 * V3 and V4; amendment A2):
 *
 * - `consistencyVerdict` checks the manifest against ITSELF -- sums,
 *   orderings and the one field that is a pure function of four others.
 * - `recomputedClaimsVerdict` checks it against the exported BYTES.
 *
 * WHY THIS EXISTS AT ALL. A signature proves only that the AUDITED PARTY
 * authored the numbers. The single class of claim an auditor can establish
 * independently -- arithmetic over the bytes they were handed -- was being
 * left unestablished: a signed report claiming `byOutcome: {allow: 3200}`
 * over records holding 400 denials passed every check. And `chain
 * .recomputable`, a pure function of `scope.session`,
 * `chain.unattestedCount`, `chain.break` and `chain.head`
 * (`isChainRecomputable`), was taken on the manifest's word, which made it an
 * attacker-settable off switch for the chain re-fold: delete a record,
 * recompute the digest, the line count and the counts, flip the flag to
 * `false`, drop `startPrevHash`, remove `signature.json` -- and the result
 * printed RESULT: PASSED, exit 0.
 *
 * FAILED, never "malformed input": these files parsed and every field is
 * well-typed, and they still say two contradictory things. That is a finding
 * about the report, not an inability to read it.
 */

/** Every manifest-internal contradiction, in one check. */
export function consistencyVerdict(manifest: ReportManifest): Verdict {
  const problems = [
    lineCountAgreement(manifest),
    chainVerdictAgreement(manifest),
    recomputableAgreement(manifest),
    outcomeSumAgreement(manifest),
    countOrdering(manifest),
    seqRangeAgreement(manifest),
    sessionListAgreement(manifest),
  ].filter((problem): problem is string => problem !== null)

  if (problems.length > 0) return { status: 'failed', detail: problems.join(' ') }
  return {
    status: 'passed',
    detail:
      'the manifest agrees with itself: row counts, outcome totals, the seq range, the chain head and ' +
      'the recomputed chain.recomputable predicate are all mutually consistent.',
  }
}

function lineCountAgreement({ records, counts }: ReportManifest): string | null {
  if (records.lineCount === counts.records) return null
  return `records.lineCount (${records.lineCount}) disagrees with counts.records (${counts.records}) -- the manifest counts its own rows two different ways.`
}

function chainVerdictAgreement({ chain }: ReportManifest): string | null {
  if (chain.verifiedAtExport === (chain.break === null)) return null
  return (
    `chain.verifiedAtExport (${chain.verifiedAtExport}) disagrees with chain.break ` +
    `(${chain.break === null ? 'null' : `seq ${chain.break.seq}`}).`
  )
}

/**
 * The flag recomputed from the four fields it is defined over (review
 * finding V3), using the PRODUCER's own predicate so the two sides cannot
 * drift on what "recomputable" means. The tell the old code computed and
 * threw away: when a lying `false` was recomputed, `notRecomputableReason`
 * found no condition to name -- which was itself proof the flag was lying.
 */
function recomputableAgreement(manifest: ReportManifest): string | null {
  const { chain, scope } = manifest
  const expected = isChainRecomputable(scope.session, chain.unattestedCount, chain.break, chain.head !== null)
  if (expected === chain.recomputable) return null
  return (
    `chain.recomputable claims ${chain.recomputable}, but the manifest's own fields say ${expected} ` +
    `(scope.session=${scope.session === null ? 'null' : `"${scope.session}"`}, ` +
    `chain.unattestedCount=${chain.unattestedCount}, chain.break=${chain.break === null ? 'null' : `seq ${chain.break.seq}`}, ` +
    `chain.head=${chain.head === null ? 'null' : `seq ${chain.head.seq}`}). ` +
    'A false flag here switches the chain re-fold off, so it is checked rather than believed.'
  )
}

function outcomeSumAgreement({ counts }: ReportManifest): string | null {
  const total = Object.values(counts.byOutcome).reduce((sum, count) => sum + count, 0)
  if (total === counts.decisions) return null
  return `counts.byOutcome sums to ${total}, but counts.decisions is ${counts.decisions}.`
}

function countOrdering({ counts }: ReportManifest): string | null {
  const problems: string[] = []
  if (counts.decisions > counts.records) {
    problems.push(`counts.decisions (${counts.decisions}) exceeds counts.records (${counts.records}); a decision IS a record.`)
  }
  if (counts.unprovenanced > counts.decisions) {
    problems.push(`counts.unprovenanced (${counts.unprovenanced}) exceeds counts.decisions (${counts.decisions}); only a decision can be unprovenanced.`)
  }
  return problems.length === 0 ? null : problems.join(' ')
}

/**
 * The `seq` span has to be at least as wide as the number of rows it
 * covers -- `seq` is unique per record, so N records cannot fit in fewer
 * than N sequence numbers. (Wider is normal and says nothing: a
 * session-scoped export, or a pruned journal, legitimately skips numbers.)
 */
function seqRangeAgreement({ seqRange, counts, chain, scope }: ReportManifest): string | null {
  if (seqRange === null) {
    return counts.records === 0
      ? null
      : `seqRange is null while counts.records is ${counts.records}; an export with rows covers a seq range.`
  }
  const problems: string[] = []
  const span = seqRange.lastSeq - seqRange.firstSeq + 1
  if (seqRange.firstSeq > seqRange.lastSeq) {
    problems.push(`seqRange runs backwards (firstSeq ${seqRange.firstSeq} > lastSeq ${seqRange.lastSeq}).`)
  } else if (span < counts.records) {
    problems.push(`seqRange spans ${span} sequence number(s) but the export claims ${counts.records} record(s); seq is unique per record.`)
  }
  // Only for a whole-journal export. `chain.head` is the JOURNAL's head, not
  // the export's, so a session-scoped export whose last row precedes some
  // other session's rows legitimately names a head past its own range --
  // failing that would turn a normal narrow export into a false finding.
  if (scope.session === null && chain.head !== null && chain.head.seq > seqRange.lastSeq) {
    problems.push(`chain.head is at seq ${chain.head.seq}, past the exported seqRange.lastSeq (${seqRange.lastSeq}), in a whole-journal export.`)
  }
  return problems.length === 0 ? null : problems.join(' ')
}

function sessionListAgreement({ sessionIds, records }: ReportManifest): string | null {
  if (sessionIds.length > 0 === records.lineCount > 0) return null
  return records.lineCount > 0
    ? `sessionIds is empty while records.lineCount is ${records.lineCount}; every exported row belongs to a session.`
    : `sessionIds names ${sessionIds.length} session(s) while records.lineCount is 0.`
}

/**
 * The manifest checked against the exported bytes (amendment A2). Note what
 * is deliberately NOT here: `seqRange` is not derivable from `doc` bytes at
 * all -- the exported lines carry no `seq` -- and the detail SAYS so rather
 * than letting a clean result imply it was checked.
 */
export function recomputedClaimsVerdict(manifest: ReportManifest, tally: RecordStreamTally): Verdict {
  if (tally.overlongLineBytes !== null) {
    return {
      status: 'could-not-run',
      detail:
        'records.jsonl could not be split into records (see the line-count check), so nothing the manifest ' +
        'counts could be re-derived from it.',
    }
  }

  const problems = [
    numberMismatch('counts.records', manifest.counts.records, tally.lineCount),
    numberMismatch('counts.decisions', manifest.counts.decisions, tally.decisions),
    numberMismatch('counts.unparsableRows', manifest.counts.unparsableRows, tally.unparsableRows),
    numberMismatch('counts.unprovenanced', manifest.counts.unprovenanced, tally.unprovenanced),
    outcomeMismatch(manifest, tally),
    sessionMismatch(manifest, tally),
  ].filter((problem): problem is string => problem !== null)

  if (problems.length > 0) return { status: 'failed', detail: `${problems.join(' ')} ${SEQ_RANGE_NOTE}` }
  return {
    status: 'passed',
    detail:
      `re-derived from the exported bytes: ${tally.lineCount} record(s), ${tally.decisions} decision(s), ` +
      `${tally.unparsableRows} unparsable row(s), ${tally.unprovenanced} without policyHash, outcomes ` +
      `${renderOutcomes(tally.byOutcome)}, session(s) ${renderList([...tally.sessionIds].sort())} -- all ` +
      `matching the manifest. ${SEQ_RANGE_NOTE}`,
  }
}

const SEQ_RANGE_NOTE =
  'NOT re-derived: seqRange, which no exported record carries -- the manifest states it and this check ' +
  'neither confirms nor contradicts it.'

function numberMismatch(field: string, claimed: number, found: number): string | null {
  if (claimed === found) return null
  return `${field} claims ${claimed}, but the exported records hold ${found}.`
}

function outcomeMismatch(manifest: ReportManifest, tally: RecordStreamTally): string | null {
  const claimed = manifest.counts.byOutcome
  const outcomes = [...new Set([...Object.keys(claimed), ...tally.byOutcome.keys()])].sort()
  const differences = outcomes
    .filter((outcome) => (claimed[outcome] ?? 0) !== (tally.byOutcome.get(outcome) ?? 0))
    .map((outcome) => `"${outcome}" claims ${claimed[outcome] ?? 0} but the records hold ${tally.byOutcome.get(outcome) ?? 0}`)
  return differences.length === 0 ? null : `counts.byOutcome disagrees with the exported records: ${differences.join('; ')}.`
}

/**
 * Sessions, asymmetrically -- and deliberately so. A session that appears in
 * an exported record but NOT in `sessionIds` is the dangerous direction: the
 * manifest is hiding whose traffic is in the file, and that is always a
 * finding. The reverse is normal: `sessionIds` is read from the `session_id`
 * COLUMN, so a row whose `doc` does not parse still contributes a session
 * name that no parsed record can show. That is only a finding when the
 * manifest itself claims there are no unparsable rows.
 */
function sessionMismatch(manifest: ReportManifest, tally: RecordStreamTally): string | null {
  const claimed = new Set(manifest.sessionIds)
  const hidden = [...tally.sessionIds].filter((id) => !claimed.has(id)).sort()
  const unseen = manifest.sessionIds.filter((id) => !tally.sessionIds.has(id)).sort()
  const problems: string[] = []
  if (hidden.length > 0) {
    problems.push(`the exported records carry session(s) ${renderList(hidden)} that sessionIds does not name.`)
  }
  if (unseen.length > 0 && manifest.counts.unparsableRows === 0) {
    problems.push(
      `sessionIds names session(s) ${renderList(unseen)} that no exported record belongs to, and the ` +
        'manifest claims no unparsable rows that could account for them.',
    )
  }
  return problems.length === 0 ? null : problems.join(' ')
}

function renderOutcomes(byOutcome: ReadonlyMap<string, number>): string {
  const entries = [...byOutcome.keys()].sort().map((outcome) => `${outcome}=${byOutcome.get(outcome) ?? 0}`)
  return entries.length === 0 ? '(none)' : entries.join(', ')
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.map((value) => `"${value}"`).join(', ')
}
