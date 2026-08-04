import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import {
  classify,
  type ClassifiedNotification,
  type ClassifiedRequest,
  type JsonRpcId,
} from '../protocol/classify.js'
import { isToolsListRequest, parseToolCall, type ParsedToolCall } from '../protocol/mcp.js'
import type { Frame } from '../protocol/split.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide, type PolicyDecision } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { ApprovalQueue } from '../policy/approvals/queue.js'
import type { ApprovalWaiter, WaitOutcome } from '../policy/approvals/waiter.js'
import { checkRecentApproval, type GrantKey, type GrantRegistry } from '../policy/approvals/grants.js'
import type { GateFn, Verdict } from './pipeline.js'
import type { OrderedWriter } from './writer.js'
import { approvalDeniedError, approvalTimeoutError, type SynthesizableId } from './synthesize.js'
import {
  ALREADY_ANSWERED_RULE,
  CATALOG_UNTRUSTED_RULE,
  DROP,
  DUPLICATE_RESPONSE_RULE,
  FORWARD,
  GATE_ERROR_RULE,
  MALFORMED_TOOLS_CALL_RULE,
  QUARANTINE_RULE,
  RESPONSE_TOOL_NAME,
  TOOLS_LIST_OVERFLOW_RULE,
  TOOLS_LIST_TOOL_NAME,
  UNPARSEABLE_CLIENT_FRAME_RULE,
  UNPARSEABLE_TOOL_NAME,
  argsHashOf,
  bookkeepingDecisionInfo,
  createAnswerGuard,
  createBoundedIdSet,
  createDecisionWriter,
  createToolCatalog,
  decisionInfoOf,
  denialBytesFor,
  idKeyOf,
  parseCancelledRequestId,
  recoverScalarId,
  unsafeClientFrameDecision,
  type CallFacts,
  type DecisionExtras,
  type GateInventory,
  type GateSink,
} from './gate-helpers.js'

export type { GateInventory, GateSink } from './gate-helpers.js'

/**
 * The semantic heart of mode B: one policy gate per proxied session.
 *
 * It sits between the two transport halves (`proxy/pipeline.ts` reads
 * frames, `proxy/writer.ts` writes them) and is the only place that knows
 * what a frame *means*: `classify` -> `protocol/mcp.ts` -> `policy/decide`
 * -> forward / drop / rewrite. With `protocol/mcp.ts` it is the whole
 * surface coupled to the MCP spec version: thin and replaceable by design.
 *
 * Invariants this module owes the rest of the system:
 *  - **Exactly one outcome per request id.** Once a call has been answered
 *    locally with a synthetic error, that id is never forwarded to the
 *    server — not even by an approval that lands after the wait timed out.
 *  - **Only `tools/call` is gated.** Notifications, responses, other
 *    methods and unparseable frames are forwarded untouched, always.
 *  - **Fail closed on our own bugs.** Any unexpected error while deciding a
 *    `tools/call` denies the call; the same error on ordinary traffic
 *    forwards it (a gate defect must not break an unrelated session).
 *  - **Never rejects.** Every verdict promise settles; the pipeline treats a
 *    rejection as drop+report, but the gate does not rely on that.
 */

/** Subdirectory `approvals/queue.ts` uses under the journal dir. */
const APPROVALS_SUBDIR = 'approvals'

/**
 * Cap on locally-answered request ids remembered per session (the LRU half of
 * the exactly-one-outcome guard); oldest entries are forgotten first.
 */
const MAX_TRACKED_REQUEST_IDS = 10_000

/**
 * Cap on concurrently-tracked outstanding `tools/list` request ids (M9).
 * Deliberately far above any realistic client's concurrent `tools/list`
 * fan-out, so a normal session never evicts and every `tools/list` response
 * is matched and observed; an eviction past this bound is journaled.
 */
const MAX_TRACKED_TOOLS_LIST_IDS = 65_536

/** The subset of `ApprovalQueue` the gate needs (also satisfies the waiter's `ResolutionSource`). */
export type GateApprovalQueue = Pick<ApprovalQueue, 'enqueue' | 'readResolution' | 'markExpired'>
/** The subset of `OrderedWriter` the gate needs to answer a client locally. */
export type GateWriter = Pick<OrderedWriter, 'writeMessage'>

