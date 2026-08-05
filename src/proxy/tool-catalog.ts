import type { ToolClass } from '../journal/record.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide } from '../policy/decide.js'
import type { Policy } from '../policy/schema.js'
import type { ClassifiedMessage } from '../protocol/classify.js'
import { parseToolsListResult, type ToolDescriptor } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import { filterToolsListResult } from './tools-filter.js'
import {
  FORWARD,
  INVENTORY_UNAVAILABLE_RULE,
  TOOLS_LIST_FILTERED_RULE,
  TOOLS_LIST_ORIGINAL_RULE,
  TOOLS_LIST_TOOL_NAME,
  bookkeepingDecisionInfo,
  type DecisionWriter,
  type GateInventory,
} from './gate-helpers.js'

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
