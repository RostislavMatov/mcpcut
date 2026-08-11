import type { InventoryStoreData, ServerInventory } from '../../policy/inventory-store.js'
import { diffToolSchemas, type SchemaChange, type SurfaceDelta } from '../../policy/schema-diff.js'
import type { ToolDescriptor } from '../../protocol/mcp.js'
import { html, join, type Html } from '../html.js'
import { renderLayout, type CurrentAdmin } from './layout.js'

/**
 * Quarantine review page (M4 Task 12). Instead of "hashes diverged", each card
 * shows a STRUCTURAL diff of the tool's `inputSchema` (added/removed
 * properties, widened/narrowed enums, …) plus a `surfaceDelta` verdict — the
 * closure of backlog line 45. Every tool name/description/path is untrusted
 * server content and is escaped by the `html` template.
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

function renderChanges(card: QuarantineCardView): Html {
  if (card.changes.length === 0) {
    const note = card.state === 'new' ? 'New tool — no prior schema to diff.' : 'No structural change detected.'
    return html`<p class="no-diff">${note}</p>`
  }
  const items = card.changes.map(
    (change) => html`<li class="change change-${change.kind}"><code>${change.path}</code> — ${change.kind}</li>`,
  )
  const truncatedNote = card.truncated
    ? html`<li class="change-truncated">diff truncated (schema too deep/large)</li>`
    : html``
  return html`<ul class="schema-diff">
    ${join(items)}${truncatedNote}
  </ul>`
}

function renderActionForm(card: QuarantineCardView, action: string, label: string, csrfToken: string): Html {
  return html`<form method="post" action="/quarantine/${action}" data-action="${action}">
    <input type="hidden" name="csrf_token" value="${csrfToken}" />
    <input type="hidden" name="server" value="${card.serverName}" />
    <input type="hidden" name="tool" value="${card.toolName}" />
    <button type="submit">${label}</button>
  </form>`
}

function renderCard(card: QuarantineCardView, csrfToken: string): Html {
  const deltaBadge =
    card.surfaceDelta !== undefined
      ? html`<span class="surface-delta surface-delta-${card.surfaceDelta}">surfaceDelta: ${card.surfaceDelta}</span>`
      : html``
  return html`<article class="quarantine-card" data-server="${card.serverName}" data-tool="${card.toolName}">
    <div class="quarantine-head">
      <span class="server">${card.serverName}</span>
      <span class="tool">${card.toolName}</span>
      <span class="state state-${card.state}">${card.state}</span>
      ${deltaBadge}
    </div>
    ${card.description !== undefined ? html`<p class="description">${card.description}</p>` : html``}
    ${renderChanges(card)}
    <div class="actions">
      ${renderActionForm(card, 'approve', 'Approve', csrfToken)}
      ${renderActionForm(card, 'reject', 'Reject', csrfToken)}
    </div>
  </article>`
}

export interface QuarantinePageInput {
  readonly cards: readonly QuarantineCardView[]
  readonly csrfToken: string
  readonly currentAdmin?: CurrentAdmin
}

/** Renders the full quarantine document (string ready for the HTTP body). */
export function renderQuarantinePage(input: QuarantinePageInput): string {
  const body =
    input.cards.length === 0
      ? html`<p class="empty">No quarantined tools.</p>`
      : join(input.cards.map((card) => renderCard(card, input.csrfToken)))
  const content = html`<section class="quarantine" data-live="quarantine">
    <h1>Quarantine</h1>
    ${body}
  </section>`
  return renderLayout({
    title: 'Quarantine',
    content,
    csrfToken: input.csrfToken,
    ...(input.currentAdmin !== undefined ? { currentAdmin: input.currentAdmin } : {}),
    activeNav: 'quarantine',
  })
}
