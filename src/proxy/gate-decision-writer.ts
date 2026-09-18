import { buildDecisionRecord } from '../journal/decision.js'
import type { DecisionInfo, DecisionInfoDraft } from '../journal/record.js'
import { policyHashOf } from '../policy/provenance.js'
import { toPolicyProvider, type PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { GateSink } from './gate-helpers.js'

/**
 * The single choke point every decision record passes through, and therefore
 * the enforcement point for provenance (M5). Split out of `gate-helpers.ts`
 * as one cohesive unit — writer, the provenance it stamps, and the factory
 * that builds that provenance — and re-exported from there, so importers see
 * one module.
 */

/**
 * The provenance pair as of one instant: the rules a call was DECIDED under.
 * Frozen, so it cannot drift while a deferred call waits for an operator.
 *
 * `agentName` rides along: it is not a fingerprint and does not move during a
 * session, but it is evidence of the same kind -- WHO the rules were applied
 * to -- and it has to reach every record for the same reason `policyHash`
 * does. Before the 2026-09-18 user-journey smoke it was stamped only where a
 * pending approval was assembled, so an agent's allowed and denied calls named
 * nobody.
 */
export interface ProvenanceSnapshot {
  readonly policyHash: string
  readonly grantsHash?: string
  readonly agentName?: string
}

/**
 * The provenance every decision record written through this session is
 * stamped with.
 *
 * Deliberately ONE method and no readable fields. Neither half is fixed for
 * the process: the grants fingerprint moves when `agent-watch.ts` rebuilds
 * the agent's scope on a poll, and the policy hash moves when `policy.json`
 * is reloaded (wave 2 of the policy-tool-rules-ui plan) — so the pair only
 * ever means anything as of some instant. Exposing the two separately is what
 * let a caller read them at two different instants and pin the wrong matrix
 * onto a record; `snapshot()` is the only way to obtain them, so that mistake
 * is no longer expressible.
 */
export interface DecisionProvenance {
  /**
   * The pair as of NOW. Callers that decide a call and write about it LATER
   * (the require-approval flow, which waits out an operator) take one
   * snapshot at decision time and carry it through every record about that
   * call, so no record can name a matrix that never authorized it.
   */
  snapshot(): ProvenanceSnapshot
}

/**
 * The provenance-relevant slice of a `GateAgentScope`. Structural on purpose:
 * this module never imports the agents layer, and a test double satisfies it
 * with one function.
 */
export interface GrantsFingerprintSource {
  readonly grantsHash: () => string
  /**
   * Journal-facing identity of the agent the scope belongs to. Optional only
   * so a double that is about fingerprints alone stays one function; the
   * production scope (`GateAgentScope`) always carries it.
   */
  readonly agentName?: string
}

/**
 * Builds the ONE provenance object a session decides under. Called once per
 * session (`session/core.ts`) and handed to both the gate and the session's
 * own decision writer, so a session can never hash the same policy twice from
 * two independently-passed references and disagree with itself.
 *
 * The policy hash is the fingerprint of the policy IN FORCE at the instant of
 * the snapshot — `provider.current()` — which is what makes a record written
 * after a hot reload name the rules it was actually decided under. It is
 * cached on the identity of that object: a reload swaps in a new object and
 * the next snapshot re-hashes once; between reloads no CPU is spent, exactly
 * as when the policy was hashed once per process. A plain `Policy` is wrapped
 * in a static provider, so its hash is computed once and never again.
 */
export function createDecisionProvenance(
  policy: Policy | PolicyProvider,
  agentScope?: GrantsFingerprintSource,
): DecisionProvenance {
  const provider = toPolicyProvider(policy)
  let hashedPolicy: Policy | null = null
  let policyHash = ''

  function currentPolicyHash(): string {
    const current = provider.current()
    if (current !== hashedPolicy) {
      hashedPolicy = current
      policyHash = policyHashOf(current)
    }
    return policyHash
  }

  return Object.freeze({
    snapshot: (): ProvenanceSnapshot =>
      Object.freeze({
        policyHash: currentPolicyHash(),
        ...(agentScope !== undefined ? { grantsHash: agentScope.grantsHash() } : {}),
        ...(agentScope?.agentName !== undefined ? { agentName: agentScope.agentName } : {}),
      }),
  })
}

/**
 * Writes one redacted decision record. Fire-and-forget, like every sink write.
 *
 * `captured` is the provenance pair as of DECISION time, supplied by callers
 * whose record is written after an await (the approval flow). Omitting it
 * means "snapshot now", which is correct for every record written
 * synchronously with the decision it describes.
 */
export type DecisionWriter = (
  decision: DecisionInfoDraft,
  args?: unknown,
  captured?: ProvenanceSnapshot,
) => void

export interface DecisionWriterDeps {
  readonly sink: GateSink
  readonly sessionId: string
  readonly clock: () => number
  readonly provenance: DecisionProvenance
}

/**
 * Stamps the captured provenance onto a draft, producing a NEW object; the
 * caller's draft is never mutated.
 *
 * Both provenance fields are taken from `captured` and ONLY from `captured`.
 * `DecisionInfoDraft` has no `grantsHash` in its type, but a plain spread
 * would still let a runtime-carried one survive when the snapshot has none —
 * so the key is dropped explicitly first. That is what makes `grantsHash` as
 * unforgeable by a draft as `policyHash` already is.
 *
 * `agentName` gets the same treatment, for the same reason: it is dropped
 * from the draft and taken from `captured` alone, so a record names an agent
 * iff the session's scope does. The pending-approval draft still carries one
 * (the same name, from the same scope); that it agrees is a convention across
 * two files, and evidence should not rest on a convention.
 */
function stampProvenance(draft: DecisionInfoDraft, captured: ProvenanceSnapshot): DecisionInfo {
  const { grantsHash: _draftGrantsHash, agentName: _draftAgentName, ...unstamped } = draft as DecisionInfoDraft & {
    readonly grantsHash?: unknown
  }
  return {
    ...unstamped,
    policyHash: captured.policyHash,
    ...(captured.grantsHash !== undefined ? { grantsHash: captured.grantsHash } : {}),
    ...(captured.agentName !== undefined ? { agentName: captured.agentName } : {}),
  }
}

/**
 * The writer every decision record goes through: no decision record can
 * escape without `policyHash`, by construction. Provenance is stamped here
 * rather than threaded through the ~20 places a decision is assembled
 * (`decisionInfoOf`, `bookkeepingDecisionInfo`, `unsafeClientFrameDecision`,
 * the fail-closed `denyOnGateError`, the method router's own builders, the
 * session core's revocation literal) — threading would leave the invariant
 * to reviewer memory, so a decision path added later could silently ship
 * unprovenanced records.
 */
export function createDecisionWriter(deps: DecisionWriterDeps): DecisionWriter {
  return (draft, args, captured) => {
    deps.sink.write(
      buildDecisionRecord({
        sessionId: deps.sessionId,
        decision: stampProvenance(draft, captured ?? deps.provenance.snapshot()),
        args: args ?? null,
        clock: deps.clock,
      }),
    )
  }
}
