import type { ClientServerDirection } from '../journal/record.js'
import { classify } from '../protocol/classify.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageSink,
  type MessageVerdict,
} from '../transport/message.js'
import { createMessagePolicyGate, type MessagePolicyGate } from '../proxy/gate-core.js'
import {
  createDecisionProvenance,
  createDecisionWriter,
  isPromiseVerdict,
} from '../proxy/gate-helpers.js'
import { isRevokedFor, startAgentWatch, type AgentWatch } from './agent-watch.js'
import {
  AGENT_REVOCATION_POLL_INTERVAL_MS,
  AGENT_REVOKED_RULE,
  FORWARDED_ANSWER_GRACE_MS,
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
 * Teardown grace (M36 phase C): when the agent leaves (`client-ended`, or the
 * plane's own `closed`) while calls it sent are still running, the session
 * stops reading the client at once but keeps reading the server for up to
 * `FORWARDED_ANSWER_GRACE_MS` — each answer is journaled, and the gate marks
 * it `undelivered`; nothing reaches the client. What is still unanswered then
 * is journaled `unanswered` and counted to `onUnansweredCalls`. A server that
 * ended, or an agent revoked, gets no grace.
 *
 * This module owns lifecycle, not transports: sources/sinks arrive
 * constructed and are disposed here on end, but process/socket lifetimes
 * belong to the callers (`connect`/`serve`, Wave 4).
 */

export type {
  CreateSessionDeps,
  SessionAgent,
  SessionApprovals,
  SessionEndpoints,
  SessionEndReason,
  SessionHandle,
  SessionJournal,
} from './core-types.js'
import type { CreateSessionDeps, SessionEndReason, SessionHandle } from './core-types.js'

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
  /** The teardown grace: the server is still read (journaled, gated), the client is gone. */
  let isDraining = false
  /** Aborted when the server goes during the grace: nothing more can come (review M1). */
  const serverGone = new AbortController()

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
    sink: journal.sink,
    clientSink: client.sink,
    provenance,
    ...(watch !== null ? { agentScope: watch.scope } : {}),
    ...(deps.confirmInClient !== undefined ? { confirmInClient: deps.confirmInClient } : {}),
    ...(deps.heldCallProgress !== undefined ? { heldCallProgress: deps.heldCallProgress } : {}),
    ...(deps.toolUseAnswers !== undefined ? { toolUseAnswers: deps.toolUseAnswers } : {}),
    ...(deps.onRequestDropped !== undefined ? { onRequestDropped: deps.onRequestDropped } : {}),
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
    if (endedReason !== null && !(isDraining && direction === 'server→client')) return
    if (isBlankMessage(message)) {
      // Nothing reaches the client once the session ended, a blank line neither (review L1).
      if (endedReason === null) trackPending(sink.write(message))
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

  /**
   * The teardown grace for calls already sent (see the module doc): the agent
   * leaving gets it, a server that ended or an agent revoked does not.
   * Resolves to how many calls the server left unanswered.
   */
  async function settleForwarded(reason: SessionEndReason): Promise<number> {
    const isAgentGone = reason === 'client-ended' || reason === 'closed'
    try {
      if (!isAgentGone) return await gate.settleForwarded(0, reason)
      isDraining = true
      await gate.agentLeft()
      const graceMs = deps.forwardedAnswerGraceMs ?? FORWARDED_ANSWER_GRACE_MS
      return await gate.settleForwarded(graceMs, reason, serverGone.signal)
    } catch (error: unknown) {
      onError(error)
      return 0
    } finally {
      isDraining = false
    }
  }

  async function runEnd(reason: SessionEndReason): Promise<void> {
    watch?.stop()
    // Stop intake first: no new request may enter the gate after the end.
    // The server is still read through the grace, for answers already owed.
    client.source.dispose()
    const unanswered = await settleForwarded(reason)
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
    if (unanswered > 0) reportUnanswered(unanswered)
    deps.onSessionEnd?.(reason)
    settleEnded(reason)
  }

  function reportUnanswered(count: number): void {
    try {
      deps.onUnansweredCalls?.(count)
    } catch (error: unknown) {
      onError(error)
    }
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
    serverGone.abort()
    void endSession('server-ended')
  })
  server.source.onEnd(() => {
    serverGone.abort()
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

  function abandonRequest(requestBytes: Buffer): void {
    try {
      const message = classify(requestBytes.toString('utf8'))
      if (message.kind === 'request') gate.abandonRequest(message.id)
    } catch (error: unknown) {
      onError(error)
    }
  }

  return Object.freeze({
    close: (reason: SessionEndReason = 'closed') => endSession(reason),
    ended,
    abandonRequest,
  })
}
