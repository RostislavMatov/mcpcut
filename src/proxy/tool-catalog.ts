import type { ToolClass } from '../journal/record.js'
import { classifyTool } from '../policy/classify-tool.js'
import { decide } from '../policy/decide.js'
import type { PolicyProvider } from '../policy/reload.js'
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
  trimTrailingNewline,
  type DecisionWriter,
  type GateInventory,
} from './gate-helpers.js'

/**
 * Cap on tool descriptors cached from `tools/list` for classification. A
 * tool beyond this size is classified from the descriptor the inventory
 * stores, and only then from its name alone. Name-only is never `read`, but
 * it is not "the safe direction" either: a name cannot see `destructiveHint`,
 * so it can land on `write` where the descriptor says `destructive`.
 */
const MAX_CACHED_DESCRIPTORS = 5_000

export interface ToolCatalogDeps {
  /** Read per `tools/list` (`current()`), never captured: the rules may be hot-reloaded. */
  readonly policy: PolicyProvider
  readonly serverName: string
  readonly inventory: GateInventory
  /** This server's class overrides from the policy IN FORCE — a getter, for the same reason. */
  readonly classOverridesOf: () => Record<string, ToolClass> | undefined
  readonly writeDecision: DecisionWriter
  /** Awaited before a rewritten catalog is emitted; a no-op unless fail-closed. */
  readonly settleJournal: () => Promise<void>
  readonly onError: (error: unknown) => void
  /**
   * The agent dimension (M3): when present, a tool survives the `tools/list`
   * rewrite only as the intersection of what was granted to the agent AND
   * what policy leaves visible ("агент видит ровно выданное"). Grant
   * visibility applies even when policy filtering is `off` or the catalog is
   * untrusted — grants do not depend on the inventory, and an agent must
   * never see what was not handed out. Absent — the M2 behavior, unchanged.
   */
  readonly isGrantedToAgent?: (tool: string) => boolean
}

export interface ToolCatalog {
  /**
   * The descriptor to classify `toolName` from: the one this session last saw
   * listed, else the one the inventory stores, else a name-only stand-in.
   */
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
      policy: deps.policy.current(),
      serverName: deps.serverName,
      toolName: tool.name,
      toolClass: classifyTool(tool, deps.classOverridesOf()),
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

  /** A visibility predicate that lets everything through (grant-only filtering). */
  const everyToolVisible = (): boolean => true

  /**
   * Rewrites the catalog down to what the client may see: (granted to the
   * agent, when an agent is present) ∩ (visible under `visibility`). When
   * nothing is hidden the original bytes are forwarded verbatim, preserving
   * byte identity for a stream policy did not actually touch. Emitted bytes
   * are message-level *content* (no trailing `\n`) — the transport sink owns
   * framing (`gate-core.ts` byte conventions).
   */
  async function filterCatalog(
    msg: ClassifiedMessage,
    tools: readonly ToolDescriptor[],
    visibility: (tool: ToolDescriptor) => boolean,
  ): Promise<Verdict> {
    const filtered = filterToolsListResult(msg, visibility, deps.isGrantedToAgent)
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

    return removed.size === 0
      ? FORWARD
      : { action: 'emit', bytes: trimTrailingNewline(filtered.bytes) }
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
      // A catalog rewrite is a policy decision too: give a pending edit the
      // same chance to land as a `tools/call` gives it (the swap itself is
      // asynchronous; this response is filtered under the policy in force).
      deps.policy.maybeRefresh()
      cacheDescriptors(parsed.tools)
      // Quarantines new/changed tools before any visibility decision reads
      // their state, and before the next call can be gated. Never throws.
      const observed = await deps.inventory.observeToolsList(parsed.tools)
      if (observed.failed || !deps.inventory.isCatalogTrusted()) {
        const verdict = await forwardUntrusted(parsed.tools.map((tool) => tool.name))
        // Policy visibility cannot be resolved from an untrusted inventory,
        // but grants can (they do not depend on it) — an agent still must
        // not see what was never granted, so only grant filtering runs here.
        if (deps.isGrantedToAgent === undefined) return verdict
        return await filterCatalog(msg, parsed.tools, everyToolVisible)
      }
      if (deps.policy.current().toolsList.filter === 'off') {
        // `filter: off` opts out of POLICY visibility hygiene only; the
        // agent-grant allowlist is not a policy knob and always applies.
        if (deps.isGrantedToAgent === undefined) return FORWARD
        return await filterCatalog(msg, parsed.tools, everyToolVisible)
      }
      return await filterCatalog(msg, parsed.tools, isVisible)
    } catch (error: unknown) {
      deps.onError(error)
      return FORWARD
    }
  }

  /**
   * Whether a session asks for `tools/list` at all is the agent's choice, so
   * it must not be what decides a tool's class: a call in a session that never
   * listed tools is classified from the inventory's stored descriptor -- the
   * same annotations a listing would have shown (smoke 2026-09-18, H1).
   */
  function descriptorOf(toolName: string): ToolDescriptor {
    return descriptorsByName.get(toolName) ?? deps.inventory.descriptorOf(toolName) ?? { name: toolName }
  }

  return {
    descriptorOf,
    handleResponse,
  }
}
