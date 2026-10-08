import type { JsonRpcId } from '../protocol/classify.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import type { SynthesizableId } from './synthesize.js'
import {
  DROP,
  GATE_ERROR_RULE,
  decisionInfoOf,
  denialBytesFor,
  isPromiseVerdict,
  type CallFacts,
  type DecisionWriter,
} from './gate-helpers.js'

/**
 * The gate's own failure discipline, split out of `gate-core.ts` for the
 * <400-line file rule: a tool call's decision path can neither throw nor
 * reject past the gate — any gate-internal error denies the call (fail
 * closed) — and every verdict still in flight is remembered, so a session's
 * teardown can wait it out.
 */

export interface GateGuardDeps {
  readonly serverName: string
  readonly writeDecision: DecisionWriter
  readonly settleJournal: () => Promise<void>
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  readonly onError: (error: unknown) => void
}

export interface GateGuard {
  /**
   * Runs one tool call's decision path so that neither a synchronous throw
   * nor a rejected promise can escape: both fail closed (deny + drop). The
   * synchronous shape is preserved when `produce` answers synchronously, so
   * an allowed call is not reordered merely for having been guarded.
   */
  guarded(call: ParsedToolCall, produce: () => Verdict | Promise<Verdict>): Verdict | Promise<Verdict>
  /** Remembers an in-flight verdict so the teardown can wait it out. */
  track(work: Verdict | Promise<Verdict>): Verdict | Promise<Verdict>
  /** Settles once every verdict tracked so far has. */
  awaitOutstanding(): Promise<void>
}

export function createGateGuard(deps: GateGuardDeps): GateGuard {
  const { serverName, writeDecision, settleJournal, answerLocally, onError } = deps
  const outstanding = new Set<Promise<Verdict>>()

  /** Fail-closed handling of a gate-internal error on a `tools/call`. */
  async function denyOnGateError(call: ParsedToolCall): Promise<Verdict> {
    try {
      // Worst-case class, no args fingerprint: nothing was resolved.
      const toolName = call.toolName
      const facts: CallFacts = { serverName, toolName, toolClass: 'destructive', quarantineState: 'unknown', argsHash: '' }
      writeDecision(decisionInfoOf(facts, 'deny', GATE_ERROR_RULE))
      await settleJournal()
      await answerLocally(call.id, (id) => denialBytesFor(id, { toolName, serverName, rule: GATE_ERROR_RULE }))
    } catch (error: unknown) {
      onError(error)
    }
    return DROP
  }

  return {
    guarded(call, produce) {
      const failClose = (error: unknown): Promise<Verdict> => {
        onError(error)
        return denyOnGateError(call)
      }

      let outcome: Verdict | Promise<Verdict>
      try {
        outcome = produce()
      } catch (error: unknown) {
        return failClose(error)
      }
      return isPromiseVerdict(outcome) ? outcome.catch(failClose) : outcome
    },

    track(work) {
      if (!isPromiseVerdict(work)) return work
      outstanding.add(work)
      void work.finally(() => outstanding.delete(work))
      return work
    },

    async awaitOutstanding() {
      await Promise.allSettled(Array.from(outstanding))
    },
  }
}
