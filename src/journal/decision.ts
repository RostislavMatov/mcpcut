import { ulid } from 'ulid'
import { redact, redactString } from '../redact/redact.js'
import type { ClientServerDirection, DecisionInfo, JournalRecord } from './record.js'

/**
 * Builds tamper-evident journal records for one policy decision (allow /
 * deny / require-approval / ... on a gated `tools/call`). A decision record
 * is not derived from `classify()` -- it is emitted by the policy gate
 * itself -- so it gets its own, smaller builder rather than sharing
 * `createRecordBuilder`'s per-message correlation state.
 *
 * `redact()` is still the only path call arguments take before landing on
 * `payload`, matching the rest of the journal: there is no way to construct
 * a decision record with unredacted arguments.
 */

/** Direction a decision record is stamped with: the call it decided was client-initiated. */
const DECISION_DIRECTION: ClientServerDirection = 'client→server'

export interface BuildDecisionRecordInput {
  readonly sessionId: string
  readonly decision: DecisionInfo
  /** Raw tool-call arguments, if any. Redacted before storage. */
  readonly args?: unknown
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
}

/**
 * Builds a frozen, redacted `kind: 'decision'` journal record. `toolName`
 * comes from proxied traffic (a tool call or a server's tool catalog), so it
 * is attacker-influenced text and is redacted the same way `record.ts`
 * redacts a request's `method` before it reaches the journal. `rule` and
 * `serverName` come from the operator's own policy config / `--server`
 * flag, not from traffic, so they pass through unchanged.
 */
export function buildDecisionRecord(input: BuildDecisionRecordInput): JournalRecord {
  const now = input.clock ?? Date.now
  const nowMs = now()

  const decision: DecisionInfo = Object.freeze({
    ...input.decision,
    toolName: redactString(input.decision.toolName),
    // `actor` is the other externally-sourced string here: on the
    // late-approval path it is read back out of a STORED resolved record,
    // which is hand-editable text. Redacted at this choke point rather than at
    // the one call site that produces it, so every present and future producer
    // of `actor` is covered — redaction is the only path into the journal, and
    // wave 4 signs this field. Spread conditionally so an absent actor stays
    // absent instead of gaining an `actor: undefined` key.
    ...(input.decision.actor !== undefined
      ? { actor: redactString(input.decision.actor) }
      : {}),
  })

  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(nowMs).toISOString(),
    sessionId: input.sessionId,
    direction: DECISION_DIRECTION,
    kind: 'decision',
    payload: redact(input.args ?? null),
    decision,
  }
  return Object.freeze(record)
}
