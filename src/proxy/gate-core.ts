import type { JsonRpcId } from '../protocol/classify.js'
import type { PolicyDecision } from '../policy/decide.js'
import { WITHDRAW_REASON_DISCONNECTED } from '../policy/approvals/withdraw.js'
import { DEFAULT_CLIENT_CONFIRM_TIMEOUT_MS } from '../policy/constants.js'
import { toPolicyProvider } from '../policy/reload.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import { serverMessage } from '../transport/message.js'
import type { Verdict } from './pipeline.js'
import type { SynthesizableId } from './synthesize.js'
import { DEFAULT_HOLD_SCHEDULER } from './approval-hold.js'
import { createApprovalFlow } from './gate-approvals.js'
import { createClientConfirmer } from './client-confirm.js'
import { createGateDelivery } from './gate-delivery.js'
import { createGateGuard } from './gate-guard.js'
import { createToolUseAnswers } from './tool-use-answers.js'
import { createConfirmStep } from './gate-confirm.js'
import { createCallDecider } from './gate-call.js'
import { createDecideInputAssembler } from './gate-decide-input.js'
import { createGateRouter } from './gate-router.js'
import { createToolCatalog } from './tool-catalog.js'
import {
  DROP,
  FORWARD,
  GATE_ERROR_RULE,
  QUARANTINE_RULE,
  createAnswerGuard,
  createDecisionProvenance,
  createDecisionWriter,
  decisionInfoOf,
  denialBytesFor,
  idKeyOf,
  isPromiseVerdict,
  trimTrailingNewline,
  type CallFacts,
  type DecisionExtras,
  type DecisionProvenance,
} from './gate-helpers.js'

/**
 * The semantic heart of mode B: one policy gate per proxied session, at the
 * transport-neutral message level (M3).
 *
 * The gate consumes `McpMessage`s (`transport/message.ts`) and is the only
 * place that knows what a message *means*: `classify` -> `protocol/mcp.ts`
 * -> `policy/decide` -> forward / drop / rewrite. With `protocol/mcp.ts` it
 * is the whole surface coupled to the MCP spec version: thin and replaceable
 * by design. The stdio Frame world of M1/M2 reaches this core through the
 * adapter in `gate.ts`, which preserves the M2 byte-level contract exactly;
 * HTTP sessions (`session/core.ts`) feed messages in directly. The gate is
 * split by responsibility — `gate-router.ts` (message dispatch),
 * `gate-approvals.ts` (require-approval), `tool-catalog.ts` (tools/list) —
 * with this module owning the shared session state and the decide/apply
 * core. Byte conventions at this level: emitted verdict bytes and synthetic
 * answers are *content only*, no embedded framing (`messageToChunk`'s
 * contract) — the stdio adapter reattaches `\n`, HTTP sends them verbatim.
 *
 * Invariants this module owes the rest of the system:
 *  - **Exactly one outcome per request id.** Once a call has been answered
 *    locally with a synthetic error, that id is never forwarded to the
 *    server — not even by an approval that lands after the wait timed out.
 *  - **Only `tools/call` is gated — by method, not by message shape.** Any
 *    message whose `method` is `tools/call` is decided, id or no id (C2/N1):
 *    a spec-violating id-less call is still routed through decide()/journal,
 *    never blindly forwarded as an ordinary notification. Every other
 *    notification, response, other method and unparseable message is
 *    forwarded untouched, always.
 *  - **The agent dimension is opt-in and deny-first.** With an `agentScope`
 *    present, a tool outside the agent's grant matrix is denied before the
 *    whole M2 chain (`decide()`'s step 0) and hidden from `tools/list`;
 *    a request whose METHOD no grant can describe at all (`resources/*`,
 *    `prompts/*`, `completion/complete` — `AGENT_NON_GRANTABLE_METHODS`) is
 *    denied by the router before it reaches the server, so a tools grant is
 *    not a back door to the rest of the capability surface; and a
 *    `tools/list`-shaped response the gate never tracked is still filtered
 *    down to the grants. Without an `agentScope`, behavior is the M2 chain
 *    byte for byte.
 *  - **Fail closed on our own bugs.** Any unexpected error while deciding a
 *    `tools/call` denies the call; the same error on ordinary traffic
 *    forwards it (a gate defect must not break an unrelated session).
 *  - **Never rejects.** Every verdict promise settles (dispatchers treat a
 *    rejection as drop+report, but the gate does not rely on that).
 */

/** Cap on locally-answered ids remembered per session (exactly-one-outcome LRU); oldest first. */
const MAX_TRACKED_REQUEST_IDS = 10_000

