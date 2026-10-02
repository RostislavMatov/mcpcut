import { replaceControlChars } from '../journal/format.js'
import { isConfirmInClient } from '../policy/confirm-in-client.js'
import type { PolicyProvider } from '../policy/provider.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { ClientConfirmer, ConfirmAnswer, PendingConfirmation } from './client-confirm.js'
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
  busy: 'client-confirm-busy',
  declinedRecently: 'client-confirm-declined-recently',
  requestCancelled: 'client-confirm-request-cancelled',
} as const

/**
 * The person's attention is the control (2026-10-02 security review): an
 * agent must not bury them in dialogs. No more than this many calls wait for
 * a confirmation at once; the next is refused without a dialog.
 */
export const MAX_WAITING_CONFIRMATIONS = 5

/** After a Decline or Esc, the same call (tool and arguments) is refused without a dialog for this long. */
export const DECLINE_PAUSE_MS = 30_000

/** Bound on the remembered refusals, so an agent varying its arguments cannot grow the map without end. */
const MAX_REMEMBERED_REFUSALS = 256

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
  readonly clock: () => number
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
  /** The client cancelled request `idKey` (`notifications/cancelled`): its dialog closes and the call is refused. */
  cancelByClient(idKey: string): void
}

interface Refusal {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly reason: ClientConfirmErrorReason
  readonly actor?: string
  /** What the operator's terminal is told, when the refusal is not the person's own choice. */
  readonly operatorLine?: 'no-dialog' | 'too-fast' | 'busy'
  /** The client cancelled the request itself: nothing is sent back for its id. */
  readonly isSilent?: boolean
}

/** One call waiting for its dialog's answer. */
interface Open {
  readonly pending: PendingConfirmation
  isCancelledByClient: boolean
}

const REFUSED: ConfirmOutcome = { kind: 'refused' }

/** What a non-confirmation means for the call; `timedOut` tells a timeout from a session end. */
function refusalOf(answer: Exclude<ConfirmAnswer, { kind: 'accepted' }>, timedOut: boolean, isCancelledByClient: boolean): Refusal {
  switch (answer.kind) {
    case 'declined':
      return { outcome: 'denied-by-operator', rule: CLIENT_CONFIRM_RULES.declined, reason: 'refused', actor: answer.actor }
    case 'cancelled':
      // Esc may be the client closing its own dialog: refused, and nobody is named.
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.cancelled, reason: 'unconfirmed' }
    case 'too-fast':
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.tooFast, reason: 'unconfirmed', operatorLine: 'too-fast' }
    case 'failed':
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.failed, reason: 'unavailable', operatorLine: 'no-dialog' }
    case 'withdrawn':
      if (isCancelledByClient) {
        return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.requestCancelled, reason: 'unconfirmed', isSilent: true }
      }
      return timedOut
        ? { outcome: 'timeout', rule: CLIENT_CONFIRM_RULES.timeout, reason: 'timeout' }
        : { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.sessionEnded, reason: 'unconfirmed' }
  }
}

