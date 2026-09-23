import { ABSENT_VALUE, inlineValue, markdownCell } from './report-markdown.js'
import { childBindingsOf, type ReportChildBinding, type ReportPoolTally } from './report-pools.js'
import type { ReportOutsideLinks } from './report-pool-links.js'
import { childHeadingNote, renderPoolSection } from './report-summary-pools.js'
import type { ReportManifest } from './report.js'

/**
 * `summary.md` -- the half of the audit report a human actually reads (M5
 * wave 5, task 5.1). Split out of `report.ts` for the 400-line cap, and
 * because rendering is a genuinely separate concern from deriving: the
 * manifest is the machine-checkable claim, this is the prose beside it, and
 * a v2 of the prose must not be able to disturb the digested bytes.
 *
 * EVERYTHING RENDERED HERE IS UNTRUSTED: every value read back out of the
 * journal goes through both escapes in `report-markdown.ts` (control
 * characters, then markup), which explains why neither is optional. The ONLY
 * unescaped text in this file is `AS_OF_CONTRACT`, which this codebase wrote.
 */

/**
 * How many decision rows `summary.md` renders before it stops and says how
 * many it left out.
 *
 * A cap exists because the rest of the export streams: a multi-gigabyte
 * journal is walked one row at a time and never materialized, and collecting
 * an unbounded list of decision rows to render would reintroduce exactly the
 * memory ceiling the streaming design removes. Decisions are a small
 * fraction of journal traffic, so in practice this never trips -- but "in
 * practice" is not a memory bound.
 *
 * Nothing is silently dropped: the omitted count is printed, the manifest's
 * `counts` remain authoritative over the WHOLE export, and every omitted
 * decision is still present verbatim in `records.jsonl`. `summary.md` is a
 * reading aid; `records.jsonl` plus `report.json` are the evidence.
 */
export const MAX_SUMMARY_DECISION_ROWS = 2000

/**
 * One decision as the summary renders it. A subset of
 * `PersistedDecisionInfo` plus the record's own `sessionId`/`ts`, following
 * the codebase's "absent, not null" convention: a missing `actor` means no
 * human decided this outcome, a missing `policyHash` means the row predates
 * provenance, and neither is the same as an empty string.
 */
export interface ReportDecisionRow {
  readonly sessionId: string
  readonly ts: string
  readonly outcome: string
  readonly rule: string
  readonly toolName: string
  /** The server the decision was about; absent when the record lacks it (never validated on read). */
  readonly serverName?: string
  /**
   * Absent on any row `line-source.ts` did not validate it on:
   * `isDecisionShape` checks outcome/rule/toolName ONLY, so
   * argsHash/serverName/toolClass/quarantineState can legitimately be missing
   * from a record read back from disk. Before the wave-5 review this was
   * typed as present and the renderer threw mid-write on the first such row,
   * taking the whole export down with it.
   */
  readonly argsHash?: string
  readonly actor?: string
  readonly policyHash?: string
  readonly grantsHash?: string
}

export interface ReportSummaryInput {
  readonly manifest: ReportManifest
  /** Already capped at {@link MAX_SUMMARY_DECISION_ROWS} by the builder. */
  readonly decisions: readonly ReportDecisionRow[]
  readonly omittedDecisionCount: number
  /** The pool ledger of the same pass (`report-pools.ts`). */
  readonly pools: ReportPoolTally
  /** Pool sessions that attached the exported session, from records outside it (D2). */
  readonly outside?: ReportOutsideLinks
}

/** What an absent optional field prints as, so an empty cell can never be mistaken for an empty value. */
const ABSENT_ACTOR = '(no human actor)'
const ABSENT_POLICY_HASH = '(unprovenanced)'
const ABSENT_GRANTS_HASH = '(no agent)'

/**
 * `server` sits between `rule` and `tool` (ADR-0015 phase 5, R4): a pool
 * child's decision records the bare tool name its server published, and the
 * name the agent called is `<server>__<tool>` -- both columns side by side.
 */
const TABLE_HEADER =
  '| ts | outcome | rule | server | tool | actor | policyHash | grantsHash | argsHash |\n' +
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'

/** Renders the whole of `summary.md`. */
export function renderReportSummary(input: ReportSummaryInput): string {
  return [
    ...headerSection(input.manifest),
    ...countsSection(input.manifest),
    ...renderPoolSection({
      pools: input.pools,
      manifest: input.manifest,
      ...(input.outside === undefined ? {} : { outside: input.outside }),
    }),
    ...decisionsSection(input),
    ...contractSection(input.manifest),
  ].join('\n')
}

