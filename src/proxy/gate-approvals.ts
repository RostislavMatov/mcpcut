import type { ApprovalQueue } from '../policy/approvals/queue.js'
import type { ApprovalWaiter, WaitResult } from '../policy/approvals/waiter.js'
import { checkRecentApproval, type GrantKey, type GrantRegistry } from '../policy/approvals/grants.js'
import type { PolicyDecision } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import { approvalDeniedError, approvalTimeoutError, type SynthesizableId } from './synthesize.js'
import {
  ALREADY_ANSWERED_RULE,
  DROP,
  FORWARD,
  actorExtra,
  decisionInfoOf,
  idKeyOf,
  type AnswerGuard,
  type CallFacts,
  type DecisionExtras,
  type DecisionProvenance,
  type DecisionWriter,
  type ProvenanceSnapshot,
} from './gate-helpers.js'

/**
 * The require-approval branch of the session policy gate: enqueue a pending
 * approval, wait it out, and translate the operator's answer (or the lack of
 * one) into a verdict. Split out of `gate.ts` by responsibility; the
 * exactly-one-outcome invariant documented there is enforced here through the
 * shared `answerGuard`/`answerLocally` collaborators.
 */

/** The subset of `ApprovalQueue` the gate needs (also satisfies the waiter's `ResolutionSource`). */
export type GateApprovalQueue = Pick<ApprovalQueue, 'enqueue' | 'readResolution' | 'markExpired'>

/** Context carried through one require-approval flow. */
interface ApprovalContext {
  readonly call: ParsedToolCall
  readonly facts: CallFacts
  readonly grantKey: GrantKey
  readonly rule: string
  readonly approvalId: string
  readonly startedAtMs: number
  /** How the wait settled, and who settled it when a human did (M5 wave 2). */
  readonly result: WaitResult
  /**
   * The provenance pair as of the instant this call was DECIDED, captured
   * before the enqueue and carried to whichever record ends the flow. The
   * gate waits out an operator for up to `approval.timeoutMs` while
   * `agent-watch` re-polls the grant matrix every few seconds, so re-reading
   * the live fingerprint here would let the terminal record — the one an
   * auditor treats as authoritative — name a matrix that never authorized
   * the call, and in the approve-then-narrow direction erase the evidence
   * that a broad one did.
   */
  readonly captured: ProvenanceSnapshot
}

export interface ApprovalFlowDeps {
  readonly policy: Policy
  readonly serverName: string
  readonly sessionId: string
  /** Name of the authenticated agent (M3 scope); absent on the ad-hoc `wrap` path. */
  readonly agentName?: string
  /**
   * The SAME provenance every other decision record of this session is
   * stamped with — one object per session (`session/core.ts` builds it and
   * hands it to the gate; the stdio `wrap` path lets `gate-core.ts` build its
   * own). Nothing is re-hashed here: ONE `snapshot()` is taken before the
   * enqueue and that frozen pair is used for the pending file, the
   * `require-approval-pending`
   * decision record and every record that ends the flow — which is what
   * makes the three name the same rules, rather than three separate reads of
   * a cell that changes under them (M5).
   */
  readonly provenance: DecisionProvenance
  readonly approvalQueue: GateApprovalQueue
  readonly approvalWaiter: ApprovalWaiter
  readonly grantRegistry: GrantRegistry
  /** Root of the approvals queue on disk, for the late-approval fallback. */
  readonly approvalsBaseDir: string
  readonly clock: () => number
  readonly writeDecision: DecisionWriter
  /** Resolves once decision records are durable — but only when fail-closed. */
  readonly settleJournal: () => Promise<void>
  /** Answers `id` locally and marks it as answered (see `gate.ts`); a `null` id is dropped. */
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  /** The shared exactly-one-outcome guard owned by `gate.ts`. */
  readonly answerGuard: AnswerGuard
  /** Approval ids enqueued to disk that no operator has resolved yet (H6 teardown); owned by `gate.ts`. */
  readonly enqueuedUnresolved: Set<string>
  /** Runs `decide()` with the gate's own input assembly (see `decideInputOf` in `gate.ts`). */
  readonly decideWithGrant: (facts: CallFacts, hasActiveGrant: boolean) => PolicyDecision
  /**
   * The gate's allow path: journal + (fail-closed) flush, preserving ordering.
   * `extras` rides onto the decision record — the late-approval path uses it
   * to name the approval and the operator that authorized the retry (M5 wave
   * 2); every other caller omits it and records a plain policy allow.
   */
  readonly applyAllow: (
    call: ParsedToolCall,
    facts: CallFacts,
    decision: PolicyDecision,
    extras?: DecisionExtras,
  ) => Verdict | Promise<Verdict>
}

