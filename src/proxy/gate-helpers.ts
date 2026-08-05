import { buildDecisionRecord } from '../journal/decision.js'
import type { DecisionInfo, PolicyOutcome, QuarantineState, ToolClass } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide } from '../policy/decide.js'
import { canonicalJson, sha256Hex } from '../policy/hash.js'
import type { Policy } from '../policy/schema.js'
import type { ClassifiedMessage, JsonRpcId } from '../protocol/classify.js'
import { parseToolCallParams, parseToolsListResult, type ParsedToolCall, type ToolDescriptor } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import { denialError, quarantinedError, type SynthesizableId } from './synthesize.js'
import { filterToolsListResult } from './tools-filter.js'

/**
 * Supporting cast for the session policy gate (`proxy/gate.ts`): small pure
 * helpers, plus the server-side tool-catalog half of the gate
 * (`createToolCatalog`). Split out purely to keep `gate.ts` focused on the
 * client-side decision flow — the two halves share only the decision writer
 * and the policy itself.
 */

/** Shared, frozen verdicts: the gate returns these by identity, never a fresh object. */
export const FORWARD: Verdict = Object.freeze({ action: 'forward' as const })
export const DROP: Verdict = Object.freeze({ action: 'drop' as const })

/** `rule` value `decide()` reports when quarantine is what blocked a call. */
export const QUARANTINE_RULE = 'quarantine'
/** `rule` recorded when the gate itself failed and closed the call down. */
export const GATE_ERROR_RULE = 'gate-error'
/** `rule` recorded when an approval landed on an id the gate already answered. */
export const ALREADY_ANSWERED_RULE = 'already-answered-locally'
/** `rule` recorded when the server answered an id the gate had answered locally. */
export const DUPLICATE_RESPONSE_RULE = 'duplicate-response-warning'
/** `rule` recorded when a client frame could not be positively identified as safe and was dropped (C2). */
export const UNPARSEABLE_CLIENT_FRAME_RULE = 'unparseable-client-frame'
/** `rule` recorded when a `tools/call` request could not be parsed into a call and was dropped (C2). */
export const MALFORMED_TOOLS_CALL_RULE = 'malformed-tools-call'

/** An id-less `tools/call` that resolved to require-approval: denied instead of enqueued (re-review L4). */
export const IDLESS_APPROVAL_RULE = 'idless-require-approval'
/** `rule` recorded when a `tools/list` observation failed or the catalog is untrusted (C3/C4). */
export const INVENTORY_UNAVAILABLE_RULE = 'inventory-unavailable'
/** `rule` recorded when a call is failed closed because the tool catalog is untrusted (C3/C4). */
export const CATALOG_UNTRUSTED_RULE = 'catalog-untrusted'
/** `rule` recorded when the outstanding `tools/list` id tracker had to evict an id (M9). */
export const TOOLS_LIST_OVERFLOW_RULE = 'tools-list-tracking-overflow'
/** `toolName` stamped on a record about a client frame with no recoverable tool identity. */
export const UNPARSEABLE_TOOL_NAME = '<unparseable>'
/** `rule` of the decision record holding the catalog exactly as the server sent it. */
export const TOOLS_LIST_ORIGINAL_RULE = 'toolsList.original'
/** `rule` of the decision record holding the catalog as the client actually saw it. */
export const TOOLS_LIST_FILTERED_RULE = 'toolsList.filtered'
/** `toolName` stamped on the two `tools/list` bookkeeping records. */
export const TOOLS_LIST_TOOL_NAME = 'tools/list'
/** `toolName` stamped on a duplicate-response bookkeeping record (no tool involved). */
export const RESPONSE_TOOL_NAME = '<response>'

/**
 * A JSON-RPC id is `string | number | null`, and numeric `1` must never
 * collide with string `"1"` — the same type-qualified key discipline
 * `journal/record.ts` uses for request correlation.
 */
export function idKeyOf(id: JsonRpcId): string {
  return `${typeof id} ${String(id)}`
}

