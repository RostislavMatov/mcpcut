import type { RecordBuilder, ClientServerDirection } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import type { GrantRegistry } from '../policy/approvals/grants.js'
import type { ApprovalWaiter } from '../policy/approvals/waiter.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import { classify } from '../protocol/classify.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageSink,
  type MessageSource,
  type MessageVerdict,
} from '../transport/message.js'
import type { AgentRecord } from '../agents/schema.js'
import type { GateApprovalQueue } from '../proxy/gate-approvals.js'
import { createMessagePolicyGate, type MessagePolicyGate } from '../proxy/gate-core.js'
import {
  createDecisionProvenance,
  createDecisionWriter,
  isPromiseVerdict,
  type GateInventory,
} from '../proxy/gate-helpers.js'
import { isRevokedFor, startAgentWatch, type AgentRecordReader, type AgentWatch } from './agent-watch.js'
import {
  AGENT_REVOCATION_POLL_INTERVAL_MS,
  AGENT_REVOKED_RULE,
  SESSION_TOOL_NAME,
} from './constants.js'

/**
 * Transport-neutral session assembly (M3): one proxied MCP session over any
 * pair of `MessageSource`/`MessageSink` endpoints — the same core for stdio
 * (`connect`) and HTTP (`serve`).
 *
 * The wiring mirrors what `wire-policy.ts` does for the stdio Frame world:
 *
 *   client.source --tap--> gate(client) --verdict--> server.sink
 *   server.source --tap--> gate(server) --verdict--> client.sink
 *
 * with the same two load-bearing details:
 *  - The gate's synthetic answers go through `client.sink` — the SAME sink
 *    relayed server->client messages use — so a locally-injected error can
 *    never interleave inside a relayed message (`MessageSink` serializes).
 *  - Every non-blank message is journaled by the tap BEFORE the gate is
 *    consulted, exactly like mode A/B's `tapMessage`: journaling is never
 *    routed through the verdict path, so "everything is journaled" cannot
 *    depend on what the gate decides. Decision records the gate writes are
 *    additional, never a substitute. Blank messages (empty content bytes)
 *    are forwarded directly, skipping tap and gate — the same routing the
 *    stdio pipeline applies to blank frames.
 *
 * The agent dimension: with `deps.agent`, the gate sees a live
 * `GateAgentScope` backed by `agent-watch.ts`, which re-reads `agents.json`
 * on an interval (≤ `AGENT_REVOCATION_POLL_INTERVAL_MS`). A revocation (or
 * removal of this server's grant) ends the session: in-flight approval
 * waits are cancelled — each answers its client with the existing synthetic
 * timeout error (`gate cancelPending` machinery) — sources are disposed, a
 * final `agent-revoked` decision record is journaled, and
 * `onSessionEnd('revoked')` fires. Grant edits WITHOUT revocation are
 * picked up by the same poll and apply from the next call.
 *
 * This module owns lifecycle, not transports: sources/sinks arrive
 * constructed and are disposed here on end, but process/socket lifetimes
 * belong to the callers (`connect`/`serve`, Wave 4).
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
  /** Approvals root on disk; must match `queue`'s own (see gate-core). */
  readonly baseDir?: string
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
  readonly grants: GrantRegistry
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
}

function defaultOnError(error: unknown): void {
  process.stderr.write(`[session] ${error instanceof Error ? error.message : String(error)}\n`)
}

/** Blank = empty content bytes, mirroring the stdio splitter's `isBlank`. */
function isBlankMessage(message: McpMessage): boolean {
  return message.bytes.length === 0
}

