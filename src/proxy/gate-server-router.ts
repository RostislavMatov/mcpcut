import { classify, type ClassifiedMessage } from '../protocol/classify.js'
import type { McpMessage } from '../transport/message.js'
import type { MethodGrantRouter } from './gate-method-router.js'
import type { Verdict } from './pipeline.js'
import type { ToolCatalog } from './tool-catalog.js'
import { filterToolsListResult } from './tools-filter.js'
import {
  DUPLICATE_RESPONSE_RULE,
  FORWARD,
  RESPONSE_TOOL_NAME,
  TOOLS_LIST_TOOL_NAME,
  bookkeepingDecisionInfo,
  idKeyOf,
  trimTrailingNewline,
  type AnswerGuard,
  type BoundedIdSet,
  type DecisionWriter,
} from './gate-helpers.js'

/**
 * The server -> client half of the gate's router (`gate-router.ts`), split
 * out for the <400-line file rule when decision M36's phase C gave responses
 * a job: a server's answer to a forwarded `tools/call` is reported to the
 * gate's delivery tracking (`gate-delivery.ts`) before it takes its usual
 * path. A server -> client message can never execute a tool, so anything this
 * half does not understand keeps forwarding untouched (unlike the client
 * direction, which fails closed).
 */

/**
 * `rule` recorded when a `tools/list`-shaped response the gate never asked for
 * (an unsolicited push, or one whose id the tracker had to evict) was rewritten
 * down to the agent's grants on its way out.
 */
const UNTRACKED_CATALOG_RULE = 'toolsList.untracked-grant-filtered'

export interface ServerRouterDeps {
  readonly serverName: string
  readonly writeDecision: DecisionWriter
  readonly settleJournal: () => Promise<void>
  readonly answerGuard: AnswerGuard
  readonly catalog: ToolCatalog
  readonly onError: (error: unknown) => void
  /** The `tools/list` request ids the client half is tracking. */
  readonly pendingToolsListIds: BoundedIdSet
  readonly methodRouter: Pick<MethodGrantRouter, 'takePendingList' | 'filterListResponse'>
  /** See `GateRouterDeps.isGrantedToAgent`. */
  readonly isGrantedToAgent?: (tool: string) => boolean
  /** Hears every other response, by id key, with its raw text (phase C: the answer to a forwarded call). */
  readonly onResponse?: (idKey: string, raw: string) => void
}

export function createServerRouter(deps: ServerRouterDeps): (message: McpMessage) => Verdict | Promise<Verdict> {
  const { serverName, writeDecision, settleJournal, answerGuard, catalog, onError, isGrantedToAgent } = deps

  /**
   * A `tools/list`-shaped response the gate never tracked: an unsolicited
   * server push, or one whose id the bounded tracker had to evict. `M2` simply
   * forwarded it, which on an agent session leaks the NAMES of tools the agent
   * was never granted (calling them is still denied — this is visibility only,
   * and the reason it is a low-severity fix).
   *
   * Only the grant half of the filter runs here: policy visibility depends on
   * quarantine state, and quarantine state comes from observing the catalog —
   * which this path deliberately does NOT do. `observeToolsList` on an
   * untracked response would let an unsolicited push rewrite the inventory
   * (and so the quarantine state) of a server the client never queried.
   * Grants need no inventory, so they can be applied safely.
   */
  async function filterUntrackedCatalog(msg: ClassifiedMessage): Promise<Verdict> {
    if (isGrantedToAgent === undefined) return FORWARD
    const filtered = filterToolsListResult(msg, () => true, isGrantedToAgent)
    // `null` means "not a catalog shape we understand" (any other response,
    // unparseable content): forward it exactly as before.
    if (filtered === null || filtered.removed.length === 0) return FORWARD

    writeDecision(
      bookkeepingDecisionInfo(serverName, UNTRACKED_CATALOG_RULE, TOOLS_LIST_TOOL_NAME, filtered.removed),
      { removed: filtered.removed },
    )
    await settleJournal()
    return { action: 'emit', bytes: trimTrailingNewline(filtered.bytes) }
  }

  /** Reported, never decided on: a fault in delivery tracking must not hold an answer back. */
  function reportResponse(key: string, raw: string): void {
    try {
      deps.onResponse?.(key, raw)
    } catch (error: unknown) {
      onError(error)
    }
  }

  return function gateServerMessage(message: McpMessage): Verdict | Promise<Verdict> {
    try {
      const msg = classify(message.bytes.toString('utf8'))
      if (msg.kind !== 'response') return FORWARD

      const key = idKeyOf(msg.id)
      if (deps.pendingToolsListIds.delete(key)) return catalog.handleResponse(msg)
      const trackedList = deps.methodRouter.takePendingList(key)
      if (trackedList !== null) return deps.methodRouter.filterListResponse(msg.raw, trackedList)
      reportResponse(key, msg.raw)
      if (answerGuard.isAnswered(key)) {
        // The client reused an id we already answered: forward it as-is, and
        // leave a trace for whoever has to explain the duplicate later.
        writeDecision(
          bookkeepingDecisionInfo(serverName, DUPLICATE_RESPONSE_RULE, RESPONSE_TOOL_NAME, msg.id),
          { rpcId: msg.id },
        )
      }
      return filterUntrackedCatalog(msg)
    } catch (error: unknown) {
      onError(error)
      return FORWARD
    }
  }
}
