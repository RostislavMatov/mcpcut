import type { ApprovalQueue } from '../policy/approvals/queue.js'
import type { ApprovalWaiter, WaitResult } from '../policy/approvals/waiter.js'
import { WITHDRAW_REASON_DISCONNECTED } from '../policy/approvals/withdraw.js'
import { APPROVAL_REQUEST_MAX_AGE_MS } from '../policy/constants.js'
import type { PolicyDecision } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import { approvalDeniedError, approvalTimeoutError, type SynthesizableId } from './synthesize.js'
import { startHold, type HoldScheduler } from './approval-hold.js'
import type { PendingApprovalNotice } from './gate-types.js'
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
  type DecisionWriter,
  type ProvenanceSnapshot,
} from './gate-helpers.js'

/**
 * The require-approval branch of the session policy gate: enqueue a pending
 * approval, hold the call while its agent waits, and translate the
 * operator's answer — or the agent leaving — into a verdict. Split out of
 * `gate.ts` by responsibility; the exactly-one-outcome invariant documented
 * there is enforced here through the shared `answerGuard`/`answerLocally`
 * collaborators.
 *
 * Decision M36: an approval covers the one call it was given for (there is no
 * grant window, a repeat asks again); the call is held with no mcpcut-side
 * limit unless the policy caps it (`approval.timeoutMs`); and an agent that
 * leaves — a `notifications/cancelled` for the held id, or the connection
 * ending — WITHDRAWS the request: the queue records why, the journal writes
 * `agent-gone`, the call is never forwarded and its id is never answered. The
 * withdrawal and an operator's approve race through the queue's one
 * conditional write, so exactly one of them wins.
 */

/** The subset of `ApprovalQueue` the gate needs (also satisfies the waiter's `ResolutionSource`). */
export type GateApprovalQueue = Pick<
  ApprovalQueue,
  'enqueue' | 'readResolution' | 'markExpired' | 'withdraw' | 'heartbeat'
>

/** One call held for approval, while its wait runs. */
interface HeldCall {
  /** The call's id as the router keys it; `null` never reaches here (id-less calls are denied). */
  readonly idKey: string
  readonly approvalId: string
  /** Aborted once the request is withdrawn: settles the wait at once. */
  readonly controller: AbortController
  /** Set when the agent left (its cancel's reason, or `disconnected`); a mutable flag like `gate-confirm.ts`'s. */
  leftReason: string | undefined
}

/** Context carried through one require-approval flow to the record that ends it. */
interface ApprovalContext {
  readonly call: ParsedToolCall
  readonly facts: CallFacts
  readonly rule: string
  readonly held: HeldCall
  readonly startedAtMs: number
  /** How the wait settled, and who settled it when a human did (M5 wave 2). */
  readonly result: WaitResult
  /** Rides every record the flow writes: the confirmation in the client that came first (ADR-0019). */
  readonly base: DecisionExtras
  /**
   * The provenance pair as of the instant this call was DECIDED, captured
   * before the enqueue and carried to whichever record ends the flow: the
   * gate holds the call while `agent-watch` re-polls the grant matrix, so
   * re-reading the live fingerprint here would let the terminal record name a
   * matrix that never authorized the call.
   */
  readonly captured: ProvenanceSnapshot
}

export interface ApprovalFlowDeps {
  readonly policy: Policy
  readonly serverName: string
  readonly sessionId: string
  /** Name of the authenticated agent (M3 scope); absent on the ad-hoc `wrap` path. */
  readonly agentName?: string
  readonly approvalQueue: GateApprovalQueue
  readonly approvalWaiter: ApprovalWaiter
  readonly clock: () => number
  readonly writeDecision: DecisionWriter
  /** Resolves once decision records are durable — but only when fail-closed. */
  readonly settleJournal: () => Promise<void>
  /** Answers `id` locally and marks it as answered (see `gate.ts`); a `null` id is dropped. */
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  /** Writes a gate-authored notification to the client (the same path `answerLocally` uses). */
  readonly notifyClient: (bytes: Buffer) => Promise<void>
  /** The progress text for a held call; absent on paths that cannot carry notifications (HTTP). */
  readonly heldCallProgress?: (approvalId: string) => string
  readonly holdScheduler: HoldScheduler
  /** The reason of a cancel that arrived for `idKey` before its call was queued, if any. */
  readonly cancelReasonOf: (idKey: string) => string | undefined
  /** The shared exactly-one-outcome guard owned by `gate.ts`. */
  readonly answerGuard: AnswerGuard
  /** Reports a failing announcement, heartbeat or withdrawal; the call's own flow goes on. */
  readonly onError: (error: unknown) => void
  /** Hears of each call queued for a human, once, before its wait starts. */
  readonly onApprovalPending?: (notice: PendingApprovalNotice) => void
}

