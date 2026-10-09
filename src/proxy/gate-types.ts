import type { ApprovalWaiter } from '../policy/approvals/waiter.js'
import type { ArgsCheck } from './gate-args-check.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { MessageGate, MessageSink } from '../transport/message.js'
import type { HoldScheduler } from './approval-hold.js'
import type { ToolUseAnswers } from './tool-use-answers.js'
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
  /**
   * The policy's cap on the wait (`approval.timeoutMs`), after which the call
   * is answered with a timeout. ABSENT by default (decision M36): the call is
   * held for as long as its agent waits.
   */
  readonly waitMs?: number
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
   * Present on the stdio paths (`wrap`, `connect`), which have a client to
   * ask: a call the policy lists in `confirmInClient` for this agent is
   * confirmed by the person at the client first (ADR-0019). Absent — the HTTP
   * paths — such a call is refused: nobody can be asked.
   */
  readonly confirmInClient?: ConfirmInClientDeps
  /**
   * A tighten-only look at the call's arguments after `decide()` (ADR-0020
   * §2): present only for a server whose arguments name resources the plane
   * can check itself (the built-in file server). Absent: nothing changes.
   */
  readonly argsCheck?: ArgsCheck
  /**
   * The text of the `notifications/progress` a call held for approval sends
   * its client at once and then once a minute, when the call carried a
   * `progressToken` (decision M36). Given on every path whose client channel
   * carries the gate's own notifications: stdio (`wrap`, `connect`) and, since
   * phase B, the HTTP front of `serve`, which routes the progress onto the
   * call's own POST as an SSE stream (`session-post-stream.ts`). Absent — no
   * progress is sent.
   */
  readonly heldCallProgress?: (approvalId: string) => string
  /** Injectable intervals for the hold's heartbeat and progress (tests). Defaults to the real timers. */
  readonly holdScheduler?: HoldScheduler
  /**
   * The process's table of server answers by tool use (M36 phase C,
   * `tool-use-answers.ts`). Shared by every session of a process that can
   * see one tool use arrive on two sessions (`serve`); absent, the gate keeps
   * its own — enough for a stdio path, whose process is one session.
   */
  readonly toolUseAnswers?: ToolUseAnswers
  /**
   * Hears each request id the gate settled WITHOUT forwarding it and without
   * answering it: a call held for approval whose agent left (decision M36).
   * No answer will ever come for that id, so whoever correlates answers to
   * requests can forget it — the pool's correlator, which otherwise keeps it
   * until the pool session ends (review finding S-L1). A throw is reported
   * through `onError` and changes nothing about the call.
   */
  readonly onRequestDropped?: (id: JsonRpcId) => void
}

/** What the gate needs for the confirmation in the client (see `gate-confirm.ts`). */
export interface ConfirmInClientDeps {
  /** Lines for the operator's terminal: why a confirmation was refused. */
  readonly onNotice?: (text: string) => void
}

export interface MessagePolicyGate {
  /** Gates one client->server message. */
  readonly gateClientMessage: MessageGate
  /** Gates one server->client message. */
  readonly gateServerMessage: MessageGate
  /**
   * Session teardown: every call held for approval is withdrawn as
   * `disconnected` (journaled `agent-gone`, never forwarded, never answered —
   * the agent is gone; decision M36), every open confirmation is refused, and
   * their verdicts are awaited.
   */
  cancelPending(): Promise<void>
  /**
   * The agent is gone, but the session is not torn down yet (M36 phase C):
   * held calls and open confirmations are withdrawn as at teardown, and every
   * call already forwarded is marked as owed to nobody, so its answer — read
   * during the teardown grace — is journaled `undelivered`.
   */
  agentLeft(): Promise<void>
  /**
   * Waits up to `graceMs` for the server's answers to forwarded calls, then
   * journals each still missing as `unanswered` (with `reason` when its agent
   * had not left) and resolves to how many there were. A call the agent
   * cancelled is not counted: a server need not answer it. `stop` ends the
   * wait early (the server is gone: nothing more can come).
   */
  settleForwarded(graceMs: number, reason: string, stop?: AbortSignal): Promise<number>
  /**
   * The agent stopped waiting for request `id` without a cancel — its HTTP
   * request closed (phase B of M36). A call held for an approval or a
   * confirmation under that id is withdrawn as `disconnected`; a call already
   * forwarded is left to finish (a dropped connection is not a cancel), and
   * nothing is sent to the server. A `null` id is ignored.
   */
  abandonRequest(id: JsonRpcId): void
}