export function createSession(deps: CreateSessionDeps): SessionHandle {
  const { sessionId, serverName, client, server, journal } = deps
  const clock = deps.clock ?? Date.now
  const onError = deps.onError ?? defaultOnError
  const pollIntervalMs = deps.revocationPollIntervalMs ?? AGENT_REVOCATION_POLL_INTERVAL_MS

  // Before anything can be tapped: no record may be built without knowing
  // which exact values this session's upstream was trusted with.
  if (deps.knownSecrets !== undefined) {
    journal.recordBuilder.registerKnownSecrets(deps.knownSecrets)
  }

  let endPromise: Promise<void> | null = null
  let endedReason: SessionEndReason | null = null
  let settleEnded: (reason: SessionEndReason) => void = () => undefined
  const ended = new Promise<SessionEndReason>((resolve) => {
    settleEnded = resolve
  })
  /** In-flight verdicts and sink writes, awaited before the sinks go away. */
  const pending = new Set<Promise<void>>()

  const watch: AgentWatch | null =
    deps.agent !== undefined
      ? startAgentWatch({
          record: deps.agent.record,
          serverName,
          store: deps.agent.store,
          pollIntervalMs,
          onRevoked: () => {
            void endSession('revoked')
          },
          onError,
        })
      : null

  /**
   * ONE provenance object for the whole session (M5). Both the gate's
   * decision writer and this module's own writer are handed it, so the two
   * cannot fingerprint the same policy from two independently-passed
   * references and disagree — they agreed before only because the caller
   * happened to pass the same object.
   *
   * The agent dimension comes from the same `watch` the gate decides
   * against, which is what gives the revocation record a real `grantsHash`:
   * the revoking poll stops the watch WITHOUT touching the fingerprint, so
   * the last known-good matrix — precisely the one the agent held when it was
   * cut off — is still there to be stamped.
   */
  const provenance = createDecisionProvenance(deps.policy, watch?.scope)

  const gate: MessagePolicyGate = createMessagePolicyGate({
    policy: deps.policy,
    serverName,
    sessionId,
    inventory: deps.inventory,
    approvalQueue: deps.approvals.queue,
    approvalWaiter: deps.approvals.waiter,
    grantRegistry: deps.grants,
    sink: journal.sink,
    clientSink: client.sink,
    provenance,
    ...(watch !== null ? { agentScope: watch.scope } : {}),
    ...(deps.approvals.baseDir !== undefined ? { approvalsBaseDir: deps.approvals.baseDir } : {}),
    clock,
    onError,
  })

  /** Journals one message before the gate sees it (never via the verdict path). */
  function tap(message: McpMessage, direction: ClientServerDirection): void {
    try {
      const classified = classify(message.bytes.toString('utf8'))
      journal.sink.write(journal.recordBuilder.buildRecord(classified, direction))
    } catch (error: unknown) {
      onError(error)
    }
  }

  function trackPending(work: Promise<void>): void {
    const settled = work.catch((error: unknown) => {
      onError(error)
    })
    pending.add(settled)
    void settled.finally(() => pending.delete(settled))
  }

  /**
   * Emit verdicts carry content-only bytes authored by the gate; they are
   * re-wrapped as a fresh message with the relayed message's origin (and no
   * terminator — the destination sink owns framing).
   */
  function applyVerdict(verdict: MessageVerdict, message: McpMessage, sink: MessageSink): Promise<void> {
    if (endedReason !== null) return Promise.resolve()
    if (verdict.action === 'forward') return sink.write(message)
    if (verdict.action === 'emit') {
      const emitted =
        message.meta.origin === 'client' ? clientMessage(verdict.bytes) : serverMessage(verdict.bytes)
      return sink.write(emitted)
    }
    return Promise.resolve()
  }

  /**
   * Relays one message through the gate to `sink`. Mirrors the stdio
   * pipeline's dispatch discipline: blanks bypass tap and gate; a
   * synchronous verdict is applied inline (no reordering against other
   * synchronously-decided messages); an asynchronous verdict never blocks
   * later messages; a gate throw/rejection fails closed as drop+report.
   */
  function relayMessage(
    message: McpMessage,
    gateFn: (m: McpMessage) => MessageVerdict | Promise<MessageVerdict>,
    direction: ClientServerDirection,
    sink: MessageSink,
  ): void {
    if (endedReason !== null) return
    if (isBlankMessage(message)) {
      trackPending(sink.write(message))
      return
    }
    tap(message, direction)

    let outcome: MessageVerdict | Promise<MessageVerdict>
    try {
      outcome = gateFn(message)
    } catch (error: unknown) {
      // Fail closed: the message is already fully handled (dropped).
      onError(error)
      return
    }
    if (isPromiseVerdict(outcome)) {
      trackPending(
        outcome.then(
          (verdict) => applyVerdict(verdict, message, sink),
          (error: unknown) => {
            onError(error)
          },
        ),
      )
      return
    }
    trackPending(applyVerdict(outcome, message, sink))
  }

  // Same provenance discipline as the gate's own writer (`gate-core.ts`):
  // the fingerprint of the policy IN FORCE is stamped on every decision
  // record this module writes (re-hashed only when a hot reload swapped the
  // object). The revocation record has no agent scope to consult — the agent
  // has just lost the session — so it carries `policyHash` only.
  const writeDecision = createDecisionWriter({
    sink: journal.sink,
    sessionId,
    clock,
    provenance,
  })

  /** The final journal record a revocation leaves behind. */
  function journalRevoked(agentName: string): void {
    try {
      writeDecision({
        outcome: 'deny',
        rule: AGENT_REVOKED_RULE,
        serverName,
        toolName: SESSION_TOOL_NAME,
        toolClass: 'destructive',
        quarantineState: 'unknown',
        argsHash: '',
      }, { agentName })
    } catch (error: unknown) {
      onError(error)
    }
  }

  async function runEnd(reason: SessionEndReason): Promise<void> {
    watch?.stop()
    // Stop intake first: no new message may enter the gate after the end.
    client.source.dispose()
    server.source.dispose()
    // In-flight approval waits settle as timeouts and answer their clients
    // through client.sink — which must still be alive here.
    try {
      await gate.cancelPending()
    } catch (error: unknown) {
      onError(error)
    }
    await Promise.allSettled(Array.from(pending))
    // After every in-flight decision has landed, so this really is the
    // session's final decision record.
    if (reason === 'revoked' && deps.agent !== undefined) {
      journalRevoked(deps.agent.record.name)
    }
    try {
      await journal.sink.flush()
    } catch (error: unknown) {
      onError(error)
    }
    client.sink.dispose()
    server.sink.dispose()
    deps.onSessionEnd?.(reason)
    settleEnded(reason)
  }

  function endSession(reason: SessionEndReason): Promise<void> {
    if (endPromise === null) {
      endedReason = reason
      endPromise = runEnd(reason)
    }
    return endPromise
  }

  client.source.onMessage((message) => {
    relayMessage(message, gate.gateClientMessage, 'client→server', server.sink)
  })
  client.source.onError((error) => {
    onError(error)
    void endSession('client-ended')
  })
  client.source.onEnd(() => {
    void endSession('client-ended')
  })

  server.source.onMessage((message) => {
    relayMessage(message, gate.gateServerMessage, 'server→client', client.sink)
  })
  server.source.onError((error) => {
    onError(error)
    void endSession('server-ended')
  })
  server.source.onEnd(() => {
    void endSession('server-ended')
  })

  // Fail closed at the door: a session must never start for an agent that is
  // already revoked (or was never granted this server). The caller should
  // have refused earlier; if it did not, the session ends immediately with
  // the same machinery a mid-session revocation uses.
  if (deps.agent !== undefined && isRevokedFor(deps.agent.record, serverName)) {
    void endSession('revoked')
  } else {
    watch?.start()
  }

  return Object.freeze({
    close: (reason: SessionEndReason = 'closed') => endSession(reason),
    ended,
  })
}