export interface ApprovalFlow {
  /** Runs one require-approval decision to its verdict. */
  requestApproval(
    call: ParsedToolCall,
    facts: CallFacts,
    grantKey: GrantKey,
    decision: PolicyDecision,
  ): Promise<Verdict>
}

export function createApprovalFlow(deps: ApprovalFlowDeps): ApprovalFlow {
  const { policy, serverName, approvalQueue, approvalWaiter, grantRegistry, clock } = deps
  const { writeDecision, settleJournal, answerLocally, answerGuard, enqueuedUnresolved } = deps

  /**
   * Enqueues a human approval and returns a verdict promise the pipeline
   * keeps flowing behind: later frames are read, gated and written while
   * this one waits (head-of-line blocking is deliberately rejected).
   */
  async function requestApproval(
    call: ParsedToolCall,
    facts: CallFacts,
    grantKey: GrantKey,
    decision: PolicyDecision,
  ): Promise<Verdict> {
    const lateGrant = await resolveLateApproval(call, facts, grantKey)
    if (lateGrant !== null) return lateGrant

    const startedAtMs = clock()
    // The pending file's expiry must cover the GRANT window, not the short
    // wait: the agent's call unblocks after `approval.timeoutMs`, but an
    // operator may still approve-for-retry within `approval.grantTtlMs`
    // (>> timeoutMs). A time-aware `resolve()` downgrades an approval landing
    // past `expiresAt` to `expired`, so `expiresAt` is derived from the grant
    // window here; the short wait timeout is applied separately below.
    // `waitTimeoutMs` persists the wait window too (as `waitExpiresAt`), so
    // an operator UI can tell "approve delivers the call now" from "approve
    // only grants a retry"; `agentName`/`decisionRule` answer "who is asking
    // and which rule sent them here" (M4). `policyHash`/`grantsHash` pin the
    // rules the request was made UNDER, so the operator's answer minutes
    // later resolves against a known revision (M5).
    //
    // Captured BEFORE the enqueue and reused for every artefact below: the
    // enqueue is an awaited SQLite write, so a second read after it is a
    // different instant, not the same one.
    const captured = deps.provenance.snapshot()
    const { approvalId } = await approvalQueue.enqueue({
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      args: call.args,
      sessionId: deps.sessionId,
      timeoutMs: policy.approval.grantTtlMs,
      waitTimeoutMs: policy.approval.timeoutMs,
      decisionRule: decision.rule,
      policyHash: captured.policyHash,
      ...(captured.grantsHash !== undefined ? { grantsHash: captured.grantsHash } : {}),
      ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
    })
    enqueuedUnresolved.add(approvalId)
    writeDecision(
      decisionInfoOf(facts, 'require-approval-pending', decision.rule, {
        approvalId,
        ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
      }),
      call.args,
      captured,
    )
    await settleJournal()

    // Mark this id as having an in-flight approval wait, so if it is answered
    // locally in the meantime (its own timeout, or a concurrent reuse) the
    // exactly-one-outcome burn survives even a 10k-id LRU flood (M8).
    const waitKey = call.id !== null ? idKeyOf(call.id) : null
    if (waitKey !== null) answerGuard.beginWait(waitKey)
    try {
      const result = await approvalWaiter.wait(approvalQueue, approvalId, policy.approval.timeoutMs)
      const ctx: ApprovalContext = {
        call,
        facts,
        grantKey,
        rule: decision.rule,
        approvalId,
        startedAtMs,
        result,
        captured,
      }
      return await finishApproval(ctx)
    } finally {
      if (waitKey !== null) answerGuard.endWait(waitKey)
    }
  }

  /**
   * Disk fallback for an operator who approved an identical call after its
   * wait already timed out: the retry passes on that approval instead of
   * prompting a second time. Only consulted on the require-approval path —
   * an allowed call never pays for this I/O.
   *
   * The record written here names the approval and the operator behind it.
   * Without them the journal showed a destructive call simply succeeding
   * under `rule: 'grant'`, with the human approval that authorized it
   * recorded nowhere on the one record an auditor reads for that retry (M5
   * wave 2).
   */
  async function resolveLateApproval(call: ParsedToolCall, facts: CallFacts, grantKey: GrantKey): Promise<Verdict | null> {
    const granted = await checkRecentApproval(deps.approvalsBaseDir, {
      ...grantKey,
      ttlMs: policy.approval.grantTtlMs,
      clock,
    })
    // Explicitly against `null`: the "no grant" answer is one value, never a
    // falsy-but-present object, so a grant can never be lost to truthiness.
    if (granted === null) return null
    grantRegistry.grant(grantKey, policy.approval.grantTtlMs)
    const decision = deps.decideWithGrant(facts, true)
    if (decision.outcome !== 'allow') return null
    const extras: DecisionExtras = { approvalId: granted.approvalId, ...actorExtra(granted.actor) }
    return await deps.applyAllow(call, facts, decision, extras)
  }

  async function finishApproval(ctx: ApprovalContext): Promise<Verdict> {
    const extras: DecisionExtras = { approvalId: ctx.approvalId, latencyMs: clock() - ctx.startedAtMs }
    if (ctx.result.outcome === 'approved') return await finishApproved(ctx, extras)

    const isDenied = ctx.result.outcome === 'denied'
    // An operator denial resolves the approval; a plain timeout does not (a
    // late approval may still land), so only the former stops it from being
    // marked expired at session teardown (H6).
    if (isDenied) enqueuedUnresolved.delete(ctx.approvalId)
    const toolName = ctx.facts.toolName
    // A denial is an operator's decision and names them; a timeout is the
    // ABSENCE of a decision, so it names nobody — the waiter surfaces no
    // actor for it and none is invented here.
    writeDecision(
      decisionInfoOf(
        ctx.facts,
        isDenied ? 'denied-by-operator' : 'timeout',
        ctx.rule,
        isDenied ? { ...extras, ...actorExtra(ctx.result.actor) } : extras,
      ),
      ctx.call.args,
      ctx.captured,
    )
    await settleJournal()
    await answerLocally(ctx.call.id, (id) =>
      isDenied
        ? approvalDeniedError(id, { toolName })
        : approvalTimeoutError(id, { toolName, approvalId: ctx.approvalId }),
    )
    return DROP
  }

  /**
   * The guard is a flag, not a hope: an approval racing an already-delivered
   * timeout error must never reach the server after it.
   */
  async function finishApproved(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    enqueuedUnresolved.delete(ctx.approvalId)
    if (ctx.call.id !== null && answerGuard.isAnswered(idKeyOf(ctx.call.id))) {
      writeDecision(
        decisionInfoOf(ctx.facts, 'deny', ALREADY_ANSWERED_RULE, extras),
        ctx.call.args,
        ctx.captured,
      )
      await settleJournal()
      return DROP
    }
    grantRegistry.grant(ctx.grantKey, policy.approval.grantTtlMs)
    writeDecision(
      decisionInfoOf(ctx.facts, 'approved', ctx.rule, { ...extras, ...actorExtra(ctx.result.actor) }),
      ctx.call.args,
      ctx.captured,
    )
    await settleJournal()
    return FORWARD
  }

  return { requestApproval }
}
