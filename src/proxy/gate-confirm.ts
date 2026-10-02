import { replaceControlChars } from '../journal/format.js'
import { isConfirmInClient } from '../policy/confirm-in-client.js'
import type { PolicyProvider } from '../policy/provider.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { ClientConfirmer, ConfirmAnswer } from './client-confirm.js'
import { decisionInfoOf, idKeyOf, type AnswerGuard, type CallFacts, type DecisionWriter } from './gate-helpers.js'
import type { PolicyOutcome } from '../journal/decision-info.js'
import { clientConfirmError, type ClientConfirmErrorReason, type SynthesizableId } from './synthesize.js'

/**
 * The confirmation step of the session policy gate (ADR-0019): before a call
 * the policy lists in `confirmInClient` for this agent goes on — to the
 * server, or to an admin's approval — the person at the client confirms it.
 * Split out of `gate-core.ts` by responsibility, as `gate-approvals.ts` is.
 *
 * Every way a confirmation does not happen is a refusal, journaled and
 * answered here: a Decline or Esc (the person's), an Accept too fast to be
 * read twice, no answer in `approval.timeoutMs`, a client that cannot show the
 * dialog or answers it with an error, the session ending, and an id-less call
 * that could never receive the result. It never falls back to the admin's
 * queue: the confirmation and an admin's approval are two rules, and one
 * never stands in for the other.
 */

/** The rules a refused confirmation is journaled under. */
export const CLIENT_CONFIRM_RULES = {
  declined: 'client-confirm-declined',
  cancelled: 'client-confirm-cancelled',
  tooFast: 'client-confirm-too-fast',
  failed: 'client-confirm-failed',
  timeout: 'client-confirm-timeout',
  unavailable: 'client-confirm-unavailable',
  sessionEnded: 'client-confirm-session-ended',
  idless: 'client-confirm-idless',
} as const

export interface ConfirmStepDeps {
  readonly policy: PolicyProvider
  readonly serverName: string
  /** The authenticated agent; absent on the local `wrap` path, which only `"*"` covers. */
  readonly agentName?: string
  /** The channel to the client: the stdio paths have one, the HTTP paths do not. */
  readonly confirmer?: ClientConfirmer
  /** How long the person has (`approval.timeoutMs`, read once like the approval flow's). */
  readonly timeoutMs: number
  readonly writeDecision: DecisionWriter
  readonly settleJournal: () => Promise<void>
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  readonly answerGuard: AnswerGuard
  /** Lines for the operator's terminal (`wrap` stderr); never for the agent. */
  readonly onNotice?: (text: string) => void
}

/** `confirmed`: go on with `by` on the record. `refused`: already journaled and answered. */
export type ConfirmOutcome = { readonly kind: 'confirmed'; readonly by: string } | { readonly kind: 'refused' }

export interface ConfirmStep {
  /** True when the live policy makes the person at the client confirm this tool for this agent. */
  isRequired(toolName: string): boolean
  /** Asks and waits; `thenAdmin` says an admin approves after an Accept (the dialog says so). */
  run(call: ParsedToolCall, facts: CallFacts, thenAdmin: boolean): Promise<ConfirmOutcome>
  /** Session end: every open confirmation is refused. */
  withdrawAll(): void
}

interface Refusal {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly reason: ClientConfirmErrorReason
  readonly actor?: string
  /** What the operator's terminal is told, when the refusal is not the person's own choice. */
  readonly operatorLine?: 'no-dialog' | 'too-fast'
}

const REFUSED: ConfirmOutcome = { kind: 'refused' }

/** What a non-confirmation means for the call; `timedOut` tells a timeout from a session end. */
function refusalOf(answer: Exclude<ConfirmAnswer, { kind: 'accepted' }>, timedOut: boolean): Refusal {
  switch (answer.kind) {
    case 'declined':
      return { outcome: 'denied-by-operator', rule: CLIENT_CONFIRM_RULES.declined, reason: 'refused', actor: answer.actor }
    case 'cancelled':
      return { outcome: 'denied-by-operator', rule: CLIENT_CONFIRM_RULES.cancelled, reason: 'refused', actor: answer.actor }
    case 'too-fast':
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.tooFast, reason: 'unconfirmed', operatorLine: 'too-fast' }
    case 'failed':
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.failed, reason: 'unavailable', operatorLine: 'no-dialog' }
    case 'withdrawn':
      return timedOut
        ? { outcome: 'timeout', rule: CLIENT_CONFIRM_RULES.timeout, reason: 'timeout' }
        : { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.sessionEnded, reason: 'unconfirmed' }
  }
}

export function createConfirmStep(deps: ConfirmStepDeps): ConfirmStep {
  const { serverName, confirmer } = deps
  const notice = deps.onNotice ?? ((): void => undefined)

  async function refuse(call: ParsedToolCall, facts: CallFacts, refusal: Refusal): Promise<ConfirmOutcome> {
    const extras = {
      ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
      ...(refusal.actor !== undefined ? { actor: refusal.actor } : {}),
    }
    deps.writeDecision(decisionInfoOf(facts, refusal.outcome, refusal.rule, extras), call.args)
    await deps.settleJournal()
    await deps.answerLocally(call.id, (id) => clientConfirmError(id, { toolName: facts.toolName, reason: refusal.reason }))
    return REFUSED
  }

  function tellOperator(facts: CallFacts, line: Refusal['operatorLine']): void {
    const tool = `${replaceControlChars(facts.toolName)} on ${serverName}`
    if (line === 'no-dialog') {
      notice(
        `${tool} needs confirmation in the client, and ${confirmer?.clientName() ?? 'this client'} cannot show the dialog: refused.\n` +
          `  Use a client with MCP form elicitation (Claude Code), or remove it from "confirmInClient" in the policy.\n`,
      )
    }
    if (line === 'too-fast') {
      notice(`An Accept for ${tool} came too fast twice to be a person reading it: refused. The agent may retry.\n`)
    }
  }

  async function run(call: ParsedToolCall, facts: CallFacts, thenAdmin: boolean): Promise<ConfirmOutcome> {
    // No return address: the result of a confirmation could never be delivered.
    if (call.id === null) return refuse(call, facts, { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.idless, reason: 'unconfirmed' })
    const pending = confirmer?.confirm({ toolName: facts.toolName, serverName, args: call.args, thenAdmin })
    if (pending === undefined) {
      const refusal: Refusal = { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.unavailable, reason: 'unavailable', operatorLine: 'no-dialog' }
      tellOperator(facts, refusal.operatorLine)
      return refuse(call, facts, refusal)
    }
    const waitKey = idKeyOf(call.id)
    deps.answerGuard.beginWait(waitKey)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      pending.withdraw()
    }, deps.timeoutMs)
    timer.unref()
    try {
      const answer = await pending.answer
      if (answer.kind === 'accepted') return { kind: 'confirmed', by: answer.actor }
      const refusal = refusalOf(answer, timedOut)
      tellOperator(facts, refusal.operatorLine)
      return await refuse(call, facts, refusal)
    } finally {
      clearTimeout(timer)
      deps.answerGuard.endWait(waitKey)
    }
  }

  return {
    isRequired: (toolName) => isConfirmInClient(deps.policy.current(), serverName, toolName, deps.agentName),
    run,
    withdrawAll: () => confirmer?.withdrawAll(),
  }
}
