import { serverMessage, type McpMessage, type MessageOrigin, type MessageVerdict } from '../transport/message.js'
import { frameToMessage, messageToChunk } from '../transport/stdio-adapter.js'
import type { GateFn, Verdict } from './pipeline.js'
import type { OrderedWriter } from './writer.js'
import { isPromiseVerdict } from './gate-helpers.js'
import {
  createMessagePolicyGate,
  type MessagePolicyGate,
  type MessagePolicyGateDeps,
} from './gate-core.js'

export type { GateAgentScope, GateInventory, GateSink } from './gate-helpers.js'
export type { GateApprovalQueue } from './gate-approvals.js'
export {
  createMessagePolicyGate,
  type GateAnswerSink,
  type MessagePolicyGate,
  type MessagePolicyGateDeps,
} from './gate-core.js'

/**
 * The stdio Frame face of the session policy gate.
 *
 * Since M3 the gate itself is transport-neutral and lives in
 * `gate-core.ts`, consuming `McpMessage`s. This module is the thin adapter
 * that keeps the M1/M2 stdio contract byte-identical:
 *
 *  - inbound `Frame`s become messages via `frameToMessage` (bytes and
 *    terminator carried 1:1; blank frames never reach a gate — the pipeline
 *    forwards them directly, exactly as before — and overflow frames are
 *    dropped by the pipeline before the gate, C1);
 *  - the core's *content-only* emit bytes and synthetic answers are
 *    line-framed back (`messageToChunk` appends the `\n` that `wrap`'s
 *    writers expect), so what reaches the client is byte-for-byte what M2
 *    produced.
 *
 * The verdict unions (`Verdict`/`MessageVerdict`) are member-for-member
 * mirrors, so the adapter only ever touches `emit` bytes.
 */

/** The subset of `OrderedWriter` the gate needs to answer a client locally. */
export type GateWriter = Pick<OrderedWriter, 'writeMessage'>

export interface PolicyGateDeps extends Omit<MessagePolicyGateDeps, 'clientSink'> {
  /** Writes synthetic responses back to the client (whole `\n`-framed lines). */
  readonly clientWriter: GateWriter
}

export interface PolicyGate {
  /** Gates one client->server frame. */
  readonly gateClientMessage: GateFn
  /** Gates one server->client frame. */
  readonly gateServerMessage: GateFn
  /**
   * Session teardown: cancels every in-flight approval wait (each settles as
   * a timeout, so the client still gets an answer) and awaits their verdicts.
   */
  cancelPending(): Promise<void>
}

/** Reattaches the line framing the message-level core deliberately omits. */
function lineFramedVerdict(verdict: MessageVerdict): Verdict {
  if (verdict.action !== 'emit') return verdict
  return { action: 'emit', bytes: messageToChunk(serverMessage(verdict.bytes)) }
}

/**
 * Adapts one direction of the message core to `GateFn`, preserving the
 * synchronous shape: a verdict the core answers inline stays inline, so an
 * allowed call is not reordered merely for having been adapted.
 */
function frameGateOf(
  gate: (message: McpMessage) => MessageVerdict | Promise<MessageVerdict>,
  origin: MessageOrigin,
): GateFn {
  return (frame) => {
    const outcome = gate(frameToMessage(frame, origin))
    return isPromiseVerdict(outcome) ? outcome.then(lineFramedVerdict) : lineFramedVerdict(outcome)
  }
}

export function createPolicyGate(deps: PolicyGateDeps): PolicyGate {
  const { clientWriter, ...coreDeps } = deps
  const core: MessagePolicyGate = createMessagePolicyGate({
    ...coreDeps,
    // Synthetic answers come out of the core as content bytes; the stdio
    // chunk conversion appends the `\n` M2's clients received.
    clientSink: { write: (message) => clientWriter.writeMessage(messageToChunk(message)) },
  })

  return {
    gateClientMessage: frameGateOf(core.gateClientMessage, 'client'),
    gateServerMessage: frameGateOf(core.gateServerMessage, 'server'),
    cancelPending: () => core.cancelPending(),
  }
}
