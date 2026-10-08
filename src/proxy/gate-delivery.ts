import { WITHDRAW_REASON_DISCONNECTED } from '../policy/approvals/withdraw.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import type { SynthesizableId } from './synthesize.js'
import { answerNotKeptError, toolUseInFlightError } from './synthesize-resend.js'
import type { CallIdentity, ToolUseAnswers, ToolUseClaim } from './tool-use-answers.js'
import {
  DROP,
  decisionInfoOf,
  idKeyOf,
  isPromiseVerdict,
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
 *    it is refused (`tool-use-in-flight`). Decided after `decide()`, so a
 *    rule that now denies still wins; a call without a `toolUseId` is never a
 *    resend (owner, 2026-10-09).
 *  - **Forwarded calls are tracked** until the server answers. The agent may
 *    leave meanwhile — a cancel, an abandoned HTTP request, the session ending
 *    — and its answer is then journaled `undelivered`, with why the agent left
 *    and whether the answer was kept for a resend. The answer itself takes its
 *    usual path: the gate never holds it back.
 *  - **Teardown** (`agentLeft`, then `settle`): what the server has not
 *    answered within the grace is journaled `unanswered`. A call the agent
 *    cancelled is not counted: a server need not answer a cancelled request.
 */

/** A resend answered with the first result. */
export const TOOL_USE_RESEND_RULE = 'tool-use-resend'
/** A resend refused while the first call of its tool use is still held or running. */
export const TOOL_USE_IN_FLIGHT_RULE = 'tool-use-in-flight'
/** An undelivered answer, kept for a resend of its tool use. */
export const ANSWER_KEPT_RULE = 'answer-kept'
/** An undelivered answer over the size limit: a resend is told so instead. */
export const ANSWER_TOO_LARGE_RULE = 'answer-too-large-to-keep'
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
}

export type Admission =
  | { readonly kind: 'answered'; readonly verdict: Promise<Verdict> }
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
  /** Waits up to `graceMs` for the answers still owed, journals the rest; resolves to how many were journaled. */
  settle(graceMs: number, reason: string): Promise<number>
}

interface ForwardedCall {
  readonly call: ParsedToolCall
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

function toolUseExtra(call: ParsedToolCall): Pick<DecisionExtras, 'toolUseId'> {
  return call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}
}

export function createGateDelivery(deps: GateDeliveryDeps): GateDelivery {
  const { scope, answers, clock, writeDecision, settleJournal, answerLocally } = deps
  const forwarded = new Map<string, ForwardedCall>()
  let isLeaving = false
  let onOwedSettled: (() => void) | null = null

  /** Answers still owed: a call the agent cancelled is owed nothing. */
  function owedCount(): number {
    let owed = 0
    for (const entry of forwarded.values()) if (entry.departure?.kind !== 'cancel') owed += 1
    return owed
  }

  function forget(idKey: string, entry: ForwardedCall): void {
    forwarded.delete(idKey)
    entry.claim?.release()
    if (onOwedSettled !== null && owedCount() === 0) onOwedSettled()
  }

  async function replay(call: ParsedToolCall, facts: CallFacts, response: Record<string, unknown>): Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'replayed', TOOL_USE_RESEND_RULE, toolUseExtra(call)), call.args)
    await settleJournal()
    await answerLocally(call.id, (id) => Buffer.from(`${JSON.stringify({ ...response, id })}\n`, 'utf8'))
    return DROP
  }

  async function refuseInFlight(call: ParsedToolCall, facts: CallFacts): Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'deny', TOOL_USE_IN_FLIGHT_RULE, toolUseExtra(call)), call.args)
    await settleJournal()
    await answerLocally(call.id, (id) => toolUseInFlightError(id, { toolName: facts.toolName }))
    return DROP
  }

  function admit(call: ParsedToolCall, facts: CallFacts): Admission {
    if (call.id === null || call.toolUseId === undefined) return GO_UNCLAIMED
    const kept = answers.find(scope, call.toolUseId, identityOf(facts))
    const response = kept === null ? null : parseKeptResponse(kept.response)
    if (response !== null) return { kind: 'answered', verdict: replay(call, facts, response) }
    const claim = answers.claim(scope, call.toolUseId)
    if (claim === null) return { kind: 'answered', verdict: refuseInFlight(call, facts) }
    return { kind: 'go', claim }
  }

  function register(call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict): void {
    if (verdict.action !== 'forward' || call.id === null || isLeaving) {
      claim?.release()
      return
    }
    const idKey = idKeyOf(call.id)
    // A reused id: the earlier call's answer can no longer be told apart.
    const previous = forwarded.get(idKey)
    if (previous !== undefined) forget(idKey, previous)
    if (forwarded.size >= MAX_TRACKED_FORWARDED_CALLS) {
      const [oldestKey, oldest] = forwarded.entries().next().value as [string, ForwardedCall]
      forget(oldestKey, oldest)
    }
    const departure = deps.departureOf(idKey)
    forwarded.set(idKey, Object.freeze({ call, facts, claim, forwardedAtMs: clock(), ...(departure !== undefined ? { departure } : {}) }))
  }

  function track(
    call: ParsedToolCall, facts: CallFacts, claim: ToolUseClaim | null, verdict: Verdict | Promise<Verdict>,
  ): Verdict | Promise<Verdict> {
    if (!isPromiseVerdict(verdict)) {
      register(call, facts, claim, verdict)
      return verdict
    }
    return verdict.then(
      (settled) => {
        register(call, facts, claim, settled)
        return settled
      },
      (error: unknown) => {
        claim?.release()
        throw error
      },
    )
  }

  /** Keeps the answer for a resend when the call carried a tool-use id; says what became of it. */
  function keepAnswer(entry: ForwardedCall, raw: string): KeepResult {
    const toolUseId = entry.call.toolUseId
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
      ...toolUseExtra(entry.call),
    }
    writeDecision(decisionInfoOf(entry.facts, 'undelivered', kept, extras), entry.call.args)
  }

  function departed(idKey: string, departure: Departure): void {
    const entry = forwarded.get(idKey)
    if (entry === undefined || entry.departure !== undefined) return
    forwarded.set(idKey, Object.freeze({ ...entry, departure }))
  }

  function agentLeft(): void {
    isLeaving = true
    for (const idKey of [...forwarded.keys()]) {
      departed(idKey, { reason: WITHDRAW_REASON_DISCONNECTED, kind: 'abandon' })
    }
  }

  function waitOwed(graceMs: number): Promise<void> {
    if (graceMs <= 0 || owedCount() === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, graceMs)
      function done(): void {
        clearTimeout(timer)
        onOwedSettled = null
        resolve()
      }
      onOwedSettled = done
    })
  }

  async function settle(graceMs: number, reason: string): Promise<number> {
    await waitOwed(graceMs)
    let unanswered = 0
    for (const [idKey, entry] of [...forwarded]) {
      forget(idKey, entry)
      if (entry.departure?.kind === 'cancel') continue
      unanswered += 1
      const extras: DecisionExtras = {
        reason: entry.departure?.reason ?? reason,
        latencyMs: clock() - entry.forwardedAtMs,
        ...toolUseExtra(entry.call),
      }
      writeDecision(decisionInfoOf(entry.facts, 'unanswered', SESSION_ENDED_RULE, extras), entry.call.args)
    }
    return unanswered
  }

  return { admit, track, departed, observeAnswer, agentLeft, settle }
}