export function createConfirmStep(deps: ConfirmStepDeps): ConfirmStep {
  const { serverName, confirmer } = deps
  const notice = deps.onNotice ?? ((): void => undefined)
  const open = new Map<string, Open>()
  /** `tool + args fingerprint` → until when the same call is refused without a dialog. */
  const pausedUntil = new Map<string, number>()

  async function refuse(call: ParsedToolCall, facts: CallFacts, refusal: Refusal): Promise<ConfirmOutcome> {
    const extras = {
      ...(deps.agentName !== undefined ? { agentName: deps.agentName } : {}),
      ...(refusal.actor !== undefined ? { actor: refusal.actor } : {}),
    }
    deps.writeDecision(decisionInfoOf(facts, refusal.outcome, refusal.rule, extras), call.args)
    await deps.settleJournal()
    if (refusal.isSilent === true && call.id !== null) {
      // Cancelled by the client: no answer for the id, but it can never be forwarded either.
      deps.answerGuard.markAnswered(idKeyOf(call.id))
      return REFUSED
    }
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
    if (line === 'busy') {
      notice(`Too many calls wait for confirmation in the client (${MAX_WAITING_CONFIRMATIONS}): ${tool} refused without a dialog.\n`)
    }
  }

  function pauseKeyOf(facts: CallFacts): string {
    return `${facts.toolName}\u0000${facts.argsHash}`
  }

  /** Remembers a Decline or Esc, dropping what has expired and the oldest beyond the bound. */
  function pause(facts: CallFacts): void {
    const now = deps.clock()
    for (const [key, until] of pausedUntil) if (until <= now) pausedUntil.delete(key)
    pausedUntil.set(pauseKeyOf(facts), now + DECLINE_PAUSE_MS)
    while (pausedUntil.size > MAX_REMEMBERED_REFUSALS) {
      const oldest = pausedUntil.keys().next().value
      if (oldest === undefined) break
      pausedUntil.delete(oldest)
    }
  }

  function isPaused(facts: CallFacts): boolean {
    return (pausedUntil.get(pauseKeyOf(facts)) ?? 0) > deps.clock()
  }

  /** The refusal that needs no dialog at all, or `undefined` when the person can be asked. */
  function refusalBeforeAsking(call: ParsedToolCall, facts: CallFacts): Refusal | undefined {
    // No return address: the result of a confirmation could never be delivered.
    if (call.id === null) return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.idless, reason: 'unconfirmed' }
    if (confirmer?.canConfirm() !== true) {
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.unavailable, reason: 'unavailable', operatorLine: 'no-dialog' }
    }
    if (isPaused(facts)) return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.declinedRecently, reason: 'refused' }
    if (open.size >= MAX_WAITING_CONFIRMATIONS) {
      return { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.busy, reason: 'unconfirmed', operatorLine: 'busy' }
    }
    return undefined
  }

  async function wait(call: ParsedToolCall, facts: CallFacts, entry: Open, waitKey: string): Promise<ConfirmOutcome> {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      entry.pending.withdraw()
    }, deps.timeoutMs)
    timer.unref()
    try {
      const answer = await entry.pending.answer
      if (answer.kind === 'accepted') return { kind: 'confirmed', by: answer.actor }
      if (answer.kind === 'declined' || answer.kind === 'cancelled') pause(facts)
      const refusal = refusalOf(answer, timedOut, entry.isCancelledByClient)
      tellOperator(facts, refusal.operatorLine)
      return await refuse(call, facts, refusal)
    } finally {
      clearTimeout(timer)
      if (open.get(waitKey) === entry) open.delete(waitKey)
    }
  }

  async function run(call: ParsedToolCall, facts: CallFacts, thenAdmin: boolean): Promise<ConfirmOutcome> {
    const early = refusalBeforeAsking(call, facts)
    const pending = early === undefined ? confirmer?.confirm({ toolName: facts.toolName, serverName, args: call.args, thenAdmin }) : undefined
    if (call.id === null || pending === undefined) {
      const refusal = early ?? { outcome: 'deny', rule: CLIENT_CONFIRM_RULES.unavailable, reason: 'unavailable', operatorLine: 'no-dialog' }
      tellOperator(facts, refusal.operatorLine)
      return refuse(call, facts, refusal)
    }
    const waitKey = idKeyOf(call.id)
    const entry: Open = { pending, isCancelledByClient: false }
    open.set(waitKey, entry)
    deps.answerGuard.beginWait(waitKey)
    try {
      return await wait(call, facts, entry, waitKey)
    } finally {
      deps.answerGuard.endWait(waitKey)
    }
  }

  return {
    isRequired: (toolName) => isConfirmInClient(deps.policy.current(), serverName, toolName, deps.agentName),
    run,
    withdrawAll: () => confirmer?.withdrawAll(),
    cancelByClient(idKey) {
      const entry = open.get(idKey)
      if (entry === undefined) return
      entry.isCancelledByClient = true
      entry.pending.withdraw()
    },
  }
}
