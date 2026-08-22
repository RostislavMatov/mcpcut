import type { InventoryStoreData, ServerInventory } from '../../policy/inventory-store.js'
import { diffToolSchemas, type SchemaChange, type SurfaceDelta } from '../../policy/schema-diff.js'
import type { ToolDescriptor } from '../../protocol/mcp.js'
import { html, join, type Html } from '../html.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { renderQuarantineCard } from './quarantine-parts.js'

/**
 * Quarantine review page (M4 Task 12; McpCut front 2026-08-22). Instead of
 * "hashes diverged", each card shows a STRUCTURAL diff of the tool's
 * `inputSchema` (added/removed properties, widened/narrowed enums, …) plus a
 * `surfaceDelta` verdict — the closure of backlog line 45. Every tool
 * name/description/path is untrusted server content and is escaped by the
 * `html` template; the card markup itself lives in `quarantine-parts.ts`.
 *
 * A `changed` tool is diffed against its still-present approved descriptor; a
 * `new` tool has nothing to compare against, so it shows no diff.
 */

/** One quarantined tool projected for display, with its structural diff. */
export interface QuarantineCardView {
  readonly serverName: string
  readonly toolName: string
  readonly state: 'new' | 'changed'
  readonly firstSeenAt: string
  readonly description?: string
  readonly surfaceDelta?: SurfaceDelta
  readonly changes: readonly SchemaChange[]
  readonly truncated: boolean
}

/** Diffs one quarantined tool against its approved descriptor, if any. */
function cardFor(
  serverName: string,
  toolName: string,
  inv: ServerInventory,
): QuarantineCardView {
  const quarantined = inv.quarantined[toolName]
  if (quarantined === undefined) {
    // Unreachable in practice (we only iterate quarantined entries); fail safe.
    return { serverName, toolName, state: 'new', firstSeenAt: '', changes: [], truncated: false }
  }
  const approvedDescriptor: ToolDescriptor | undefined = inv.approved[toolName]?.descriptor
  const diff =
    quarantined.state === 'changed' && approvedDescriptor !== undefined
      ? diffToolSchemas(approvedDescriptor.inputSchema, quarantined.descriptor.inputSchema)
      : { changes: [], surfaceDelta: 'neutral' as SurfaceDelta, truncated: false }
  const surfaceDelta = quarantined.surfaceDelta ?? diff.surfaceDelta
  return {
    serverName,
    toolName,
    state: quarantined.state,
    firstSeenAt: quarantined.firstSeenAt,
    ...(quarantined.descriptor.description !== undefined
      ? { description: quarantined.descriptor.description }
      : {}),
    ...(quarantined.state === 'changed' ? { surfaceDelta } : {}),
    changes: diff.changes,
    truncated: diff.truncated,
  }
}

/** Pure projection: every quarantined tool across every server, with its diff. */
export function toQuarantineCards(store: InventoryStoreData): QuarantineCardView[] {
  const cards: QuarantineCardView[] = []
  for (const [serverName, inv] of Object.entries(store.servers)) {
    for (const toolName of Object.keys(inv.quarantined)) {
      cards.push(cardFor(serverName, toolName, inv))
    }
  }
  return cards
}

export interface QuarantinePageInput {
  readonly cards: readonly QuarantineCardView[]
  readonly csrfToken: string
  readonly currentAdmin?: CurrentAdmin
}

/** The SSE topic that must re-render this list (see `assets/app-js.ts`). */
const QUARANTINE_LIVE_TOPICS = 'quarantine-changed'

/** Where the client refetches this region from (`GET /quarantine`). */
const QUARANTINE_LIVE_SRC = '/quarantine'

/**
 * The live region: the node `assets/app-js.ts` re-fetches and swaps on
 * `quarantine-changed`, so its `data-live-region` value and `data-live-src`
 * must stay exactly what the script looks up (`tests/ui/page-contracts.test.ts`).
 */
function renderLiveRegion(input: QuarantinePageInput): Html {
  const body =
    input.cards.length === 0
      ? html`<p class="empty">No quarantined tools.</p>`
      : html`<div class="qr-cards">${join(input.cards.map((card) => renderQuarantineCard(card, input.csrfToken)))}</div>`
  return html`<section
    class="quarantine"
    data-live-region="${QUARANTINE_LIVE_TOPICS}"
    data-live-src="${QUARANTINE_LIVE_SRC}"
  >
    ${body}
  </section>`
}

/** Renders the full quarantine document (string ready for the HTTP body). */
export function renderQuarantinePage(input: QuarantinePageInput): string {
  const content = html`<section class="panel panel-strong qr-panel" aria-label="Quarantine">
    <div class="panel-hd"><h1>Quarantine</h1><span class="small dim num">${String(input.cards.length)} held</span></div>
    ${renderLiveRegion(input)}
  </section>`
  return renderLayout({
    title: 'Quarantine',
    content,
    csrfToken: input.csrfToken,
    ...(input.currentAdmin !== undefined ? { currentAdmin: input.currentAdmin } : {}),
    activeNav: 'quarantine',
    navMeta: `${String(input.cards.length)} held`,
  })
}
