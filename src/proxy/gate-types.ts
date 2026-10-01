import type { ApprovalWaiter } from '../policy/approvals/waiter.js'
import type { GrantRegistry } from '../policy/approvals/grants.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { MessageGate, MessageSink } from '../transport/message.js'
import type { ClientApprovalDeps } from './client-approval.js'
import type { GateApprovalQueue } from './gate-approvals.js'
import type {
  DecisionProvenance,
  GateAgentScope,
  GateInventory,
  GateSink,
} from './gate-helpers.js'

/**
 * The message-level policy gate's public contract, split out of gate-core.ts
 * purely for the <400-line file rule — gate-core re-exports everything here,
 * so importers see one module.
 */

/** The subset of `MessageSink` the gate needs to answer a client locally. */
export type GateAnswerSink = Pick<MessageSink, 'write'>

/** A call the gate has queued for a human, announced while its agent waits. */
export interface PendingApprovalNotice {
  readonly approvalId: string
  /** Chosen by the agent's client: sanitize before it reaches a terminal. */
  readonly toolName: string
  readonly serverName: string
  /** How long the agent's call waits before it is answered with a timeout. */
  readonly waitMs: number
}

export interface MessagePolicyGateDeps {
  /**
   * The rules to decide under. A `PolicyProvider` is read per decision, so an
   * edit of `policy.json` reaches this gate without a restart (wave 2 of the
   * policy-tool-rules-ui plan); a plain `Policy` is wrapped in a static
   * provider and behaves exactly as before. Wiring-time configuration —
   * `approval.*`, `journal.failClosed` — is read once from the initial value.
   */
  readonly policy: Policy | PolicyProvider
  readonly serverName: string
  readonly sessionId: string
  readonly inventory: GateInventory
  readonly approvalQueue: GateApprovalQueue
  readonly approvalWaiter: ApprovalWaiter
  readonly grantRegistry: GrantRegistry
  readonly sink: GateSink
  /** Delivers synthetic answers to the client (content bytes, no framing). */
  readonly clientSink: GateAnswerSink
  /**
   * The authenticated agent's visibility/grant scope (M3). Absent on the
   * ad-hoc `wrap` path — exactly the M2 behavior, byte for byte.
   */
  readonly agentScope?: GateAgentScope
  /**
   * The provenance every decision record this gate writes is stamped with
   * (M5). Supplied by `session/core.ts`, which builds ONE per session and
   * shares it with its own decision writer, so the session and its gate
   * cannot fingerprint the same policy twice and disagree. Absent (the stdio
   * `wrap` path and every test double) means the gate builds its own from
   * `policy` and `agentScope`.
   */
  readonly provenance?: DecisionProvenance
  /**
   * Root of the approvals queue on disk, for the late-approval fallback.
   * Defaults to `JOURNAL_DIR/approvals`; must match `approvalQueue`'s own.
   */
  readonly approvalsBaseDir?: string
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
  /** Reports gate-internal failures. Defaults to one line on stderr. */
  readonly onError?: (error: unknown) => void
  /**
   * Hears of each call queued for a human, once, before its wait starts
   * (0.2.3): `wrap` tells the operator on its stderr which id to approve.
   * Never the agent's channel — an agent with a shell would approve itself.
   * A throw is reported through `onError` and changes nothing about the call.
   */
  readonly onApprovalPending?: (notice: PendingApprovalNotice) => void
  /**
   * Present on the stdio `wrap` path when the policy has `approval.askClient`
   * (P2): a held call is also asked in the client, whose answer is written
   * into the queue through `resolve`. Absent — the HTTP paths, every test
   * double — means the queue alone, exactly as before.
   */
  readonly askClient?: AskClientDeps
}

/** What the gate needs to ask the client about a held call (see `client-approval.ts`). */
export interface AskClientDeps {
  readonly resolve: ClientApprovalDeps['resolve']
  /** Checked before each question (see `AskClientOptions`). */
  readonly mayAsk?: () => Promise<boolean>
  /** How mcpcut is started here, for the commands the dialog names. */
  readonly command?: string
  /** Lines for the operator's terminal. */
  readonly onNotice?: (text: string) => void
}

export interface MessagePolicyGate {
  /** Gates one client->server message. */
  readonly gateClientMessage: MessageGate
  /** Gates one server->client message. */
  readonly gateServerMessage: MessageGate
  /**
   * Session teardown: cancels every in-flight approval wait (each settles as
   * a timeout, so the client still gets an answer) and awaits their verdicts.
   */
  cancelPending(): Promise<void>
}
