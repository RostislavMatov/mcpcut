import { WITHDRAW_REASON_DISCONNECTED } from '../policy/approvals/withdraw.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import type { SynthesizableId } from './synthesize.js'
import type { HoldScheduler } from './approval-hold.js'
import { createJoinedCalls, type JoinOutcome } from './gate-delivery-join.js'
import { MAX_HELD_CALLS_PER_SESSION } from '../policy/constants.js'
import { answerNotKeptError, joinLimitError, mayHaveRunError } from './synthesize-resend.js'
import type { CallIdentity, ToolUseAnswers, ToolUseClaim } from './tool-use-answers.js'
import {
  DROP,
  decisionInfoOf,
  idKeyOf,
  isPromiseVerdict,
  type AnswerGuard,
  type CallFacts,
  type DecisionExtras,
  type DecisionWriter,
} from './gate-helpers.js'

/**
 * What happens to a call's answer once the gate let the call through
 * (decision M36, phase C). Per gate, i.e. per session; the answers themselves
 * live in the process-wide `ToolUseAnswers`.
 *
 *  - **A resend of the same tool use** (same agent, `toolUseId`, server, tool
 *    and arguments) is answered with the server's first answer under the new
 *    id, journaled `replayed`; while the first call is still held or running
 *    it joins it (`gate-delivery-join.ts`, decision M39) and is decided again
 *    once that call lets go. Decided after `decide()`, so a rule that now
 *    denies still wins; a call without a `toolUseId` is never a resend
 *    (owner, 2026-10-09).
 *  - **Forwarded calls are tracked** until the server answers. The agent may
 *    leave meanwhile — a cancel, an abandoned HTTP request, the session ending
 *    — and its answer is then journaled `undelivered`, with why the agent left
 *    and whether the answer was kept for a resend. The answer itself takes its
 *    usual path: the gate never holds it back.
 *  - **Teardown** (`agentLeft`, then `settle`): what the server has not
 *    answered within the grace is journaled `unanswered`. A call the agent
 *    cancelled is not counted: a server need not answer a cancelled request.
 *
 * A tracked call keeps only what its records need — facts, tool-use id,
 * claim, departure — never its arguments: an unanswered call must not pin its
 * payload (security review of phase C, M3); its `allow`/`approved` record
 * already carries them, linked by `argsHash`.
 */

/** A resend answered with the first result. */
export const TOOL_USE_RESEND_RULE = 'tool-use-resend'
/** An undelivered answer, kept for a resend of its tool use. */
export const ANSWER_KEPT_RULE = 'answer-kept'
/** An undelivered answer over the size limit: a resend is told so instead. */
export const ANSWER_TOO_LARGE_RULE = 'answer-too-large-to-keep'
/** A resend refused because the session already has as many resends waiting as it may hold calls. */
export const RESEND_WAIT_LIMIT_RULE = 'resend-wait-limit'
/** An undelivered answer to a call without a `toolUseId`: nothing to key it by. */
export const ANSWER_NOT_KEPT_RULE = 'answer-not-kept-no-tool-use-id'
/** A forwarded call the server had not answered when its session ended. */
export const SESSION_ENDED_RULE = 'session-ended'

/** Forwarded calls one session tracks at most; past it the oldest is forgotten. */
export const MAX_TRACKED_FORWARDED_CALLS = 10_000

/** How the agent stopped waiting: a cancel told the server, an abandonment did not. */
export type DepartureKind = 'cancel' | 'abandon'

export interface Departure {
  readonly reason: string
  readonly kind: DepartureKind
}

export interface GateDeliveryDeps {
  /** The agent's name; `''` on `wrap`, which has none. */
  readonly scope: string
  readonly answers: ToolUseAnswers
  readonly clock: () => number
  readonly writeDecision: DecisionWriter
  readonly settleJournal: () => Promise<void>
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  /** How the agent left `idKey` while its verdict was still in flight, if it did. */
  readonly departureOf: (idKey: string) => Departure | undefined
  readonly answerGuard: Pick<AnswerGuard, 'markAnswered'>
  /** Present on a path that carries the gate's own notifications: a joined resend hears progress. */
  readonly sendProgress?: (bytes: Buffer) => Promise<void>
  readonly holdScheduler: HoldScheduler
  readonly onRequestDropped?: (id: JsonRpcId) => void
  readonly onError: (error: unknown) => void
}