export interface PolicyGateDeps {
  readonly policy: Policy
  readonly serverName: string
  readonly sessionId: string
  readonly inventory: GateInventory
  readonly approvalQueue: GateApprovalQueue
  readonly approvalWaiter: ApprovalWaiter
  readonly grantRegistry: GrantRegistry
  readonly sink: GateSink
  /** Writes synthetic responses back to the client. */
  readonly clientWriter: GateWriter
  /**
   * Root of the approvals queue on disk, for the late-approval fallback.
   * Defaults to `JOURNAL_DIR/approvals`; must match `approvalQueue`'s own.
   */
  readonly approvalsBaseDir?: string
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
  /** Reports gate-internal failures. Defaults to one line on stderr. */
  readonly onError?: (error: unknown) => void
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

function defaultOnError(error: unknown): void {
  process.stderr.write(`[gate] ${error instanceof Error ? error.message : String(error)}\n`)
}

function isPromiseVerdict(outcome: Verdict | Promise<Verdict>): outcome is Promise<Verdict> {
  return typeof (outcome as Partial<Promise<Verdict>>).then === 'function'
}

/** Context carried through one require-approval flow. */
interface ApprovalContext {
  readonly call: ParsedToolCall
  readonly facts: CallFacts
  readonly grantKey: GrantKey
  readonly rule: string
  readonly approvalId: string
  readonly startedAtMs: number
  readonly outcome: WaitOutcome
}

export function createPolicyGate(deps: PolicyGateDeps): PolicyGate {
  const { policy, serverName, inventory, grantRegistry, approvalQueue, approvalWaiter } = deps
  const clock = deps.clock ?? Date.now
  const onError = deps.onError ?? defaultOnError
  const approvalsBaseDir = deps.approvalsBaseDir ?? join(JOURNAL_DIR, APPROVALS_SUBDIR)
  const classOverrides = policy.servers?.[serverName]?.classOverrides
  const failClosed = policy.journal.failClosed
  const writeDecision = createDecisionWriter({ sink: deps.sink, sessionId: deps.sessionId, clock })

  // Hydrate the persisted inventory snapshot once at session start, so
  // `stateOf` is authoritative before the first gated call. A failure here is
  // not swallowed: the inventory reflects it via `isCatalogTrusted()`, which
  // forces every subsequent `tools/call` to fail closed (C3/C4).
  void Promise.resolve(inventory.load()).catch((error: unknown) => onError(error))

  const pendingToolsListIds = createBoundedIdSet(MAX_TRACKED_TOOLS_LIST_IDS, (evicted) => {
    writeDecision(bookkeepingDecisionInfo(serverName, TOOLS_LIST_OVERFLOW_RULE, TOOLS_LIST_TOOL_NAME, evicted))
  })
  /** Exactly-one-outcome guard: LRU of answered ids plus a non-evicting in-flight burn set (M8). */
  const answerGuard = createAnswerGuard(MAX_TRACKED_REQUEST_IDS)
  const outstanding = new Set<Promise<Verdict>>()
  /** Approval ids enqueued to disk that no operator has resolved yet (H6 teardown). */
  const enqueuedUnresolved = new Set<string>()
  /** In-flight tool-call verdicts keyed by request id, so a cancellation can queue behind them (TS-M2). */
  const verdictsByRequestId = new Map<string, Promise<Verdict>>()

  /** Resolves once decision records are durable — but only when fail-closed. */
  function settleJournal(): Promise<void> {
    return failClosed ? deps.sink.flush() : Promise.resolve()
  }

  const catalog = createToolCatalog({
    policy,
    serverName,
    inventory,
    classOverrides,
    writeDecision,
    settleJournal,
    onError,
  })

  /**
   * Answers `id` locally and marks it as answered, so it can never also be
   * forwarded. A `null` id has no return address (a spec-violating
   * notification-style `tools/call`): the call is simply dropped.
   */
  async function answerLocally(id: JsonRpcId, build: (id: SynthesizableId) => Buffer): Promise<void> {
    if (id === null) return
    answerGuard.markAnswered(idKeyOf(id))
    await deps.clientWriter.writeMessage(build(id))
  }

  /**
   * Return type is inferred (not annotated `DecideInput`) so the two
   * catalog-trust fields the pinned `decide()` requires can be supplied
   * without an excess-property error while that shared type lands. Both are
   * read straight from the inventory, per the pinned contract.
   */
  function decideInputOf(facts: CallFacts, hasActiveGrant: boolean) {
    return {
      policy,
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      quarantineState: facts.quarantineState,
      hasActiveGrant,
      catalogObserved: inventory.hasObservedCatalog(),
      catalogTrusted: inventory.isCatalogTrusted(),
    }
  }

  /** Resolves class, quarantine state and args fingerprint for one call. Fails closed by throwing. */
  function factsOf(call: ParsedToolCall): CallFacts {
    return {
      serverName,
      toolName: call.toolName,
      toolClass: classifyTool(catalog.descriptorOf(call.toolName), classOverrides),
      quarantineState: inventory.stateOf(call.toolName),
      argsHash: argsHashOf(call.args),
    }
  }

  /** Stays synchronous unless fail-closed forces a flush: an allowed call must not be reordered. */
  function applyAllow(call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision): Verdict | Promise<Verdict> {
    writeDecision(decisionInfoOf(facts, 'allow', decision.rule), call.args)
    return failClosed ? deps.sink.flush().then(() => FORWARD) : FORWARD
  }

  async function applyDeny(call: ParsedToolCall, facts: CallFacts, decision: PolicyDecision): Promise<Verdict> {
    const isQuarantined = decision.rule === QUARANTINE_RULE
    writeDecision(
      decisionInfoOf(facts, isQuarantined ? 'quarantined' : 'deny', decision.rule),
      call.args,
    )
    await settleJournal()
    await answerLocally(call.id, (id) =>
      denialBytesFor(id, { toolName: facts.toolName, serverName, rule: decision.rule }),
    )
    return DROP
  }

  /**
   * Enqueues a human approval and returns a verdict promise the pipeline
   * keeps flowing behind: later frames are read, gated and written while
   * this one waits (head-of-line blocking is deliberately rejected).
   */
  async function requestApproval(
    call: ParsedToolCall,
    facts: CallFacts,
    grantKey: GrantKey,
    decision: PolicyDecision,
  ): Promise<Verdict> {
    const lateGrant = await resolveLateApproval(call, facts, grantKey)
    if (lateGrant !== null) return lateGrant

    const startedAtMs = clock()
    // The pending file's expiry must cover the GRANT window, not the short
    // wait: the agent's call unblocks after `approval.timeoutMs`, but an
    // operator may still approve-for-retry within `approval.grantTtlMs`
    // (>> timeoutMs). A time-aware `resolve()` downgrades an approval landing
    // past `expiresAt` to `expired`, so `expiresAt` is derived from the grant
    // window here; the short wait timeout is applied separately below.
    const { approvalId } = await approvalQueue.enqueue({
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      args: call.args,
      sessionId: deps.sessionId,
      timeoutMs: policy.approval.grantTtlMs,
    })
    enqueuedUnresolved.add(approvalId)
    writeDecision(
      decisionInfoOf(facts, 'require-approval-pending', decision.rule, { approvalId }),
      call.args,
    )
    await settleJournal()

    // Mark this id as having an in-flight approval wait, so if it is answered
    // locally in the meantime (its own timeout, or a concurrent reuse) the
    // exactly-one-outcome burn survives even a 10k-id LRU flood (M8).
    const waitKey = call.id !== null ? idKeyOf(call.id) : null
    if (waitKey !== null) answerGuard.beginWait(waitKey)
    try {
      const outcome = await approvalWaiter.wait(approvalQueue, approvalId, policy.approval.timeoutMs)
      const ctx = { call, facts, grantKey, rule: decision.rule, approvalId, startedAtMs, outcome }
      return await finishApproval(ctx)
    } finally {
      if (waitKey !== null) answerGuard.endWait(waitKey)
    }
  }

  /**
   * Disk fallback for an operator who approved an identical call after its
   * wait already timed out: the retry passes on that approval instead of
   * prompting a second time. Only consulted on the require-approval path —
   * an allowed call never pays for this I/O.
   */
  async function resolveLateApproval(call: ParsedToolCall, facts: CallFacts, grantKey: GrantKey): Promise<Verdict | null> {
    const approved = await checkRecentApproval(approvalsBaseDir, {
      ...grantKey,
      ttlMs: policy.approval.grantTtlMs,
      clock,
    })
    if (!approved) return null
    grantRegistry.grant(grantKey, policy.approval.grantTtlMs)
    const decision = decide(decideInputOf(facts, true))
    return decision.outcome === 'allow' ? await applyAllow(call, facts, decision) : null
  }

  async function finishApproval(ctx: ApprovalContext): Promise<Verdict> {
    const extras: DecisionExtras = { approvalId: ctx.approvalId, latencyMs: clock() - ctx.startedAtMs }
    if (ctx.outcome === 'approved') return await finishApproved(ctx, extras)

    const isDenied = ctx.outcome === 'denied'
    // An operator denial resolves the approval; a plain timeout does not (a
    // late approval may still land), so only the former stops it from being
    // marked expired at session teardown (H6).
    if (isDenied) enqueuedUnresolved.delete(ctx.approvalId)
    const toolName = ctx.facts.toolName
    writeDecision(
      decisionInfoOf(ctx.facts, isDenied ? 'denied-by-operator' : 'timeout', ctx.rule, extras),
      ctx.call.args,
    )
    await settleJournal()
    await answerLocally(ctx.call.id, (id) =>
      isDenied
        ? approvalDeniedError(id, { toolName })
        : approvalTimeoutError(id, { toolName, approvalId: ctx.approvalId }),
    )
    return DROP
  }

  /**
   * The guard is a flag, not a hope: an approval racing an already-delivered
   * timeout error must never reach the server after it.
   */
  async function finishApproved(ctx: ApprovalContext, extras: DecisionExtras): Promise<Verdict> {
    enqueuedUnresolved.delete(ctx.approvalId)
    if (ctx.call.id !== null && answerGuard.isAnswered(idKeyOf(ctx.call.id))) {
      writeDecision(decisionInfoOf(ctx.facts, 'deny', ALREADY_ANSWERED_RULE, extras), ctx.call.args)
      await settleJournal()
      return DROP
    }
    grantRegistry.grant(ctx.grantKey, policy.approval.grantTtlMs)
    writeDecision(decisionInfoOf(ctx.facts, 'approved', ctx.rule, extras), ctx.call.args)
    await settleJournal()
    return FORWARD
  }

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

  // -- client -> server --------------------------------------------------

  /**
   * Defense-in-depth fail-closed for an untrusted catalog (C3/C4). The pinned
   * `decide()` already forces this from the `catalogTrusted` input; enforcing
   * it here too means a failed/compromised inventory can never let a call
   * through even if the policy layer regresses. A no-op once the decision is
   * already non-allow for the untrusted state.
   */
  function enforceCatalogTrust(decision: PolicyDecision): PolicyDecision {
    if (inventory.isCatalogTrusted() || decision.outcome !== 'allow') return decision
    return {
      outcome: 'deny',
      rule: CATALOG_UNTRUSTED_RULE,
      reason: 'tool catalog is untrusted (inventory observe/load failed); failing closed',
    }
  }

  function gateToolCall(call: ParsedToolCall): Verdict | Promise<Verdict> {
    const facts = factsOf(call)
    const grantKey: GrantKey = { serverName, toolName: facts.toolName, argsHash: facts.argsHash }
    const decision = enforceCatalogTrust(decide(decideInputOf(facts, grantRegistry.isGranted(grantKey))))

    if (decision.outcome === 'allow') return applyAllow(call, facts, decision)
    if (decision.outcome === 'deny') return applyDeny(call, facts, decision)
    return requestApproval(call, facts, grantKey, decision)
  }

  /**
   * Fail-closed default for the client->server direction: a frame we cannot
   * positively identify as safe is dropped, the drop is journaled, and — if a
   * scalar id is recoverable — the client is answered with a denial it can
   * correlate. A frame with no recoverable id is simply dropped (C2).
   */
  async function denyUnsafeClientFrame(rule: string, id: JsonRpcId): Promise<Verdict> {
    try {
      writeDecision(unsafeClientFrameDecision(serverName, rule))
      await settleJournal()
      await answerLocally(id, (sid) =>
        denialBytesFor(sid, { toolName: UNPARSEABLE_TOOL_NAME, serverName, rule }),
      )
    } catch (error: unknown) {
      onError(error)
    }
    return DROP
  }

  /** Records an in-flight tool-call verdict by request id, so a cancellation can queue behind it (TS-M2). */
  function recordVerdict(id: JsonRpcId, verdict: Verdict | Promise<Verdict>): Verdict | Promise<Verdict> {
    if (id === null || !isPromiseVerdict(verdict)) return verdict
    const key = idKeyOf(id)
    const settled = Promise.resolve(verdict)
    verdictsByRequestId.set(key, settled)
    void settled.finally(() => {
      if (verdictsByRequestId.get(key) === settled) verdictsByRequestId.delete(key)
    })
    return verdict
  }

  function gateClientRequest(msg: ClassifiedRequest): Verdict | Promise<Verdict> {
    if (msg.method !== 'tools/call') {
      // The only non-tools/call request we care about is tools/list, whose id
      // we track so its response can be observed. Everything else forwards.
      if (isToolsListRequest(msg)) pendingToolsListIds.add(idKeyOf(msg.id))
      return FORWARD
    }
    const call = parseToolCall(msg)
    if (call === null) return denyUnsafeClientFrame(MALFORMED_TOOLS_CALL_RULE, msg.id)
    return recordVerdict(call.id, track(guarded(call, () => gateToolCall(call))))
  }

  function gateClientNotification(msg: ClassifiedNotification): Verdict | Promise<Verdict> {
    if (msg.method !== 'notifications/cancelled') return FORWARD
    const requestId = parseCancelledRequestId(msg.raw)
    if (requestId === null) return FORWARD
    const pending = verdictsByRequestId.get(idKeyOf(requestId))
    if (pending === undefined) return FORWARD
    // Order the cancellation strictly behind the request it cancels: the
    // server must see the tools/call before its cancellation to correlate
    // them, so flush it only after that request's verdict settles (TS-M2).
    return track(pending.then(() => FORWARD, () => FORWARD))
  }

  function gateClientMessage(frame: Frame): Verdict | Promise<Verdict> {
    const text = frame.bytes.toString('utf8')
    const msg = classify(text)
    // Fail closed: FORWARD only frames positively identified as safe.
    switch (msg.kind) {
      case 'notification':
        return gateClientNotification(msg)
      case 'response':
        return FORWARD
      case 'request':
        return gateClientRequest(msg)
      case 'invalid':
        return denyUnsafeClientFrame(UNPARSEABLE_CLIENT_FRAME_RULE, recoverScalarId(text))
    }
  }

  // -- server -> client --------------------------------------------------

  function gateServerMessage(frame: Frame): Verdict | Promise<Verdict> {
    try {
      const msg = classify(frame.bytes.toString('utf8'))
      // A server->client frame can never execute a tool, so an invalid or
      // non-response frame keeps forwarding untouched (unlike the client
      // direction, which fails closed).
      if (msg.kind !== 'response') return FORWARD

      const key = idKeyOf(msg.id)
      if (pendingToolsListIds.delete(key)) return catalog.handleResponse(msg)
      if (answerGuard.isAnswered(key)) {
        // The client reused an id we already answered: forward it as-is, and
        // leave a trace for whoever has to explain the duplicate later.
        writeDecision(
          bookkeepingDecisionInfo(serverName, DUPLICATE_RESPONSE_RULE, RESPONSE_TOOL_NAME, msg.id),
          { rpcId: msg.id },
        )
      }
      return FORWARD
    } catch (error: unknown) {
      onError(error)
      return FORWARD
    }
  }

  /**
   * Runs one tool call's decision path so that neither a synchronous throw
   * nor a rejected promise can escape: both fail closed (deny + drop). The
   * synchronous shape is preserved when `produce` answers synchronously, so
   * an allowed call is not reordered merely for having been guarded.
   */
  function guarded(call: ParsedToolCall, produce: () => Verdict | Promise<Verdict>): Verdict | Promise<Verdict> {
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
  }

  /** Remembers an in-flight verdict so `cancelPending()` can wait it out. */
  function track(work: Verdict | Promise<Verdict>): Verdict | Promise<Verdict> {
    if (!isPromiseVerdict(work)) return work
    outstanding.add(work)
    void work.finally(() => outstanding.delete(work))
    return work
  }

  async function cancelPending(): Promise<void> {
    approvalWaiter.cancelAll()
    await Promise.allSettled(Array.from(outstanding))
    // H6: every approval we enqueued but no operator resolved is marked
    // expired on disk, so a resolution landing after teardown is refused and
    // cannot leave a reusable grant for a session that no longer exists.
    const unresolved = Array.from(enqueuedUnresolved)
    enqueuedUnresolved.clear()
    await Promise.allSettled(unresolved.map((id) => approvalQueue.markExpired(id)))
  }

  return { gateClientMessage, gateServerMessage, cancelPending }
}