function headerSection(manifest: ReportManifest): readonly string[] {
  const scope =
    manifest.scope.session === null
      ? 'whole journal'
      : `session ${inlineValue(manifest.scope.session)}`
  return [
    '# Journal audit report',
    '',
    `- Format version: ${manifest.formatVersion}`,
    `- As of: ${inlineValue(manifest.asOf)}`,
    `- Scope: ${scope}`,
    `- Records file: ${manifest.records.file} (${manifest.records.lineCount} line(s))`,
    `- Records sha256: ${inlineValue(manifest.records.sha256)}`,
    `- Seq range: ${seqRangeText(manifest)}`,
    `- Sessions: ${sessionsText(manifest)}`,
    '',
    // Amendment A1: report.json digests THIS file, so this file cannot
    // contain that digest. Said out loud, rather than leaving a reader to
    // wonder why re-serializing what they see does not reproduce report.json.
    'This summary shows every field of report.json except `summary.sha256` -- the digest of ' +
      'this file, which a file cannot contain about itself. Everything else below is that ' +
      'manifest in prose.',
    '',
    ...chainLines(manifest),
    '',
  ]
}

function seqRangeText(manifest: ReportManifest): string {
  const range = manifest.seqRange
  return range === null ? '(empty export)' : `${range.firstSeq}..${range.lastSeq}`
}

function sessionsText(manifest: ReportManifest): string {
  const ids = manifest.sessionIds
  return ids.length === 0 ? '(none)' : ids.map((id) => inlineValue(id)).join(', ')
}

/**
 * The chain block, stated in the terms the frozen contract requires: whether
 * the chain verified at export time, and -- separately -- whether an auditor
 * holding only this directory can re-derive the head from it. The two are
 * not the same claim, and a summary that blurred them would be the exact
 * over-reading `AS_OF_CONTRACT` exists to prevent.
 */
function chainLines(manifest: ReportManifest): readonly string[] {
  const chain = manifest.chain
  const head = chain.head
  const lines = [
    '## Chain',
    '',
    `- Verified at export: ${chain.verifiedAtExport ? 'yes, no break found' : 'NO -- a break was found'}`,
    `- Unattested (pre-chain) rows: ${chain.unattestedCount}`,
    `- Head: ${head === null ? '(none -- nothing attested)' : `seq ${head.seq}, ${inlineValue(head.recordHash)}`}`,
  ]
  if (chain.break !== null) {
    lines.push(`- Break: seq ${chain.break.seq}, ${inlineValue(chain.break.reason)}`)
  }
  // Stated even when null: "not pruned" is a fact a reader should be told,
  // not one they have to infer from the absence of a line (M5 wave 6).
  lines.push(
    chain.prunedThroughSeq === null
      ? '- Retention: no records have been pruned from this journal.'
      : `- Retention: records through seq ${chain.prunedThroughSeq} were DELETED by a retention prune ` +
        'before this export; they are not in this report and nothing here attests to what they held.',
  )
  if (chain.recomputable && chain.startPrevHash !== undefined) {
    lines.push(
      `- Offline re-fold: possible, starting from prevHash ${startPrevHashText(chain.startPrevHash)} ` +
        `and folding over every line of ${manifest.records.file}, in order.`,
    )
    return lines
  }
  lines.push(
    '- Offline re-fold: NOT possible from this export. The record digest and the signature ' +
      'still hold, but the hash chain itself cannot be re-derived from these files alone ' +
      `(${nonRecomputableReason(manifest)}).`,
  )
  return lines
}

/**
 * The genesis `prevHash` is the empty string (`chain.ts`'s
 * `GENESIS_PREV_HASH`), which would render as a blank gap an auditor could
 * only read as "a value went missing here". Named instead, so the starting
 * point is unambiguous.
 */
function startPrevHashText(startPrevHash: string): string {
  return startPrevHash === '' ? '(genesis: the empty string)' : inlineValue(startPrevHash)
}

/** Names the FIRST condition that made the chain non-recomputable, in the order `isChainRecomputable` checks them. */
function nonRecomputableReason(manifest: ReportManifest): string {
  const chain = manifest.chain
  if (manifest.scope.session !== null) return 'the export is scoped to a single session'
  if (chain.unattestedCount > 0) return 'the journal holds rows written before the chain existed'
  if (chain.break !== null) return 'the chain is broken'
  return 'the journal has no attested chain head'
}