export type {
  GateAnswerSink,
  MessagePolicyGate,
  MessagePolicyGateDeps,
  PendingApprovalNotice,
} from './gate-types.js'
import type { MessagePolicyGate, MessagePolicyGateDeps } from './gate-types.js'

function defaultOnError(error: unknown): void {
  process.stderr.write(`[gate] ${error instanceof Error ? error.message : String(error)}\n`)
}

export function createMessagePolicyGate(deps: MessagePolicyGateDeps): MessagePolicyGate {
  const { serverName, inventory, approvalQueue, approvalWaiter } = deps
  const agentScope = deps.agentScope
  const clock = deps.clock ?? Date.now
  const onError = deps.onError ?? defaultOnError
  // The rules are read through the provider on every decision (hot reload,
  // wave 2 of the policy-tool-rules-ui plan). Wiring-time configuration is
  // read ONCE from the policy in force at construction and does not reload:
  // `journal.failClosed` here, `approval.timeoutMs` in the approval flow
  // below, `quarantine.enabled` inside the inventory the caller built. Class
  // overrides are rules, so they go through a getter.
  const policy = toPolicyProvider(deps.policy)
  const classOverridesOf = () => policy.current().servers?.[serverName]?.classOverrides
  const failClosed = policy.current().journal.failClosed
  // Provenance for every decision record this gate writes (M5). The session
  // shares its own when it has one; otherwise it is built once here, which
  // also covers `denyOnGateError`: a gate-internal failure has resolved
  // nothing about the call, but the fingerprint of the rules in force
  // already exists and still lands on the record.
  const provenance: DecisionProvenance =
    deps.provenance ?? createDecisionProvenance(policy, agentScope)
  const writeDecision = createDecisionWriter({
    sink: deps.sink,
    sessionId: deps.sessionId,
    clock,
    provenance,
  })

  // Hydrate the persisted inventory snapshot once at session start, so
  // `stateOf` is authoritative before the first gated call. A failure here is
  // not swallowed: the inventory reflects it via `isCatalogTrusted()`, which
  // forces every subsequent `tools/call` to fail closed (C3/C4).
  //
  // `inventoryLoaded` flips once `load()` has settled either way (HIGH/C4):
  // a call decided while it is false races an unhydrated snapshot, where a
  // persisted-quarantined tool reads back `'unknown'` and falls through to
  // the defaults instead of failing closed. The await is unconditional
  // (re-review M1): even with quarantine disabled, `catalogTrusted` — which
  // only `load()` can set to false for a corrupt store — is consulted by
  // every decision. The cost is one microtask on a session's first call.
  //
  // `inventoryLoadFailed` is the gate's own record of a `load()` rejection
  // (re-review L3): the GateInventory contract says the inventory untrusts
  // itself on load failure, but the gate does not bet on that — a rejection
  // fails closed here even if `isCatalogTrusted()` still reports true.
  let inventoryLoaded = false
  let inventoryLoadFailed = false
  const inventoryLoadPromise: Promise<void> = Promise.resolve(inventory.load())
    .catch((error: unknown) => {
      inventoryLoadFailed = true
      onError(error)
    })
    .then(() => {
      inventoryLoaded = true
    })

  /** Exactly-one-outcome guard: LRU of answered ids plus a non-evicting in-flight burn set (M8). */
  const answerGuard = createAnswerGuard(MAX_TRACKED_REQUEST_IDS)

  /** Resolves once decision records are durable — but only when fail-closed. */
  function settleJournal(): Promise<void> {
    return failClosed ? deps.sink.flush() : Promise.resolve()
  }

  const catalog = createToolCatalog({
    policy,
    serverName,
    inventory,
    classOverridesOf,
    writeDecision,
    settleJournal,
    onError,
    ...(agentScope !== undefined
      ? { isGrantedToAgent: (tool: string) => agentScope.isGranted(tool) }
      : {}),
  })

  /**
   * Answers `id` locally and marks it as answered, so it can never also be
   * forwarded. A `null` id has no return address (a spec-violating
   * notification-style `tools/call`): the call is simply dropped. The `\n`
   * that `synthesize.ts` line-frames with is trimmed: framing belongs to
   * the transport sink, not to message content (stdio reattaches it).
   */
  async function answerLocally(id: JsonRpcId, build: (id: SynthesizableId) => Buffer): Promise<void> {
    if (id === null) return
    answerGuard.markAnswered(idKeyOf(id))
    await deps.clientSink.write(serverMessage(trimTrailingNewline(build(id))))
  }

  // Decide-input assembly (`gate-decide-input.ts`): pure functions of the
  // policy, inventory and agent scope. Built after the catalog because it
  // reads descriptors through it.
  const { factsOf, decideInputOf, enforceCatalogTrust } = createDecideInputAssembler({
    policy,
    serverName,
    inventory,
    ...(agentScope !== undefined ? { agentScope } : {}),
    classOverridesOf,
    descriptorOf: (toolName: string) => catalog.descriptorOf(toolName),
    hasInventoryLoadFailed: () => inventoryLoadFailed,
  })

  /** Stays synchronous unless fail-closed forces a flush: an allowed call must not be reordered. */
  /** `extras` carries the confirmation in the client that came first (`confirmedBy`, ADR-0019). */
  function applyAllow(
    call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision, extras: DecisionExtras = {},
  ): Verdict | Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'allow', decision.rule, extras), call.args)
    return failClosed ? deps.sink.flush().then(() => FORWARD) : FORWARD
  }

  async function applyDeny(call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision, detail?: string): Promise<Verdict> {
    const isQuarantined = decision.rule === QUARANTINE_RULE
    writeDecision(
      decisionInfoOf(facts, isQuarantined ? 'quarantined' : 'deny', decision.rule),
      call.args,
    )
    await settleJournal()
    await answerLocally(call.id, (id) =>
      denialBytesFor(id, { toolName: facts.toolName, serverName, rule: decision.rule, ...(detail !== undefined ? { detail } : {}) }),
    )
    return DROP
  }

  // ADR-0019: the client channel exists on the stdio paths (`wrap`, `connect`);
  // without it a call the policy makes the person confirm is refused.
  const confirmer =
    deps.confirmInClient === undefined
      ? undefined
      : createClientConfirmer({
          send: (message) => deps.clientSink.write(serverMessage(Buffer.from(JSON.stringify(message)))),
          clock,
          onError,
        })
  const confirmStep = createConfirmStep({
    policy,
    serverName,
    ...(agentScope !== undefined ? { agentName: agentScope.agentName } : {}),
    ...(confirmer !== undefined ? { confirmer } : {}),
    // Read once, like the approval flow's wait below. The admin's approval
    // holds with no limit by default (M36); a dialog does not.
    timeoutMs: policy.current().approval.timeoutMs ?? DEFAULT_CLIENT_CONFIRM_TIMEOUT_MS,
    writeDecision,
    settleJournal,
    answerLocally,
    answerGuard,
    clock,
    ...(deps.confirmInClient?.onNotice !== undefined ? { onNotice: deps.confirmInClient.onNotice } : {}),
  })

  // M36 phase C: the process's answers by tool use (shared by `serve`: a 404 resend comes on a
  // new session), under name AND creation time — a recreated agent of the same name is someone else.
  const answers = deps.toolUseAnswers ?? createToolUseAnswers({ clock })
  const scope = agentScope === undefined ? '' : `${agentScope.agentName}\u0001${agentScope.agentCreatedAt ?? ''}`

  const approvalFlow = createApprovalFlow({
    // Wiring-time snapshot on purpose: the flow reads only `approval.timeoutMs`,
    // which does not hot-reload (see above).
    policy: policy.current(),
    serverName,
    sessionId: deps.sessionId,
    // The agent's name rides the pending file and the pending decision
    // record, so an operator can see who is asking (M4).
    ...(agentScope !== undefined ? { agentName: agentScope.agentName } : {}),
    approvalQueue,
    approvalWaiter,
    clock,
    writeDecision,
    settleJournal,
    answerLocally,
    notifyClient: (bytes) => deps.clientSink.write(serverMessage(trimTrailingNewline(bytes))),
    ...(deps.heldCallProgress !== undefined ? { heldCallProgress: deps.heldCallProgress } : {}),
    holdScheduler: deps.holdScheduler ?? DEFAULT_HOLD_SCHEDULER,
    cancelReasonOf: (idKey) => router.cancelReasonOf(idKey),
    answerGuard,
    onError,
    ...(deps.onApprovalPending !== undefined ? { onApprovalPending: deps.onApprovalPending } : {}),
    onAgentGone: (call) => {
      // M39: a resend of this tool use will be marked as one.
      if (call.toolUseId !== undefined) answers.noteWithdrawn(scope, call.toolUseId, new Date(clock()).toISOString())
      deps.onRequestDropped?.(call.id) // S-L1: no answer will ever come for this id
    },
    enqueueExtrasOf: (call) => {
      const withdrawnAt = call.toolUseId === undefined ? undefined : answers.withdrawnAt(scope, call.toolUseId)
      return withdrawnAt !== undefined ? { resendOfWithdrawnAt: withdrawnAt } : {}
    },
  })

  const { guarded, track, awaitOutstanding } = createGateGuard({
    serverName, writeDecision, settleJournal, answerLocally, onError,
  })

  const delivery = createGateDelivery({ // resends of a tool use; what becomes of forwarded calls' answers
    scope,
    answers,
    clock,
    writeDecision,
    settleJournal,
    answerLocally,
    departureOf: (idKey) => router.departureOf(idKey),
    answerGuard,
    // Only where the client channel carries the gate's own notifications.
    ...(deps.heldCallProgress !== undefined
      ? { sendProgress: (bytes: Buffer) => deps.clientSink.write(serverMessage(trimTrailingNewline(bytes))) }
      : {}),
    holdScheduler: deps.holdScheduler ?? DEFAULT_HOLD_SCHEDULER,
    ...(deps.onRequestDropped !== undefined ? { onRequestDropped: deps.onRequestDropped } : {}),
    onError,
  })

  const { decideToolCall } = createCallDecider({
    policy,
    factsOf,
    decideInputOf,
    enforceCatalogTrust,
    provenance,
    applyAllow,
    applyDeny,
    requestApproval: approvalFlow.requestApproval,
    confirmStep,
    answerGuard,
    writeDecision,
    settleJournal,
    ...(deps.argsCheck !== undefined ? { argsCheck: deps.argsCheck } : {}),
    delivery,
  })

  /**
   * Entry point for every gated `tools/call` (id-bearing or id-less alike).
   * Awaits inventory hydration first, unconditionally (see the
   * `inventoryLoaded` doc above — `catalogTrusted` depends on `load()`
   * regardless of `quarantine.enabled`); a no-op once `load()` has settled,
   * which is the case for every call after the first.
   */
  function gateToolCall(call: ParsedToolCall): Verdict | Promise<Verdict> {
    if (!inventoryLoaded) {
      return inventoryLoadPromise.then(() => decideToolCall(call))
    }
    return decideToolCall(call)
  }

  const router = createGateRouter({
    ...(confirmer !== undefined ? { clientConfirmer: confirmer } : {}),
    onClientCancelled: (idKey, reason, kind) => {
      confirmStep.cancelByClient(idKey)
      delivery.departed(idKey, { reason, kind })
      return approvalFlow.withdrawByClient(idKey, reason)
    },
    onResponse: (idKey, raw) => delivery.observeAnswer(idKey, raw),
    serverName,
    writeDecision,
    settleJournal,
    answerLocally,
    answerGuard,
    catalog,
    onError,
    gateToolCall,
    guarded,
    track,
    // The same predicate the catalog gets. Its mere presence tells the router
    // this is an agent session, which is what makes routing deny the methods
    // no grant can cover and grant-filter an untracked catalog.
    ...(agentScope !== undefined
      ? { isGrantedToAgent: (tool: string) => agentScope.isGranted(tool) }
      : {}),
    // The method-grant dimension (M4 Task 6): lets the router open the
    // enumerated resources/prompts/completion methods per grant. Absent —
    // including on every M3-era scope — the router's denial is M3 unchanged.
    ...(agentScope?.methodGrants !== undefined ? { methodGrants: agentScope.methodGrants } : {}),
  })

  /** The agent is gone: nothing held may go out any more, and what was sent is owed to nobody. */
  async function agentLeft(): Promise<void> {
    delivery.agentLeft()
    confirmStep.withdrawAll()
    await approvalFlow.withdrawAll()
  }

  async function cancelPending(): Promise<void> {
    delivery.agentLeft()
    confirmStep.withdrawAll()
    // M36 (replacing H6's mark-expired): the agent is gone, so every held
    // call is withdrawn as `disconnected` — a resolution landing after
    // teardown is refused with that reason, and nothing is answered. Any wait
    // the withdrawal could not reach settles as a timeout below.
    await approvalFlow.withdrawAll()
    approvalWaiter.cancelAll()
    await awaitOutstanding()
  }

  return {
    gateClientMessage: router.gateClientMessage,
    gateServerMessage: router.gateServerMessage,
    cancelPending,
    agentLeft,
    clientInputEnded: () => approvalFlow.pokeHeld(),
    settleForwarded: (graceMs, reason, stop) => delivery.settle(graceMs, reason, stop),
    abandonRequest: (id) => {
      if (id !== null) router.abandonRequest(idKeyOf(id), WITHDRAW_REASON_DISCONNECTED)
    },
  }
}
