import { buildDecisionRecord } from '../journal/decision.js'
import type { DecisionInfo, PolicyOutcome, QuarantineState, ToolClass } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide } from '../policy/decide.js'
import { canonicalJson, sha256Hex } from '../policy/hash.js'
import type { Inventory } from '../policy/inventory.js'
import type { Policy } from '../policy/schema.js'
import type { ClassifiedMessage, JsonRpcId } from '../protocol/classify.js'
import { parseToolsListResult, type ToolDescriptor } from '../protocol/mcp.js'
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

/** The subset of `Inventory` the gate needs; lets tests inject a minimal fake. */
export type GateInventory = Pick<Inventory, 'observeToolsList' | 'stateOf'>

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
    const decision = decide({
      policy: deps.policy,
      serverName: deps.serverName,
      toolName: tool.name,
      toolClass: classifyTool(tool, deps.classOverrides),
      quarantineState: deps.inventory.stateOf(tool.name),
      hasActiveGrant: false,
    })
    return decision.outcome !== 'deny'
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

  async function handleResponse(msg: ClassifiedMessage): Promise<Verdict> {
    try {
      const parsed = parseToolsListResult(msg)
      if (parsed === null) return FORWARD
      cacheDescriptors(parsed.tools)
      // Quarantines new/changed tools before any visibility decision reads
      // their state, and before the next call can be gated.
      await deps.inventory.observeToolsList(parsed.tools)
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

export function createBoundedIdSet(maxEntries: number): BoundedIdSet {
  const keys = new Set<string>()

  function evictOldest(): void {
    const oldest = keys.values().next()
    if (oldest.done !== true) {
      keys.delete(oldest.value)
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
