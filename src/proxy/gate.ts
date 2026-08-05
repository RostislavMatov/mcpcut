import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { JsonRpcId } from '../protocol/classify.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide, type PolicyDecision } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { ApprovalWaiter } from '../policy/approvals/waiter.js'
import type { GrantKey, GrantRegistry } from '../policy/approvals/grants.js'
import type { ParsedToolCall } from '../protocol/mcp.js'
import type { GateFn, Verdict } from './pipeline.js'
import type { OrderedWriter } from './writer.js'
import type { SynthesizableId } from './synthesize.js'
import { createApprovalFlow, type GateApprovalQueue } from './gate-approvals.js'
import { createGateRouter } from './gate-router.js'
import { createToolCatalog } from './tool-catalog.js'
import {
  CATALOG_UNTRUSTED_RULE,
  DROP,
  FORWARD,
  GATE_ERROR_RULE,
  IDLESS_APPROVAL_RULE,
  QUARANTINE_RULE,
  argsHashOf,
  createAnswerGuard,
  createDecisionWriter,
  decisionInfoOf,
  denialBytesFor,
  idKeyOf,
  isPromiseVerdict,
  type CallFacts,
  type GateInventory,
  type GateSink,
} from './gate-helpers.js'

export type { GateInventory, GateSink } from './gate-helpers.js'
export type { GateApprovalQueue } from './gate-approvals.js'

/**
 * The semantic heart of mode B: one policy gate per proxied session.
 *
 * It sits between the two transport halves (`proxy/pipeline.ts` reads
 * frames, `proxy/writer.ts` writes them) and is the only place that knows
 * what a frame *means*: `classify` -> `protocol/mcp.ts` -> `policy/decide`
 * -> forward / drop / rewrite. With `protocol/mcp.ts` it is the whole
 * surface coupled to the MCP spec version: thin and replaceable by design.
 * The gate is split by responsibility — `gate-router.ts` (frame dispatch),
 * `gate-approvals.ts` (the require-approval branch), `tool-catalog.ts`
 * (tools/list observation/filtering) — with this module owning the shared
 * session state and the decide/apply core.
 *
 * Invariants this module owes the rest of the system:
 *  - **Exactly one outcome per request id.** Once a call has been answered
 *    locally with a synthetic error, that id is never forwarded to the
 *    server — not even by an approval that lands after the wait timed out.
 *  - **Only `tools/call` is gated — by method, not by message shape.** Any
 *    frame whose `method` is `tools/call` is decided, id or no id (C2/N1): a
 *    spec-violating id-less call is still routed through decide()/journal,
 *    never blindly forwarded as an ordinary notification. Every other
 *    notification, response, other method and unparseable frame is
 *    forwarded untouched, always.
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
  //
  // `inventoryLoaded` flips once `load()` has settled either way (HIGH/C4):
  // a `tools/call` decided while it is still false races an unhydrated
  // snapshot, where a persisted-quarantined tool would read back as
  // `stateOf === 'unknown'` and fall through to the defaults instead of
  // failing closed. The await is unconditional (re-review M1): even with
  // quarantine disabled, `catalogTrusted` — which only `load()` can set to
  // false for a corrupt store — is consulted by every decision, so a
  // front-loaded call must not race the stale trusted-by-default state.
  // The cost is one microtask on the first call of a session only.
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
  const outstanding = new Set<Promise<Verdict>>()
  /** Approval ids enqueued to disk that no operator has resolved yet (H6 teardown). */
  const enqueuedUnresolved = new Set<string>()

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

  const approvalFlow = createApprovalFlow({
    policy,
    serverName,
    sessionId: deps.sessionId,
    approvalQueue,
    approvalWaiter,
    grantRegistry,
    approvalsBaseDir,
    clock,
    writeDecision,
    settleJournal,
    answerLocally,
    answerGuard,
    enqueuedUnresolved,
    decideWithGrant: (facts, hasActiveGrant) => decide(decideInputOf(facts, hasActiveGrant)),
    applyAllow,
  })

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

  /**
   * Defense-in-depth fail-closed for an untrusted catalog (C3/C4). The pinned
   * `decide()` already forces this from the `catalogTrusted` input; enforcing
   * it here too means a failed/compromised inventory can never let a call
   * through even if the policy layer regresses. A no-op once the decision is
   * already non-allow for the untrusted state.
   */
  function enforceCatalogTrust(decision: PolicyDecision): PolicyDecision {
    if (decision.outcome !== 'allow') return decision
    if (inventory.isCatalogTrusted() && !inventoryLoadFailed) return decision
    return {
      outcome: 'deny',
      rule: CATALOG_UNTRUSTED_RULE,
      reason: 'tool catalog is untrusted (inventory observe/load failed); failing closed',
    }
  }

  function decideToolCall(call: ParsedToolCall): Verdict | Promise<Verdict> {
    const facts = factsOf(call)
    const grantKey: GrantKey = { serverName, toolName: facts.toolName, argsHash: facts.argsHash }
    const decision = enforceCatalogTrust(decide(decideInputOf(facts, grantRegistry.isGranted(grantKey))))

    if (decision.outcome === 'allow') return applyAllow(call, facts, decision)
    if (decision.outcome === 'deny') return applyDeny(call, facts, decision)
    // An id-less call has no return address: an approval could never deliver
    // it, yet its grant would still be minted and consumable by a later
    // id-bearing call — pure operator-fatigue cost with zero upside, so it
    // short-circuits to deny instead of enqueuing (re-review L4).
    if (call.id === null) {
      return applyDeny(call, facts, {
        outcome: 'deny',
        rule: IDLESS_APPROVAL_RULE,
        reason: 'id-less tools/call cannot receive an approval result; denying instead of enqueuing',
      })
    }
    return approvalFlow.requestApproval(call, facts, grantKey, decision)
  }

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

  const router = createGateRouter({
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
  })

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

  return {
    gateClientMessage: router.gateClientMessage,
    gateServerMessage: router.gateServerMessage,
    cancelPending,
  }
}