/** Everything the gate has resolved about one tool call before deciding it. */
export interface CallFacts {
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly quarantineState: QuarantineState
  readonly argsHash: string
}

/** Optional per-outcome fields that only some decision records carry. */
export interface DecisionExtras {
  readonly approvalId?: string
  readonly latencyMs?: number
}

/** Assembles the `DecisionInfo` for one decided call. */
export function decisionInfoOf(
  facts: CallFacts,
  outcome: PolicyOutcome,
  rule: string,
  extras: DecisionExtras = {},
): DecisionInfo {
  return { ...facts, outcome, rule, ...extras }
}

/**
 * `DecisionInfo` for a record about something that is not a gated tool call
 * (a `tools/list` rewrite, a duplicate response). No call was blocked, so the
 * outcome is `allow` and the class/state fields carry the least alarming
 * values available; `argsHash` fingerprints `subject`, which is what makes
 * two otherwise identical bookkeeping records tell each other apart.
 */
export function bookkeepingDecisionInfo(
  serverName: string,
  rule: string,
  toolName: string,
  subject: unknown,
): DecisionInfo {
  return {
    outcome: 'allow',
    rule,
    serverName,
    toolName,
    toolClass: 'read',
    quarantineState: 'unknown',
    argsHash: sha256Hex(canonicalJson(subject)),
  }
}

/**
 * Fingerprint of a call's arguments, used as the grant key and stored on
 * every decision record. `undefined` and an explicit `null` hash the same
 * way, matching `approvals/queue.ts`'s own hashing of the same arguments.
 */
export function argsHashOf(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? null))
}

/** The subset of `JournalSink` the gate needs; lets tests inject a minimal fake. */
export type GateSink = Pick<JournalSink, 'write' | 'flush'>

/** Outcome buckets of one `observeToolsList`, plus a `failed` flag; see `GateInventory`. */
export interface GateObserveResult {
  readonly known: readonly string[]
  readonly new: readonly string[]
  readonly changed: readonly string[]
  /** `true` when the store update itself failed (disk error / corrupt store); never thrown. */
  readonly failed: boolean
}

/**
 * The inventory contract the gate consumes. Defined structurally (rather than
 * `Pick<Inventory>`) so the gate is decoupled from the concrete inventory
 * module: it depends only on these five methods, exactly as pinned by the
 * cross-agent interface. `stateOf` is authoritative once `load()` has run;
 * `observeToolsList` never throws (it reports failure via `failed`);
 * `isCatalogTrusted()` goes false on an observe/load failure, at which point
 * every subsequent `tools/call` must fail closed at the call level.
 */
export interface GateInventory {
  /** Hydrates the in-memory snapshot from the persisted store; call once at session start. */
  load(): Promise<void>
  /** Never throws; `failed:true` means the store update itself failed. */
  observeToolsList(tools: readonly ToolDescriptor[]): Promise<GateObserveResult>
  /** Synchronous, authoritative quarantine state; `'unknown'` only for never-seen names. */
  stateOf(toolName: string): QuarantineState
  /** True once ≥1 `observeToolsList` has been processed (even if it failed). */
  hasObservedCatalog(): boolean
  /** False if the latest observe returned `failed:true` or `load()` hit a corrupt/unavailable store. */
  isCatalogTrusted(): boolean
}

/**
 * Best-effort shallow parse of a raw JSON-RPC line to recover a scalar `id`,
 * so a rejected/unparseable client frame can still be answered with a denial
 * the client can correlate (C2). Returns `null` when no scalar id is
 * recoverable — a top-level batch array, a non-scalar id, or non-JSON — in
 * which case the frame is simply dropped without a synthetic reply.
 */