export interface ApprovalFlow {
  /**
   * Runs one require-approval decision to its verdict. `captured` is the
   * provenance pair as of the instant `decide()` produced `decision`, taken by
   * the caller in that same synchronous run (M5 wave-2 review): this flow
   * awaits storage before it writes anything, so any snapshot it took itself
   * would be a later instant than the decision it describes.
   */
  requestApproval(
    call: ParsedToolCall,
    facts: CallFacts,
    decision: PolicyDecision,
    captured: ProvenanceSnapshot,
    /** Extras every record of the flow carries (`confirmedBy`, ADR-0019). */
    base?: DecisionExtras,
  ): Promise<Verdict>
  /** The client cancelled request `idKey`: a call held under it is withdrawn with `reason` (already cleaned). */
  withdrawByClient(idKey: string, reason: string): Promise<void>
  /** Session end: every held call is withdrawn as `disconnected`, and so is any call queued after this. */
  withdrawAll(): Promise<void>
}

export function createApprovalFlow(deps: ApprovalFlowDeps): ApprovalFlow {
  const { policy, serverName, approvalQueue, approvalWaiter, clock } = deps
  const { writeDecision, settleJournal, answerLocally, answerGuard } = deps
  const waitCapMs = policy.approval.timeoutMs
  const held = new Set<HeldCall>()
  let isClosed = false

  /** An announcement is a courtesy to the operator: its failure never decides the call. */
  function announcePending(notice: PendingApprovalNotice): void {
    try {
      deps.onApprovalPending?.(notice)
    } catch (error: unknown) {
      deps.onError(error)
    }
  }

  /**
   * The agent left: withdraw its request. If an operator resolved it first,
   * their decision stands and the wait settles on it — except at session
   * end, where nothing could be delivered any more, so the wait is ended
   * either way (a request the withdrawal did not reach is left to the
   * heartbeat sweep).
   */
  async function leave(entry: HeldCall, reason: string): Promise<void> {
    if (entry.leftReason !== undefined) return
    entry.leftReason = reason
    try {
      const result = await approvalQueue.withdraw(entry.approvalId, reason)
      if (result.ok) entry.controller.abort()
    } catch (error: unknown) {
      deps.onError(error)
    }
    if (isClosed) entry.controller.abort()
  }

  /** Enqueues the request and journals it as pending; the call is not held yet. */
  async function enqueue(
    call: ParsedToolCall,
    facts: CallFacts,
    decision: PolicyDecision,
    captured: ProvenanceSnapshot,
    base: DecisionExtras,
  ): Promise<string> {
    // `expiresAt` is the 24-hour hard cap (M36); the policy's cap, when it
    // sets one, is the agent's own wait and rides as `waitExpiresAt`.
    // `captured` was taken by the CALLER at decision time and is reused for
    // every artefact of the flow — never re-sampled after an await.
    const { approvalId } = await approvalQueue.enqueue({
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      args: call.args,
      sessionId: deps.sessionId,
      timeoutMs: APPROVAL_REQUEST_MAX_AGE_MS,
      ...(waitCapMs !== undefined ? { waitTimeoutMs: waitCapMs } : {}),
      decisionRule: decision.rule,
      policyHash: captured.policyHash,
      ...(captured.grantsHash !== undefined ? { grantsHash: captured.grantsHash } : {}),
      ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
    })
    const agent = deps.agentName !== undefined ? { agentName: deps.agentName } : {}
    writeDecision(
      decisionInfoOf(facts, 'require-approval-pending', decision.rule, { ...base, approvalId, ...agent }),
      call.args,
      captured,
    )
    await settleJournal()
    announcePending({
      approvalId,
      toolName: facts.toolName,
      serverName,
      ...(waitCapMs !== undefined ? { waitMs: waitCapMs } : {}),
    })
    return approvalId
  }

  /** Holds the call: heartbeat and progress run beside the wait, and stop with it. */
  async function hold(call: ParsedToolCall, entry: HeldCall): Promise<WaitResult> {
    const ticker = startHold({
      approvalId: entry.approvalId,
      ...(call.progressToken !== undefined ? { progressToken: call.progressToken } : {}),
      ...(deps.heldCallProgress !== undefined ? { messageOf: deps.heldCallProgress } : {}),
      send: deps.notifyClient,
      heartbeat: () => approvalQueue.heartbeat(entry.approvalId),
      scheduler: deps.holdScheduler,
      onError: deps.onError,
    })
    // Mark this id as having an in-flight wait, so if it is answered locally
    // in the meantime the exactly-one-outcome burn survives even a 10k-id LRU
    // flood (M8).
    answerGuard.beginWait(entry.idKey)
    try {
      return await approvalWaiter.wait(approvalQueue, entry.approvalId, waitCapMs, entry.controller.signal)
    } finally {
      ticker.stop()
      answerGuard.endWait(entry.idKey)
      held.delete(entry)
    }
  }

  async function requestApproval(
    call: ParsedToolCall,
    facts: CallFacts,
    decision: PolicyDecision,
    captured: ProvenanceSnapshot,
    base: DecisionExtras = {},
  ): Promise<Verdict> {
    const startedAtMs = clock()
    const approvalId = await enqueue(call, facts, decision, captured, base)
    // An id-less call never reaches here (`gate-call.ts` denies it first).
    const idKey = call.id !== null ? idKeyOf(call.id) : ''
    const entry: HeldCall = { idKey, approvalId, controller: new AbortController(), leftReason: undefined }
    held.add(entry)
    // The agent may already have left while the request was being queued.
    const earlyReason = isClosed ? WITHDRAW_REASON_DISCONNECTED : deps.cancelReasonOf(idKey)
    if (earlyReason !== undefined) void leave(entry, earlyReason)
    const result = await hold(call, entry)
    return finishApproval({ call, facts, rule: decision.rule, held: entry, startedAtMs, result, captured, base })
  }

  async function finishApproval(ctx: ApprovalContext): Promise<Verdict> {
    const extras: DecisionExtras = {
      ...ctx.base,
      approvalId: ctx.held.approvalId,
      latencyMs: clock() - ctx.startedAtMs,
    }
    const { outcome } = ctx.result
    if (outcome === 'approved') return finishApproved(ctx, extras)
    if (outcome === 'withdrawn' && ctx.held.leftReason !== undefined) {
      return finishAgentGone(ctx, { ...extras, reason: ctx.held.leftReason })
    }
    if (outcome === 'denied') return finishDenied(ctx, extras)
    // A capped wait that ran out — or a request withdrawn behind this live
    // agent's back (the heartbeat sweep of another process judged it stale):
    // either way the agent is still here and gets the timeout answer.
    return finishTimedOut(ctx, extras)
  }

  /** The agent left: nothing is sent, nothing is answered, and the id can never be forwarded. */
  async function finishAgentGone(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    writeDecision(decisionInfoOf(ctx.facts, 'agent-gone', ctx.rule, extras), ctx.call.args, ctx.captured)
    await settleJournal()
    answerGuard.markAnswered(ctx.held.idKey)
    return DROP
  }

  /** An operator's denial names them. */
  async function finishDenied(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    const record = { ...extras, ...actorExtra(ctx.result.actor) }
    writeDecision(decisionInfoOf(ctx.facts, 'denied-by-operator', ctx.rule, record), ctx.call.args, ctx.captured)
    await settleJournal()
    const toolName = ctx.facts.toolName
    await answerLocally(ctx.call.id, (id) => approvalDeniedError(id, { toolName }))
    return DROP
  }

  /**
   * A timeout is the ABSENCE of a decision, so it names nobody. The request
   * leaves the queue with the answer: there is no grant window any more, so an
   * approval of it could only ever reach nobody.
   */
  async function finishTimedOut(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    const { approvalId } = ctx.held
    try {
      await approvalQueue.markExpired(approvalId)
    } catch (error: unknown) {
      deps.onError(error)
    }
    writeDecision(decisionInfoOf(ctx.facts, 'timeout', ctx.rule, extras), ctx.call.args, ctx.captured)
    await settleJournal()
    const toolName = ctx.facts.toolName
    await answerLocally(ctx.call.id, (id) => approvalTimeoutError(id, { toolName, approvalId }))
    return DROP
  }

  /**
   * The guard is a flag, not a hope: an approval racing an already-delivered
   * answer must never reach the server after it.
   */
  async function finishApproved(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    if (answerGuard.isAnswered(ctx.held.idKey)) {
      writeDecision(decisionInfoOf(ctx.facts, 'deny', ALREADY_ANSWERED_RULE, extras), ctx.call.args, ctx.captured)
      await settleJournal()
      return DROP
    }
    const record = { ...extras, ...actorExtra(ctx.result.actor) }
    writeDecision(decisionInfoOf(ctx.facts, 'approved', ctx.rule, record), ctx.call.args, ctx.captured)
    await settleJournal()
    return FORWARD
  }

  return {
    requestApproval,
    async withdrawByClient(idKey, reason) {
      const matching = Array.from(held).filter((entry) => entry.idKey === idKey)
      await Promise.all(matching.map((entry) => leave(entry, reason)))
    },
    async withdrawAll() {
      isClosed = true
      await Promise.all(Array.from(held).map((entry) => leave(entry, WITHDRAW_REASON_DISCONNECTED)))
    },
  }
}
