import { ulid } from 'ulid'
import type { AdminRole } from '../admin/constants.js'
import type { PolicyOutcome } from '../policy/schema.js'
import { redact } from '../redact/redact.js'
import type { ClientServerDirection, JournalRecord } from './record.js'

/**
 * The policy-edit vocabulary and builder: what a `kind: 'policy-edit'`
 * journal record says about one per-tool rule edit (plan
 * policy-tool-rules-ui §4, owner decision O5). One edit = ONE flat record
 * linking the policy fingerprint before and after to the admin who made it.
 *
 * Split out of `record.ts` the same way `probe-record.ts` was: `record.ts`
 * owns the traffic-record builder and stays the contract point (it
 * re-exports these types), this module owns the edit side.
 *
 * Attribution is separable from agent traffic BY CONSTRUCTION: the kind is
 * its own, the reserved `plane_policy` session id can never be a registry
 * server name, and none of the decision-record fields (`decision`,
 * `agentName`, outcome filters) ever appear on an edit record — an edit that
 * SETS `deny` must never be counted as a call that WAS denied.
 */

/**
 * The reserved `sessionId` policy-edit records are written under. Same
 * construction as `PROBE_SESSION_ID` (`src/probe/constants.ts`): matches
 * `SESSION_ID_PATTERN`, and the underscore makes it impossible as a registry
 * server name (`REGISTRY_SERVER_NAME_PATTERN` rejects `_`). Pinned by
 * `tests/journal/policy-edit-record.test.ts`.
 */
export const POLICY_EDIT_SESSION_ID = 'plane_policy'

/** Direction an edit record is stamped with: the plane acted, nothing was received. */
const POLICY_EDIT_DIRECTION: ClientServerDirection = 'client→server'

/** Which surface the admin used. */
export type PolicyEditVia = 'ui' | 'cli'

/** WHO made the edit: the authenticated admin, their role at the time, and the surface. */
export interface PolicyEditActor {
  readonly adminName: string
  readonly role: AdminRole
  readonly via: PolicyEditVia
}

/**
 * Everything a `policy-edit` record says, as the record's `payload` so the
 * existing search, UI journal and export surfaces render it with no special
 * casing. `rule: null` is a reset and `policyHashBefore: null` a first-ever
 * write — both are facts, so they are kept verbatim rather than omitted.
 */
export interface PolicyEditInfo {
  readonly actor: PolicyEditActor
  readonly serverName: string
  readonly toolName: string
  readonly rule: PolicyOutcome | null
  readonly policyHashBefore: string | null
  readonly policyHashAfter: string
  /** The file that was written (`<journalDir>/policy.json`). */
  readonly sourcePath: string
}

export interface BuildPolicyEditRecordInput {
  readonly edit: PolicyEditInfo
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
}

/**
 * Builds a frozen, redacted `kind: 'policy-edit'` journal record under the
 * reserved session. The whole payload goes through `redact()` — the single
 * path into the journal — even though none of the fields should carry a
 * secret: `sourcePath` and `adminName` are externally sourced strings, and
 * one choke point covers every present and future producer the same way.
 */
export function buildPolicyEditRecord(input: BuildPolicyEditRecordInput): JournalRecord {
  const now = input.clock ?? Date.now
  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(now()).toISOString(),
    sessionId: POLICY_EDIT_SESSION_ID,
    direction: POLICY_EDIT_DIRECTION,
    kind: 'policy-edit',
    payload: redact(flatInfoOf(input.edit)),
  }
  return Object.freeze(record)
}

/** The payload object, assembled field by field so nothing beyond the contract rides along. */
function flatInfoOf(edit: PolicyEditInfo): Record<string, unknown> {
  return {
    actor: { adminName: edit.actor.adminName, role: edit.actor.role, via: edit.actor.via },
    serverName: edit.serverName,
    toolName: edit.toolName,
    rule: edit.rule,
    policyHashBefore: edit.policyHashBefore,
    policyHashAfter: edit.policyHashAfter,
    sourcePath: edit.sourcePath,
  }
}