export function recoverScalarId(raw: string): JsonRpcId {
  const value = tryParse(raw)
  if (!isPlainRecord(value)) return null
  const id = value['id']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/**
 * Extracts the scalar `params.requestId` of a `notifications/cancelled` line,
 * so the client gate can order the cancellation strictly behind the request
 * it cancels (TS-M2). `null` when absent or non-scalar.
 */
export function parseCancelledRequestId(raw: string): JsonRpcId {
  const value = tryParse(raw)
  if (!isPlainRecord(value)) return null
  const params = value['params']
  if (!isPlainRecord(params)) return null
  const requestId = params['requestId']
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null
}

/**
 * `DecisionInfo` for a client frame the gate refused to forward because it
 * could not positively identify it as safe (C2). The most alarming
 * class/state values are stamped on it, and it always denies.
 */
export function unsafeClientFrameDecision(serverName: string, rule: string): DecisionInfo {
  return {
    outcome: 'deny',
    rule,
    serverName,
    toolName: UNPARSEABLE_TOOL_NAME,
    toolClass: 'destructive',
    quarantineState: 'unknown',
    argsHash: '',
  }
}

/**
 * Parses an id-less `tools/call` (spec-violating: `classify()` reports this
 * shape as `kind: 'notification'`, which has no `id` field at all) into the
 * same shape `protocol/mcp.ts`'s `parseToolCall` produces for a proper
 * request, with `id: null`. This is what lets a notification-shaped
 * `tools/call` go through the exact same decide()/journal path as an
 * id-bearing one instead of being blindly forwarded (C2/N1): the gate must
 * never treat "no id" as "no need to look at it". Returns `null` on any
 * malformed shape, mirroring `parseToolCall`'s own contract.
 */
export function parseIdlessToolCall(raw: string): ParsedToolCall | null {
  const parsed = parseToolCallParams(raw)
  return parsed === null ? null : { ...parsed, id: null }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Writes one redacted decision record. Fire-and-forget, like every sink write. */
export type DecisionWriter = (decision: DecisionInfo, args?: unknown) => void

export interface DecisionWriterDeps {
  readonly sink: GateSink
  readonly sessionId: string
  readonly clock: () => number
}

export function createDecisionWriter(deps: DecisionWriterDeps): DecisionWriter {
  return (decision, args) => {
    deps.sink.write(
      buildDecisionRecord({
        sessionId: deps.sessionId,
        decision,
        args: args ?? null,
        clock: deps.clock,
      }),
    )
  }
}

/**
 * Picks the synthetic error a blocked call is answered with: a quarantined
 * tool gets the quarantine-specific message (which tells the operator the
 * exact `quarantine approve` command), everything else gets the generic
 * policy denial.
 */
export function denialBytesFor(
  id: SynthesizableId,
  info: { readonly toolName: string; readonly serverName: string; readonly rule: string },
): Buffer {
  if (info.rule === QUARANTINE_RULE) {
    return quarantinedError(id, { toolName: info.toolName, serverName: info.serverName })
  }
  return denialError(id, { toolName: info.toolName, rule: info.rule })
}

/**
 * Cap on tool descriptors cached from `tools/list` for classification. A
 * catalog beyond this size degrades to name-only classification, which is
 * the safe direction: an unknown descriptor classifies as `write` (or
 * `destructive` by name heuristic), never as `read`.
 */
const MAX_CACHED_DESCRIPTORS = 5_000

export interface ToolCatalogDeps {
  readonly policy: Policy
  readonly serverName: string
  readonly inventory: GateInventory
  readonly classOverrides: Record<string, ToolClass> | undefined
  readonly writeDecision: DecisionWriter
  /** Awaited before a rewritten catalog is emitted; a no-op unless fail-closed. */
  readonly settleJournal: () => Promise<void>
  readonly onError: (error: unknown) => void
}

export interface ToolCatalog {
  /** Last descriptor seen for `toolName`, or a name-only stand-in. */
  descriptorOf(toolName: string): ToolDescriptor
  /** Observes, quarantines and (optionally) filters one `tools/list` response. */
  handleResponse(msg: ClassifiedMessage): Promise<Verdict>
}

/**
 * The server-side half of the gate: everything that happens to a
 * `tools/list` response. It observes the catalog (which quarantines new and
 * changed tools), caches descriptors so later calls can be classified from
 * the real annotations, and hides tools that resolve to `deny`.
 *
 * Filtering is context hygiene, not the security boundary — the call itself
 * is still gated — so anything unexpected forwards the original message
 * rather than risking the transport.
 */
export function createToolCatalog(deps: ToolCatalogDeps): ToolCatalog {
  const descriptorsByName = new Map<string, ToolDescriptor>()

  function cacheDescriptors(tools: readonly ToolDescriptor[]): void {
    for (const tool of tools) {
      if (descriptorsByName.size >= MAX_CACHED_DESCRIPTORS) return
      descriptorsByName.set(tool.name, tool)
    }
  }

  /**
   * Visibility is static, so it is resolved without a grant: grants are
   * call-scoped (they key on argument values), and a tool that is only
   * callable with an approval must stay visible to be callable at all.
   */
  function isVisible(tool: ToolDescriptor): boolean {
    // Built as a const (not a fresh literal at the call site) so the two
    // catalog-trust fields the pinned `decide()` requires are supplied
    // without an excess-property error while the shared type lands.
    const input = {
      policy: deps.policy,
      serverName: deps.serverName,
      toolName: tool.name,
      toolClass: classifyTool(tool, deps.classOverrides),
      quarantineState: deps.inventory.stateOf(tool.name),
      hasActiveGrant: false,
      catalogObserved: deps.inventory.hasObservedCatalog(),
      catalogTrusted: deps.inventory.isCatalogTrusted(),
    }
    return decide(input).outcome !== 'deny'
  }

  /** One of the two records pairing the catalog the server sent with the one the client saw. */
  function writeCatalogDecision(rule: string, toolNames: readonly string[]): void {
    deps.writeDecision(
      bookkeepingDecisionInfo(deps.serverName, rule, TOOLS_LIST_TOOL_NAME, toolNames),
      { tools: toolNames },
    )
  }

  /**
   * Rewrites the catalog down to what the client may see. When nothing is
   * hidden the original bytes are forwarded verbatim, preserving byte
   * identity for a stream policy did not actually touch.
   */
  async function filterCatalog(
    msg: ClassifiedMessage,
    tools: readonly ToolDescriptor[],
  ): Promise<Verdict> {
    const filtered = filterToolsListResult(msg, isVisible)
    if (filtered === null) {
      deps.onError(new Error('tools/list response could not be rewritten; forwarding the original'))
      return FORWARD
    }

    const removed = new Set(filtered.removed)
    const allNames = tools.map((tool) => tool.name)
    writeCatalogDecision(TOOLS_LIST_ORIGINAL_RULE, allNames)
    writeCatalogDecision(
      TOOLS_LIST_FILTERED_RULE,
      allNames.filter((name) => !removed.has(name)),
    )
    await deps.settleJournal()

    return removed.size === 0 ? FORWARD : { action: 'emit', bytes: filtered.bytes }
  }

  /**
   * The catalog could not be trusted (the observe failed, or the inventory
   * reports an untrusted snapshot). We do NOT silently fail open: the failure
   * is journaled, and — because `decide()` now sees `catalogTrusted:false` —
   * every subsequent `tools/call` fails closed at the call level (C3/C4).
   * The response itself is forwarded unfiltered; enforcement is at call time.
   */
  async function forwardUntrusted(toolNames: readonly string[]): Promise<Verdict> {
    deps.writeDecision(
      bookkeepingDecisionInfo(deps.serverName, INVENTORY_UNAVAILABLE_RULE, TOOLS_LIST_TOOL_NAME, toolNames),
      { tools: toolNames },
    )
    await deps.settleJournal()
    return FORWARD
  }

  async function handleResponse(msg: ClassifiedMessage): Promise<Verdict> {
    try {
      const parsed = parseToolsListResult(msg)
      if (parsed === null) return FORWARD
      cacheDescriptors(parsed.tools)
      // Quarantines new/changed tools before any visibility decision reads
      // their state, and before the next call can be gated. Never throws.
      const observed = await deps.inventory.observeToolsList(parsed.tools)
      if (observed.failed || !deps.inventory.isCatalogTrusted()) {
        return await forwardUntrusted(parsed.tools.map((tool) => tool.name))
      }
      if (deps.policy.toolsList.filter === 'off') return FORWARD
      return await filterCatalog(msg, parsed.tools)
    } catch (error: unknown) {
      deps.onError(error)
      return FORWARD
    }
  }

  return {
    descriptorOf: (toolName) => descriptorsByName.get(toolName) ?? { name: toolName },
    handleResponse,
  }
}

/**
 * An insertion-ordered id set with a hard entry cap, evicting oldest-first.
 *
 * The gate tracks request ids for the whole life of a session (which ids it
 * answered locally, which are outstanding `tools/list` requests). A client
 * that never stops issuing new ids must not be able to grow that bookkeeping
 * without bound, so the set forgets its oldest entries past `maxEntries` —
 * the same cap-and-evict discipline `journal/record.ts` applies to pending
 * request correlation.
 */
export interface BoundedIdSet {
  add(key: string): void
  has(key: string): boolean
  /** True if `key` was present (and is now removed). */
  delete(key: string): boolean
}

export function createBoundedIdSet(maxEntries: number, onEvict?: (key: string) => void): BoundedIdSet {
  const keys = new Set<string>()

  function evictOldest(): void {
    const oldest = keys.values().next()
    if (oldest.done !== true) {
      keys.delete(oldest.value)
      // Eviction is silent for bookkeeping sets, but the tools/list tracker
      // journals it (M9): a forgotten id means a later tools/list response
      // could escape observation, which an auditor must be able to see.
      onEvict?.(oldest.value)
    }
  }

  return {
    add(key: string): void {
      // Re-adding moves the key to the newest position, so insertion order
      // stays age order and eviction stays "oldest first".
      keys.delete(key)
      // `keys.size > 0` also makes a nonsensical `maxEntries <= 0` terminate.
      while (keys.size >= maxEntries && keys.size > 0) {
        evictOldest()
      }
      keys.add(key)
    },
    has: (key: string): boolean => keys.has(key),
    delete: (key: string): boolean => keys.delete(key),
  }
}

/**
 * The exactly-one-outcome guard for locally-answered request ids (M8).
 *
 * A request id that has been answered locally (a synthetic denial/timeout)
 * must never also be forwarded to the server — not even by a human approval
 * that lands after the wait it was racing. The bulk `answered` set is a
 * bounded LRU (fine for duplicate-response detection), but under a flood of
 * intervening answered ids that LRU can evict the very id an in-flight
 * approval is about to resolve. So ids that are answered *while an approval
 * wait for them is in flight* are also recorded in a separate, non-evicting
 * `burned` set, kept only for the lifetime of that wait (refcounted, cleared
 * when the last wait for the id settles). `isAnswered` consults both.
 */
export interface AnswerGuard {
  /** Records `key` as answered locally; burns it too if a wait is currently in flight for it. */
  markAnswered(key: string): void
  /** True if `key` was ever answered locally (LRU) or burned during an in-flight wait. */
  isAnswered(key: string): boolean
  /** Marks the start of one in-flight approval wait for `key` (refcounted). */
  beginWait(key: string): void
  /** Marks the end of one in-flight approval wait for `key`; clears its burn once no wait remains. */
  endWait(key: string): void
}

export function createAnswerGuard(maxEntries: number): AnswerGuard {
  const answered = createBoundedIdSet(maxEntries)
  const waitCounts = new Map<string, number>()
  const burned = new Set<string>()

  return {
    markAnswered(key: string): void {
      answered.add(key)
      if (waitCounts.has(key)) {
        burned.add(key)
      }
    },
    isAnswered: (key: string): boolean => answered.has(key) || burned.has(key),
    beginWait(key: string): void {
      waitCounts.set(key, (waitCounts.get(key) ?? 0) + 1)
    },
    endWait(key: string): void {
      const next = (waitCounts.get(key) ?? 0) - 1
      if (next <= 0) {
        waitCounts.delete(key)
        burned.delete(key)
      } else {
        waitCounts.set(key, next)
      }
    },
  }
}
