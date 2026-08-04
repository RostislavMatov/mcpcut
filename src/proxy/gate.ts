import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { classify, type JsonRpcId } from '../protocol/classify.js'
import { isToolsListRequest, parseToolCall, type ParsedToolCall } from '../protocol/mcp.js'
import type { Frame } from '../protocol/split.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide, type DecideInput, type PolicyDecision } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { ApprovalQueue } from '../policy/approvals/queue.js'
import type { ApprovalWaiter, WaitOutcome } from '../policy/approvals/waiter.js'
import { checkRecentApproval, type GrantKey, type GrantRegistry } from '../policy/approvals/grants.js'
import type { GateFn, Verdict } from './pipeline.js'
import type { OrderedWriter } from './writer.js'
import { approvalDeniedError, approvalTimeoutError, type SynthesizableId } from './synthesize.js'
import {
  ALREADY_ANSWERED_RULE,
  DROP,
  DUPLICATE_RESPONSE_RULE,
  FORWARD,
  GATE_ERROR_RULE,
  QUARANTINE_RULE,
  RESPONSE_TOOL_NAME,
  argsHashOf,
  bookkeepingDecisionInfo,
  createBoundedIdSet,
  createDecisionWriter,
  createToolCatalog,
  decisionInfoOf,
  denialBytesFor,
  idKeyOf,
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
 * Cap on locally-answered / outstanding `tools/list` request ids remembered
 * per session; oldest entries are forgotten first. See `createBoundedIdSet`.
 */
const MAX_TRACKED_REQUEST_IDS = 10_000

/** The subset of `ApprovalQueue` the gate needs (also satisfies the waiter's `ResolutionSource`). */
export type GateApprovalQueue = Pick<ApprovalQueue, 'enqueue' | 'readResolution'>
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

  const pendingToolsListIds = createBoundedIdSet(MAX_TRACKED_REQUEST_IDS)
  const answeredLocally = createBoundedIdSet(MAX_TRACKED_REQUEST_IDS)
  const outstanding = new Set<Promise<Verdict>>()

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
    answeredLocally.add(idKeyOf(id))
    await deps.clientWriter.writeMessage(build(id))
  }

  function decideInputOf(facts: CallFacts, hasActiveGrant: boolean): DecideInput {
    return {
      policy,
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      quarantineState: facts.quarantineState,
      hasActiveGrant,
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
    const { approvalId } = await approvalQueue.enqueue({
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      args: call.args,
      sessionId: deps.sessionId,
      timeoutMs: policy.approval.timeoutMs,
    })
    writeDecision(
      decisionInfoOf(facts, 'require-approval-pending', decision.rule, { approvalId }),
      call.args,
    )
    await settleJournal()

    const outcome = await approvalWaiter.wait(approvalQueue, approvalId, policy.approval.timeoutMs)
    const ctx = { call, facts, grantKey, rule: decision.rule, approvalId, startedAtMs, outcome }
    return await finishApproval(ctx)
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
    if (ctx.call.id !== null && answeredLocally.has(idKeyOf(ctx.call.id))) {
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

  function gateToolCall(call: ParsedToolCall): Verdict | Promise<Verdict> {
    const facts = factsOf(call)
    const grantKey: GrantKey = { serverName, toolName: facts.toolName, argsHash: facts.argsHash }
    const decision = decide(decideInputOf(facts, grantRegistry.isGranted(grantKey)))

    if (decision.outcome === 'allow') return applyAllow(call, facts, decision)
    if (decision.outcome === 'deny') return applyDeny(call, facts, decision)
    return requestApproval(call, facts, grantKey, decision)
  }

  function gateClientMessage(frame: Frame): Verdict | Promise<Verdict> {
    try {
      const msg = classify(frame.bytes.toString('utf8'))
      if (msg.kind !== 'request') return FORWARD
      if (isToolsListRequest(msg)) {
        pendingToolsListIds.add(idKeyOf(msg.id))
        return FORWARD
      }
      // A malformed tools/call is the server's to reject, not ours to gate.
      const call = parseToolCall(msg)
      return call === null ? FORWARD : track(guarded(call, () => gateToolCall(call)))
    } catch (error: unknown) {
      // Only classification/parsing reaches here, before we know it is a
      // tool call at all: ordinary traffic keeps flowing.
      onError(error)
      return FORWARD
    }
  }

  // -- server -> client --------------------------------------------------

  function gateServerMessage(frame: Frame): Verdict | Promise<Verdict> {
    try {
      const msg = classify(frame.bytes.toString('utf8'))
      if (msg.kind !== 'response') return FORWARD

      const key = idKeyOf(msg.id)
      if (pendingToolsListIds.delete(key)) return catalog.handleResponse(msg)
      if (answeredLocally.has(key)) {
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
  }

  return { gateClientMessage, gateServerMessage, cancelPending }
}
