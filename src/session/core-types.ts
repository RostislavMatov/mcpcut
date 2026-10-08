import type { AgentRecord } from '../agents/schema.js'
import type { RecordBuilder } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import type { ApprovalWaiter } from '../policy/approvals/waiter.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { GateApprovalQueue } from '../proxy/gate-approvals.js'
import type { GateInventory } from '../proxy/gate-helpers.js'
import type { MessagePolicyGateDeps } from '../proxy/gate-types.js'
import type { MessageSink, MessageSource } from '../transport/message.js'
import type { AgentRecordReader } from './agent-watch.js'

/**
 * The contract of `core.ts` (the transport-neutral session), split out for
 * the <400-line file rule; `core.ts` re-exports everything here, so importers
 * see one module.
 */

/** One side's transport endpoints, already constructed by the caller. */
export interface SessionEndpoints {
  readonly source: MessageSource
  readonly sink: MessageSink
}

/** The approvals machinery for one session, shared shape with the gate. */
export interface SessionApprovals {
  readonly queue: GateApprovalQueue
  readonly waiter: ApprovalWaiter
}

/** Journal wiring: the record builder and sink are bound to this session id. */
export interface SessionJournal {
  readonly recordBuilder: RecordBuilder
  readonly sink: Pick<JournalSink, 'write' | 'flush'>
}

/** The authenticated agent of this session, plus where to re-read it from. */
export interface SessionAgent {
  /** The record as authenticated at session start. */
  readonly record: AgentRecord
  /** Re-reads grants/revocation; satisfied by `agents/store.ts`. */
  readonly store: AgentRecordReader
}

export interface CreateSessionDeps {
  readonly sessionId: string
  /** Registry name of the proxied server (`auto:<hash>` only for ad-hoc wrap). */
  readonly serverName: string
  readonly client: SessionEndpoints
  readonly server: SessionEndpoints
  /**
   * Pre-loaded, already-validated policy (loading is the caller's job). A
   * `PolicyProvider` hot-reloads the rules under the session; a plain
   * `Policy` behaves exactly as before.
   */
  readonly policy: Policy | PolicyProvider
  readonly inventory: GateInventory
  readonly approvals: SessionApprovals
  readonly journal: SessionJournal
  /**
   * Exact values this session's upstream was handed (vault-resolved env and
   * header material, plus the registry literals beside them). Registered on
   * the record builder before any traffic is tapped, so the journal redacts
   * the secrets the plane itself injected even when a server echoes one back
   * under an innocent key. See `redact/known-secrets.ts`.
   */
  readonly knownSecrets?: readonly string[]
  readonly agent?: SessionAgent
  /** Injectable clock (ms since epoch) for deterministic tests. */
  readonly clock?: () => number
  /** Poll interval for revocation/grant re-reads. Defaults to the ≤5 s constant. */
  readonly revocationPollIntervalMs?: number
  /** Reports session-internal failures. Defaults to one line on stderr. */
  readonly onError?: (error: unknown) => void
  /**
   * The client channel for `confirmInClient` (ADR-0019). Given only by the
   * stdio `connect`, whose client is one process with one person; the HTTP
   * front never passes it (a held POST has no channel for the question), so
   * there a call that needs the confirmation is refused.
   */
  readonly confirmInClient?: MessagePolicyGateDeps['confirmInClient']
  /** Progress text of a call held for approval (M36); see `MessagePolicyGateDeps.heldCallProgress`. */
  readonly heldCallProgress?: MessagePolicyGateDeps['heldCallProgress']
  /** The process's answers by tool use (M36 phase C); see `MessagePolicyGateDeps.toolUseAnswers`. */
  readonly toolUseAnswers?: MessagePolicyGateDeps['toolUseAnswers']
  /** The teardown grace for calls already sent; `FORWARDED_ANSWER_GRACE_MS` when absent (tests shorten it). */
  readonly forwardedAnswerGraceMs?: number
  /**
   * Hears, once, at the end of a session whose server left calls unanswered
   * (journaled `unanswered`), how many — so the operator is told the server
   * has a problem (M36 phase C). Not called when there were none.
   */
  readonly onUnansweredCalls?: (count: number) => void
  /** See `MessagePolicyGateDeps.onRequestDropped` (S-L1: the pool forgets the id). */
  readonly onRequestDropped?: MessagePolicyGateDeps['onRequestDropped']
  /** Fired exactly once, after the session has fully ended. */
  readonly onSessionEnd?: (reason: SessionEndReason) => void
}

/** Why a session ended. `closed` is the caller's own `close()`. */
export type SessionEndReason = 'client-ended' | 'server-ended' | 'revoked' | 'closed'

export interface SessionHandle {
  /**
   * Ends the session: stops the watch, disposes sources, settles in-flight
   * approval waits (clients still get an answer), drains pending writes,
   * then disposes sinks. Idempotent — the first reason wins.
   */
  close(reason?: SessionEndReason): Promise<void>
  /** Resolves once the session has fully ended, with the winning reason. */
  readonly ended: Promise<SessionEndReason>
  /**
   * The agent stopped waiting for this request without a cancel — its HTTP
   * request closed (decision M36, phase B). `requestBytes` is the request as
   * the agent sent it; a call held for a human under its id is withdrawn as
   * `disconnected`, anything else is left alone. Never throws.
   */
  abandonRequest(requestBytes: Buffer): void
}