export type Admission =
  | { readonly kind: 'answered'; readonly verdict: Promise<Verdict> }
  /** Joined the call holding its tool use: `'released'` means decide it again (M39). */
  | { readonly kind: 'joined'; readonly settled: Promise<JoinOutcome> }
  | { readonly kind: 'go'; readonly claim: ToolUseClaim | null }

export interface GateDelivery {
  /** A resend is answered here; anything else goes on, holding its tool use's claim. */
  admit(call: ParsedToolCall, facts: CallFacts): Admission
  /** Tracks the call once its verdict forwards it; releases the claim otherwise. */
  track(call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict | Promise<Verdict>): Verdict | Promise<Verdict>
  /** The agent stopped waiting for `idKey`. */
  departed(idKey: string, departure: Departure): void
  /** A server response to `idKey` (raw JSON text). */
  observeAnswer(idKey: string, raw: string): void
  /** The agent is gone: every forwarded call left, and nothing forwarded from now on is tracked. */
  agentLeft(): void
  /**
   * Waits up to `graceMs` for the answers still owed — less, once `stop`
   * aborts (the server is gone) — then journals the rest; resolves to how many
   * were journaled. From the first call on, nothing newly forwarded is tracked.
   */
  settle(graceMs: number, reason: string, stop?: AbortSignal): Promise<number>
}

interface ForwardedCall {
  readonly toolUseId?: string
  readonly facts: CallFacts
  readonly claim: ToolUseClaim | null
  readonly forwardedAtMs: number
  readonly departure?: Departure
}

type KeepResult = typeof ANSWER_KEPT_RULE | typeof ANSWER_TOO_LARGE_RULE | typeof ANSWER_NOT_KEPT_RULE

const GO_UNCLAIMED: Admission = Object.freeze({ kind: 'go', claim: null })

function identityOf(facts: CallFacts): CallIdentity {
  return { serverName: facts.serverName, toolName: facts.toolName, argsHash: facts.argsHash }
}

