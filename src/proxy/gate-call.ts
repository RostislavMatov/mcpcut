import { decide, type PolicyDecision } from '../policy/decide.js'
import type { GrantKey, GrantRegistry } from '../policy/approvals/grants.js'
import type { PolicyProvider } from '../policy/provider.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { ApprovalFlow } from './gate-approvals.js'
import type { ConfirmStep } from './gate-confirm.js'
import type { createDecideInputAssembler } from './gate-decide-input.js'
import {
  ALREADY_ANSWERED_RULE,
  DROP,
  IDLESS_APPROVAL_RULE,
  decisionInfoOf,
  idKeyOf,
  type AnswerGuard,
  type CallFacts,
  type DecisionExtras,
  type DecisionProvenance,
  type DecisionWriter,
  type ProvenanceSnapshot,
} from './gate-helpers.js'
import type { Verdict } from './pipeline.js'

/**
 * How the session policy gate decides one `tools/call`: the admin's outcome
 * (`decide()`), the confirmation in the client when the policy asks for one
 * (ADR-0019), and then allow, deny or the approval queue. Split out of
 * `gate-core.ts` for the line budget when the confirmation step arrived; the
 * core still owns every piece of shared state these functions close over.
 */

type DecideInputAssembler = ReturnType<typeof createDecideInputAssembler>

export interface CallDeciderDeps {
  readonly policy: PolicyProvider
  readonly serverName: string
  readonly factsOf: DecideInputAssembler['factsOf']
  readonly decideInputOf: DecideInputAssembler['decideInputOf']
  readonly enforceCatalogTrust: DecideInputAssembler['enforceCatalogTrust']
  readonly grantRegistry: GrantRegistry
  readonly provenance: DecisionProvenance
  readonly applyAllow: (
    call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision, extras?: DecisionExtras,
  ) => Verdict | Promise<Verdict>
  readonly applyDeny: (call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision) => Promise<Verdict>
  readonly requestApproval: ApprovalFlow['requestApproval']
  readonly confirmStep: ConfirmStep
  readonly answerGuard: AnswerGuard
  readonly writeDecision: DecisionWriter
  readonly settleJournal: () => Promise<void>
}

export interface CallDecider {
  decideToolCall(call: ParsedToolCall): Verdict | Promise<Verdict>
}

/** One evaluation of a call under the rules in force at that instant. */
interface Evaluation {
  readonly facts: CallFacts
  readonly grantKey: GrantKey
  readonly decision: PolicyDecision
  readonly captured: ProvenanceSnapshot
}

export function createCallDecider(deps: CallDeciderDeps): CallDecider {
  const { policy, serverName, confirmStep } = deps

  function evaluate(call: ParsedToolCall): Evaluation {
    // Schedules a `stat` of the policy file (rate-limited); a pending edit
    // lands asynchronously, so THIS call is still decided under the policy in
    // force — `factsOf`, `decideInputOf` and `snapshot()` below all read the
    // same object because nothing in this synchronous stretch can swap it.
    policy.maybeRefresh()
    const facts = deps.factsOf(call)
    const grantKey: GrantKey = { serverName, toolName: facts.toolName, argsHash: facts.argsHash }
    const decision = deps.enforceCatalogTrust(decide(deps.decideInputOf(facts, deps.grantRegistry.isGranted(grantKey))))
    // Provenance is sampled HERE, in the same synchronous run as `decide()`,
    // because this is the instant the rules produced the verdict. Only the
    // deferred path needs it explicitly: `applyAllow`/`applyDeny` journal
    // before they await anything, so the writer's own default snapshot is
    // already this same instant, while `requestApproval` awaits a storage read
    // before it writes and would otherwise sample a matrix an `agent-watch`
    // poll had already replaced (M5 wave-2 review, finding 2).
    return { facts, grantKey, decision, captured: deps.provenance.snapshot() }
  }

  /** The admin's half: allow, deny, or the approval queue; `base` rides every record it writes. */
  function go(call: ParsedToolCall, evaluation: Evaluation, base: DecisionExtras): Verdict | Promise<Verdict> {
    const { facts, grantKey, decision, captured } = evaluation
    if (decision.outcome === 'allow') return deps.applyAllow(call, facts, decision, base)
    if (decision.outcome === 'deny') return deps.applyDeny(call, facts, decision)
    // An id-less call has no return address: an approval could never deliver
    // it, yet its grant would still be minted and consumable by a later
    // id-bearing call — pure operator-fatigue cost with zero upside, so it
    // short-circuits to deny instead of enqueuing (re-review L4).
    if (call.id === null) {
      return deps.applyDeny(call, facts, {
        outcome: 'deny',
        rule: IDLESS_APPROVAL_RULE,
        reason: 'id-less tools/call cannot receive an approval result; denying instead of enqueuing',
      })
    }
    return deps.requestApproval(call, facts, grantKey, decision, captured, base)
  }

  /**
   * ADR-0019: the person at the client first. After an Accept the call is
   * decided again — the person took seconds, and a rule turned to `deny`
   * meanwhile must win over the Accept.
   */
  async function confirmThenGo(call: ParsedToolCall, facts: CallFacts, thenAdmin: boolean): Promise<Verdict> {
    // The burn of an id answered meanwhile must outlast the dialog's own wait
    // until the check below, or a flooded LRU could forget it (security review).
    const waitKey = call.id !== null ? idKeyOf(call.id) : null
    if (waitKey !== null) deps.answerGuard.beginWait(waitKey)
    try {
      const confirmed = await confirmStep.run(call, facts, thenAdmin)
      if (confirmed.kind === 'refused') return DROP
      const base: DecisionExtras = { confirmedBy: confirmed.by }
      const evaluation = evaluate(call)
      // Exactly one outcome per id: an id answered meanwhile is never forwarded.
      if (waitKey !== null && deps.answerGuard.isAnswered(waitKey)) {
        deps.writeDecision(decisionInfoOf(evaluation.facts, 'deny', ALREADY_ANSWERED_RULE, base), call.args)
        await deps.settleJournal()
        return DROP
      }
      return await go(call, evaluation, base)
    } finally {
      if (waitKey !== null) deps.answerGuard.endWait(waitKey)
    }
  }

  return {
    decideToolCall(call) {
      const evaluation = evaluate(call)
      const { facts, decision } = evaluation
      if (decision.outcome === 'deny') return deps.applyDeny(call, facts, decision)
      if (confirmStep.isRequired(facts.toolName)) return confirmThenGo(call, facts, decision.outcome === 'require-approval')
      return go(call, evaluation, {})
    },
  }
}
