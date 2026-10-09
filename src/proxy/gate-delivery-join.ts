import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import { startHold, type HoldScheduler } from './approval-hold.js'
import type { Verdict } from './pipeline.js'
import type { ToolUseAnswers } from './tool-use-answers.js'
import {
  DROP,
  decisionInfoOf,
  idKeyOf,
  type AnswerGuard,
  type CallFacts,
  type DecisionExtras,
  type DecisionWriter,
} from './gate-helpers.js'

/**
 * A resend that arrives while the first call of its tool use is still held or
 * running joins it (decision M39, replacing phase C's refusal): it waits —
 * telling its client so, on the call's progress token — until that call lets
 * the tool use go, then is decided again, which finds the kept answer and
 * replays it. Nothing is sent to the server twice. The usual sender is the
 * `connect --url` bridge re-posting a call whose connection dropped.
 *
 * The agent may leave the resend too: its cancel, its connection, the session
 * ending. The wait then ends like a held call's — journaled `agent-gone`,
 * nothing answered, the id announced as never to be answered (S-L1).
 */

/** `rule` of the `agent-gone` record of a resend whose agent left while it waited. */
export const TOOL_USE_JOINED_RULE = 'tool-use-joined'

/** What a joined resend's client hears while it waits (not an approval: the first call is already on its way). */
export const JOINED_CALL_PROGRESS_TEXT = 'this call is already running; waiting for its answer'

export interface JoinedCallsDeps {
  readonly scope: string
  readonly answers: ToolUseAnswers
  readonly writeDecision: DecisionWriter
  readonly answerGuard: Pick<AnswerGuard, 'markAnswered'>
  /** Present on a path that carries the gate's own notifications: the wait sends progress. */
  readonly sendProgress?: (bytes: Buffer) => Promise<void>
  readonly scheduler: HoldScheduler
  readonly onRequestDropped?: (id: JsonRpcId) => void
  readonly onError: (error: unknown) => void
}

/** `'released'`: decide the call again; a verdict: the agent left while it waited. */
export type JoinOutcome = 'released' | Verdict

export interface JoinedCalls {
  join(call: ParsedToolCall & { readonly toolUseId: string }, facts: CallFacts): Promise<JoinOutcome>
  /** The agent stopped waiting for `idKey`: a resend joined under it ends. */
  leave(idKey: string, reason: string): void
  leaveAll(reason: string): void
}

export function createJoinedCalls(deps: JoinedCallsDeps): JoinedCalls {
  const waiting = new Map<string, (reason: string) => void>()

  function agentGone(call: ParsedToolCall, facts: CallFacts, reason: string): Verdict {
    const extras: DecisionExtras = { reason, ...(call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}) }
    deps.writeDecision(decisionInfoOf(facts, 'agent-gone', TOOL_USE_JOINED_RULE, extras))
    if (call.id !== null) deps.answerGuard.markAnswered(idKeyOf(call.id))
    try {
      deps.onRequestDropped?.(call.id)
    } catch (error: unknown) {
      deps.onError(error)
    }
    return DROP
  }

  function join(call: ParsedToolCall & { readonly toolUseId: string }, facts: CallFacts): Promise<JoinOutcome> {
    const idKey = call.id === null ? '' : idKeyOf(call.id)
    return new Promise<JoinOutcome>((resolve) => {
      const hold = startHold({
        approvalId: call.toolUseId,
        ...(call.progressToken !== undefined ? { progressToken: call.progressToken } : {}),
        ...(deps.sendProgress !== undefined ? { messageOf: () => JOINED_CALL_PROGRESS_TEXT } : {}),
        send: deps.sendProgress ?? (() => Promise.resolve()),
        scheduler: deps.scheduler,
        onError: deps.onError,
      })
      let isDone = false
      const finish = (outcome: () => JoinOutcome): void => {
        if (isDone) return
        isDone = true
        hold.stop()
        if (waiting.get(idKey) === leaveThis) waiting.delete(idKey)
        resolve(outcome())
      }
      const leaveThis = (reason: string): void => finish(() => agentGone(call, facts, reason))
      waiting.set(idKey, leaveThis)
      void deps.answers.whenReleased(deps.scope, call.toolUseId).then(() => finish(() => 'released'))
    })
  }

  return {
    join,
    leave(idKey, reason) {
      waiting.get(idKey)?.(reason)
    },
    leaveAll(reason) {
      for (const leave of [...waiting.values()]) leave(reason)
    },
  }
}