function countsSection(manifest: ReportManifest): readonly string[] {
  const counts = manifest.counts
  const outcomes = Object.entries(counts.byOutcome)
  return [
    '## Counts',
    '',
    `- Records exported: ${counts.records}`,
    `- Decision records: ${counts.decisions}`,
    `- Rows that do not parse as a record (exported verbatim anyway): ${counts.unparsableRows}`,
    `- Decision records with no policy provenance: ${counts.unprovenanced}`,
    '- By outcome:',
    ...(outcomes.length === 0
      ? ['  - (none)']
      : outcomes.map(([outcome, count]) => `  - ${inlineValue(outcome)}: ${count}`)),
    '',
  ]
}

function decisionsSection(input: ReportSummaryInput): readonly string[] {
  if (input.decisions.length === 0) {
    return ['## Decisions', '', 'This export holds no decision records.', '']
  }
  const lines = ['## Decisions', '']
  // Bound at render time from EVERY attach in the export, not in seq order:
  // a child's decisions can be journaled before the attach that names it (R2).
  const bindings = childBindingsOf(input.pools)
  const outside = outsideBindingsOf(input)
  for (const [sessionId, rows] of groupBySession(input.decisions)) {
    const note =
      outside.length > 0 && sessionId === input.manifest.scope.session
        ? childHeadingNote(outside, { outside: true })
        : childHeadingNote(bindings.get(sessionId))
    lines.push(`### Session ${inlineValue(sessionId)}${note}`, '', TABLE_HEADER)
    for (const row of rows) {
      lines.push(decisionTableRow(row))
    }
    lines.push('')
  }
  if (input.omittedDecisionCount > 0) {
    lines.push(
      `${input.omittedDecisionCount} further decision record(s) are not listed here (this summary ` +
        `renders at most ${MAX_SUMMARY_DECISION_ROWS}). They are present in full in ` +
        `${input.manifest.records.file}, and the counts above cover all of them.`,
      '',
    )
  }
  return lines
}

/**
 * Decision rows grouped by session in ONE pass, keyed in first-appearance
 * order -- which, for a `seq`-ordered walk, is first-write order. A `Map`
 * rather than a filter per session: the cap allows thousands of rows across
 * as many sessions, and re-scanning the list once per session would be
 * quadratic in exactly the case the cap exists to bound.
 */
function groupBySession(decisions: readonly ReportDecisionRow[]): ReadonlyMap<string, ReportDecisionRow[]> {
  const grouped = new Map<string, ReportDecisionRow[]>()
  for (const decision of decisions) {
    const existing = grouped.get(decision.sessionId)
    if (existing === undefined) {
      grouped.set(decision.sessionId, [decision])
      continue
    }
    existing.push(decision)
  }
  return grouped
}

/**
 * Every cell is passed through `markdownCell` with the marker its absence
 * means. `ts`/`outcome`/`rule`/`toolName` are validated non-empty strings by
 * the time a record parses, but they are rendered through the same helper
 * anyway: this module cannot see WHICH checks ran, and a renderer that trusts
 * a field it did not validate itself is precisely what took the export down.
 */
function decisionTableRow(row: ReportDecisionRow): string {
  const cells: readonly (readonly [string | undefined, string])[] = [
    [row.ts, ABSENT_VALUE],
    [row.outcome, ABSENT_VALUE],
    [row.rule, ABSENT_VALUE],
    [row.serverName, ABSENT_VALUE],
    [row.toolName, ABSENT_VALUE],
    [row.actor, ABSENT_ACTOR],
    [row.policyHash, ABSENT_POLICY_HASH],
    [row.grantsHash, ABSENT_GRANTS_HASH],
    [row.argsHash, ABSENT_VALUE],
  ]
  return `| ${cells.map(([value, absent]) => markdownCell(value, absent)).join(' | ')} |`
}

function contractSection(manifest: ReportManifest): readonly string[] {
  return ['## What this report does and does not say', '', manifest.contract, '']
}

/** The exported session's pool claims read from outside the export (D2), as heading bindings. */
function outsideBindingsOf(input: ReportSummaryInput): readonly ReportChildBinding[] {
  return (input.outside?.links ?? []).map((link) => ({
    poolSessionId: link.poolSessionId,
    serverName: link.serverName,
    agentNames: [link.agentName],
  }))
}
