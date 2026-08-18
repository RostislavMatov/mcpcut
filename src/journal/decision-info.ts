/**
 * The decision-record vocabulary: what a `kind: 'decision'` journal record
 * says about one gated tool call, and the provenance stamped on it.
 *
 * Split out of `record.ts` (which owns the traffic-record builder) because
 * M5 grows this side of the contract — provenance now, chain and signature
 * next — while the builder itself does not. Every existing importer keeps
 * working: `record.ts` re-exports all of it.
 */

/** Final disposition of one policy decision on a gated tool call. */
export type PolicyOutcome =
  | 'allow'
  | 'deny'
  | 'require-approval-pending'
  | 'approved'
  | 'denied-by-operator'
  | 'timeout'
  | 'quarantined'

/** Risk class a tool was resolved to at decision time. */
export type ToolClass = 'read' | 'write' | 'destructive'

/** Quarantine status of a tool's schema at decision time. */
export type QuarantineState = 'known' | 'new' | 'changed' | 'unknown'

/**
 * Everything a `decision`-kind record needs to explain why a tool call was
 * allowed, denied, quarantined or sent to approval. Carried on
 * `JournalRecord.decision`; the call's arguments (if any) go through
 * `redact()` like any other payload and land in `JournalRecord.payload`
 * instead, so this shape only ever holds short, structured fields.
 */
export interface DecisionInfo {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly quarantineState: QuarantineState
  readonly argsHash: string
  readonly approvalId?: string
  /**
   * Which agent identity asked (serve sessions; absent for `wrap`/`connect`
   * runs without one). Was already written by `gate-approvals.ts` via spread —
   * declared here so the field is part of the record's contract, not a leak
   * past it (M4 Wave 1).
   */
  readonly agentName?: string
  readonly latencyMs?: number
  /**
   * WHO determined this outcome, when a human did: the `actor` of the
   * approval resolution the outcome came from (`ui:<adminName>`, `cli`, …).
   * Present on exactly the records a person decided — `approved`,
   * `denied-by-operator`, and the `allow` of a retry admitted by a LATE
   * approval — and ABSENT everywhere else, following the same "absent, not
   * null" convention as `agentName`/`grantsHash`.
   *
   * Absence is therefore a FACT, not missing data: a `timeout` is the absence
   * of a decision, an `expired` resolution is one session teardown or the
   * sweep made rather than an operator, and a policy `allow`/`deny` had no
   * human in the loop at all. Stamping an actor on any of those would put a
   * false statement into the evidence waves 3-4 chain and sign, so the field
   * is populated only where an `ApprovalResolution` actually carried one
   * (M5 wave 2).
   */
  readonly actor?: string
  /**
   * Fingerprint of the *effective* policy this call was decided under
   * (`policy/provenance.ts`). Required: every decision record carries it, so
   * an auditor can tell which ruleset produced the outcome instead of having
   * to assume it was whatever `policy.json` says today. Stamped at the one
   * choke point every record passes through (`createDecisionWriter`), which
   * is what makes "required" true by construction rather than by review.
   */
  readonly policyHash: string
  /**
   * Fingerprint of the authenticated agent's grant matrix as of the moment
   * this record was written. ABSENT — not null, not undefined — for sessions
   * with no agent (the `wrap` path), the same "absent means there was no
   * agent" convention `agentName` above follows.
   */
  readonly grantsHash?: string
}

/**
 * A decision's fields as the gate assembles them, *before* provenance is
 * stamped on. This shape exists only in flight: everything that reaches the
 * journal is a full `DecisionInfo`. Keeping it a distinct type is what lets
 * the ~20 places that assemble a decision stay ignorant of provenance while
 * the writer still guarantees no record escapes without it.
 */
export type DecisionInfoDraft = Omit<DecisionInfo, 'policyHash' | 'grantsHash'>

/**
 * A decision as READ BACK from storage, which is a strictly weaker claim than
 * `DecisionInfo`.
 *
 * `policyHash` is required on the write side and true by construction there.
 * It is NOT true of data: every record written before M5 predates the field,
 * and the journal's line validator (`line-source.ts`) deliberately keeps
 * accepting those lines — an auditor's first request is the old archive, and
 * rejecting it would destroy more evidence than it protects. Typing the read
 * side as `DecisionInfo` would therefore hand every consumer a `string` that
 * is `undefined` at runtime, which is exactly how a literal `"undefined"`
 * ends up folded into a hash chain (wave 3) or a `TypeError` ends up thrown
 * mid-export (wave 5) — with nothing for the compiler to catch.
 *
 * So the read path says what it can actually promise, and absence becomes an
 * obligation the type system enforces on the waves that chain and sign these
 * records: a record with no `policyHash` is *unprovenanced*, and must be
 * reported as such rather than silently presented as provenanced.
 *
 * Only provenance is weakened here. `actor` (M5 wave 2) needs no weakening
 * and gets none: it is optional on the WRITE side too — most outcomes have
 * no human behind them — so the read type inherited from `DecisionInfo`
 * already says exactly what a reader can promise, and every consumer is
 * already forced to handle its absence. Re-declaring it would only create a
 * second place to keep in sync.
 *
 * The fields `isDecisionShape` does
 * validate stay required; the ones it does not (`serverName`, `toolClass`,
 * `quarantineState`, `argsHash`) are a pre-existing gap, unchanged by M5 and
 * deliberately not widened here — that would be a separate correction with
 * its own blast radius.
 */
export type PersistedDecisionInfo = Omit<DecisionInfo, 'policyHash'> & {
  /** Absent on every pre-M5 record; present on everything wave 1 onward wrote. */
  readonly policyHash?: string
}