/** A kept answer as an object whose `id` can be replaced; `null` if it is not one. */
function parseKeptResponse(response: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(response)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function toolUseExtra(subject: { readonly toolUseId?: string }): Pick<DecisionExtras, 'toolUseId'> {
  return subject.toolUseId !== undefined ? { toolUseId: subject.toolUseId } : {}
}

export function createGateDelivery(deps: GateDeliveryDeps): GateDelivery {
  const { scope, answers, clock, writeDecision, settleJournal, answerLocally } = deps
  const forwarded = new Map<string, ForwardedCall>()
  const joins = createJoinedCalls({
    scope,
    answers,
    writeDecision,
    answerGuard: deps.answerGuard,
    ...(deps.sendProgress !== undefined ? { sendProgress: deps.sendProgress } : {}),
    scheduler: deps.holdScheduler,
    ...(deps.onRequestDropped !== undefined ? { onRequestDropped: deps.onRequestDropped } : {}),
    onError: deps.onError,
  })
  let isLeaving = false
  /** Settles waiting for the answers still owed; more than one `settle` may wait. */
  const owedWaiters = new Set<() => void>()

  /** Answers still owed: a call the agent cancelled is owed nothing. */
  function owedCount(): number {
    let owed = 0
    for (const entry of forwarded.values()) if (entry.departure?.kind !== 'cancel') owed += 1
    return owed
  }

  function forget(idKey: string, entry: ForwardedCall): void {
    forwarded.delete(idKey)
    entry.claim?.release()
    if (owedWaiters.size > 0 && owedCount() === 0) for (const wake of [...owedWaiters]) wake()
  }

  async function replay(call: ParsedToolCall, facts: CallFacts, response: Record<string, unknown>): Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'replayed', TOOL_USE_RESEND_RULE, toolUseExtra(call)), call.args)
    await settleJournal()
    await answerLocally(call.id, (id) => Buffer.from(`${JSON.stringify({ ...response, id })}\n`, 'utf8'))
    return DROP
  }

  function admit(call: ParsedToolCall, facts: CallFacts): Admission {
    const { toolUseId } = call
    if (call.id === null || toolUseId === undefined) return GO_UNCLAIMED
    // A client reusing an id still in flight: no stored answer goes out under
    // it, or the id would be answered twice (security review S-L4).
    if (forwarded.has(idKeyOf(call.id))) return GO_UNCLAIMED
    const kept = answers.find(scope, toolUseId, identityOf(facts))
    const response = kept === null ? null : parseKeptResponse(kept.response)
    if (response !== null) return { kind: 'answered', verdict: replay(call, facts, response) }
    const claim = answers.claim(scope, toolUseId)
    if (claim !== null) return { kind: 'go', claim }
    // Once the session settles, a resend has nothing left to wait with.
    if (isLeaving) return GO_UNCLAIMED
    if (joins.count() >= MAX_HELD_CALLS_PER_SESSION) return { kind: 'answered', verdict: refuseJoin(call, facts) }
    return { kind: 'joined', settled: joins.join({ ...call, toolUseId }, facts) }
  }

  /** The session already has as many resends waiting as it may hold calls (security review L1). */
  async function refuseJoin(call: ParsedToolCall, facts: CallFacts): Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'deny', RESEND_WAIT_LIMIT_RULE, toolUseExtra(call)), call.args)
    await settleJournal()
    await answerLocally(call.id, (id) => joinLimitError(id, { toolName: facts.toolName, limit: MAX_HELD_CALLS_PER_SESSION }))
    return DROP
  }

  /**
   * A forwarded call that will have no answer — cancelled while it ran, its
   * session ending, pushed out — may still have run: a resend of its tool use
   * is told so rather than sent again or left waiting (review M1 of M39). A
   * real answer arriving later replaces it.
   */
  function keepMayHaveRun(entry: ForwardedCall, why: 'cancelled' | 'unanswered'): void {
    if (entry.toolUseId === undefined) return
    const response = mayHaveRunError(0, { toolName: entry.facts.toolName, why }).toString('utf8').trimEnd()
    answers.keep(scope, entry.toolUseId, { ...identityOf(entry.facts), response, delivered: false })
  }

  function register(call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict): void {
    if (verdict.action !== 'forward' || call.id === null || isLeaving) {
      claim?.release()
      return
    }
    const idKey = idKeyOf(call.id)
    // A reused id: the earlier call's answer can no longer be told apart (S-L4);
    // and past the cap the oldest is let go — either may still have run.
    const previous = forwarded.get(idKey)
    if (previous !== undefined) letGo(idKey, previous, 'unanswered')
    if (forwarded.size >= MAX_TRACKED_FORWARDED_CALLS) {
      const [oldestKey, oldest] = forwarded.entries().next().value as [string, ForwardedCall]
      letGo(oldestKey, oldest, 'unanswered')
    }
    const departure = deps.departureOf(idKey)
    const entry: ForwardedCall = {
      ...toolUseExtra(call),
      facts,
      claim,
      forwardedAtMs: clock(),
      ...(departure !== undefined ? { departure } : {}),
    }
    forwarded.set(idKey, Object.freeze(entry))
    if (departure?.kind === 'cancel') freeCancelled(Object.freeze(entry))
  }

  /** Forgets a call that will have no answer, leaving a resend of it the "may have run" answer. */
  function letGo(idKey: string, entry: ForwardedCall, why: 'cancelled' | 'unanswered'): void {
    keepMayHaveRun(entry, why)
    forget(idKey, entry)
  }

  /**
   * A call its agent cancelled is owed nothing: its tool use is free at once,
   * so a server that honours the cancel cannot pin it (review M4) — but a
   * resend gets "it may have run", never a second run (M39 review M1).
   */
  function freeCancelled(entry: ForwardedCall): void {
    keepMayHaveRun(entry, 'cancelled')
    entry.claim?.release()
  }

  /** Registers or releases; a fault here must not leave the tool use claimed (review L3). */
  function settleVerdict(call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict): Verdict {
    try {
      register(call, facts, claim, verdict)
    } catch (error: unknown) {
      claim?.release()
      throw error
    }
    return verdict
  }

  function track(
    call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict | Promise<Verdict>,
  ): Verdict | Promise<Verdict> {
    if (!isPromiseVerdict(verdict)) return settleVerdict(call, facts, claim, verdict)
    return verdict.then(
      (settled) => settleVerdict(call, facts, claim, settled),
      (error: unknown) => {
        claim?.release()
        throw error
      },
    )
  }

  /** Keeps the answer for a resend when the call carried a tool-use id; says what became of it. */
  function keepAnswer(entry: ForwardedCall, raw: string): KeepResult {
    const toolUseId = entry.toolUseId
    if (toolUseId === undefined) return ANSWER_NOT_KEPT_RULE
    const delivered = entry.departure === undefined
    const identity = identityOf(entry.facts)
    if (answers.keep(scope, toolUseId, { ...identity, response: raw, delivered }) === 'kept') return ANSWER_KEPT_RULE
    // Too large: a resend is told the call already ran, rather than run it again.
    const notKept = answerNotKeptError(0, {
      toolName: entry.facts.toolName,
      answeredAt: new Date(clock()).toISOString(),
      bytes: Buffer.byteLength(raw, 'utf8'),
    })
    answers.keep(scope, toolUseId, { ...identity, response: notKept.toString('utf8').trimEnd(), delivered })
    return ANSWER_TOO_LARGE_RULE
  }

  function observeAnswer(idKey: string, raw: string): void {
    const entry = forwarded.get(idKey)
    if (entry === undefined) return
    // Kept before the claim goes, so a resend never finds neither.
    const kept = keepAnswer(entry, raw)
    forget(idKey, entry)
    if (entry.departure === undefined) return
    const extras: DecisionExtras = {
      reason: entry.departure.reason,
      latencyMs: clock() - entry.forwardedAtMs,
      ...toolUseExtra(entry),
    }
    writeDecision(decisionInfoOf(entry.facts, 'undelivered', kept, extras))
  }

  function departed(idKey: string, departure: Departure): void {
    joins.leave(idKey, departure.reason)
    const entry = forwarded.get(idKey)
    if (entry === undefined || entry.departure !== undefined) return
    if (departure.kind === 'cancel') freeCancelled(entry)
    forwarded.set(idKey, Object.freeze({ ...entry, departure }))
  }

  function agentLeft(): void {
    isLeaving = true
    joins.leaveAll(WITHDRAW_REASON_DISCONNECTED)
    for (const idKey of [...forwarded.keys()]) {
      departed(idKey, { reason: WITHDRAW_REASON_DISCONNECTED, kind: 'abandon' })
    }
  }

  /** Until nothing is owed, `graceMs` ran out, or `stop` aborted — whichever comes first. */
  function waitOwed(graceMs: number, stop?: AbortSignal): Promise<void> {
    if (graceMs <= 0 || owedCount() === 0 || stop?.aborted === true) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, graceMs)
      stop?.addEventListener('abort', done, { once: true })
      function done(): void {
        clearTimeout(timer)
        stop?.removeEventListener('abort', done)
        owedWaiters.delete(done)
        resolve()
      }
      owedWaiters.add(done)
    })
  }

  async function settle(graceMs: number, reason: string, stop?: AbortSignal): Promise<number> {
    // Whatever ending this is, nothing forwarded from now on is tracked: it
    // could only ever be settled by a second `settle` (review M2).
    isLeaving = true
    joins.leaveAll(reason)
    await waitOwed(graceMs, stop)
    let unanswered = 0
    for (const [idKey, entry] of [...forwarded]) {
      const wasCancelled = entry.departure?.kind === 'cancel'
      letGo(idKey, entry, wasCancelled ? 'cancelled' : 'unanswered')
      if (wasCancelled) continue
      unanswered += 1
      const extras: DecisionExtras = {
        reason: entry.departure?.reason ?? reason,
        latencyMs: clock() - entry.forwardedAtMs,
        ...toolUseExtra(entry),
      }
      writeDecision(decisionInfoOf(entry.facts, 'unanswered', SESSION_ENDED_RULE, extras))
    }
    return unanswered
  }

  return { admit, track, departed, observeAnswer, agentLeft, settle }
}
