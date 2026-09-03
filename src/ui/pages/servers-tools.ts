import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { Policy } from '../../policy/schema.js'
import { renderToolName } from '../display-name.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import {
  renderToolRuleControls,
  renderToolRulePill,
  serverToolsRegionKey,
  toolRuleViewOf,
  type ToolRuleControls,
  type ToolRuleView,
} from './servers-tool-rule.js'

/**
 * The tools affordance of the Servers screen (McpCut `Servers.dc.html`): the
 * inventory → per-server projection, the card's `tools · N exposed · M
 * quarantined · view →` row, and the MODAL that row opens.
 *
 * The design puts the tool list behind a modal rather than inside the card:
 * a card is the DEFINITION of a server (what will be spawned or called), the
 * tool list is what that server currently claims to expose — server-authored
 * text that can be long and hostile, and does not belong inline in a tile.
 *
 * The modal is a `<details>` with a visually-hidden summary, exactly like the
 * register drawer: `data-open-details` opens it in place with JavaScript, and
 * `/servers?tools=<name>` renders it open server-side so the no-JS path works.
 *
 * Everything here is untrusted-for-render — tool names and descriptions come
 * from a remote MCP server through the inventory store — and reaches markup
 * only through the escaping `html` template.
 */

/** One tool of a server as the modal lists it (approved or quarantined). */
export interface ServerToolView {
  readonly name: string
  readonly description?: string
  /** Present when the tool is quarantined; the quarantine state it is in. */
  readonly quarantined?: 'new' | 'changed'
  /** The effective policy outcome + source (ADR-0009); absent when the page has no loaded policy. */
  readonly rule?: ToolRuleView
}

/** The tools of one server, from the inventory store. */
export interface ServerToolsView {
  readonly tools: readonly ServerToolView[]
  readonly quarantinedCount: number
}

/**
 * Per-server tools, keyed by server name. A `Map`, not a record: server names
 * are whatever an operator registered and the inventory store keys by
 * null-prototype maps for the same reason (`__proto__` is a legal name).
 */
export type ServerToolsByName = ReadonlyMap<string, ServerToolsView>

/**
 * Longest tool description shown inline. Descriptions are server-authored
 * text; past this many characters the modal shows the head and a VISIBLE
 * truncation marker — never a silent cut, which would let a long description
 * hide its tail (the part an operator reviewing a tool most needs to see).
 */
export const TOOL_DESCRIPTION_MAX_CHARS = 240

/** The `GET /servers` parameter that renders one server's tools modal open. */
export const TOOLS_QUERY_PARAM = 'tools'

/**
 * The modal's element id. Server names match
 * `REGISTRY_SERVER_NAME_PATTERN` (`^[a-z0-9][a-z0-9-]{0,63}$`), so this is
 * always a legal id and a legal fragment — no escaping games needed.
 */
export function serverToolsModalId(serverName: string): string {
  return `tools-${serverName}`
}

/**
 * Projects the inventory into the view: the union of approved and quarantined
 * tool names per server, quarantined state winning when a tool is in both (a
 * `changed` tool keeps its approved record while the new one waits). Sorted by
 * name so the listing is stable across re-renders. With a loaded `policy`,
 * every tool also carries its effective rule (`effectiveToolRule`).
 */
export function toServerToolsByName(inventory: InventoryStoreData, policy?: Policy): ServerToolsByName {
  const out = new Map<string, ServerToolsView>()
  for (const [serverName, inv] of Object.entries(inventory.servers)) {
    const byName = new Map<string, ServerToolView>()
    for (const [name, record] of Object.entries(inv.approved)) {
      byName.set(name, withDescription({ name }, record.descriptor?.description))
    }
    for (const [name, record] of Object.entries(inv.quarantined)) {
      byName.set(name, withDescription({ name, quarantined: record.state }, record.descriptor.description))
    }
    const tools = [...byName.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => (policy === undefined ? tool : { ...tool, rule: toolRuleViewOf(policy, inventory, serverName, tool.name) }))
    out.set(serverName, { tools, quarantinedCount: Object.keys(inv.quarantined).length })
  }
  return out
}

function withDescription(view: ServerToolView, description: string | undefined): ServerToolView {
  return description === undefined ? view : { ...view, description }
}

/** A description, truncated EXPLICITLY past the cap (by code point, not UTF-16 unit). */
function renderDescription(description: string): Html {
  const points = Array.from(description)
  if (points.length <= TOOL_DESCRIPTION_MAX_CHARS) return html`<p class="srv-tool-desc muted pretty">${description}</p>`
  const head = points.slice(0, TOOL_DESCRIPTION_MAX_CHARS).join('')
  return html`<p class="srv-tool-desc muted pretty">${head}<span class="faint"> … (truncated)</span></p>`
}

/** What the tools modal needs beyond the tools themselves. */
export interface ToolsPanelContext {
  readonly serverName: string
  readonly csrfToken: string
  /** Absent → no rule controls at all (the page has no policy port). */
  readonly ruleControls?: ToolRuleControls
  /** One line shown above the tools (O4: "no policy — enforcement off"). */
  readonly note?: string
  /** True while a probe of this server is running — the modal says so. */
  readonly probing?: boolean
  /** True when `?tools=<name>` asked for this modal: it renders open. */
  readonly open?: boolean
  /** True when the viewer's role may release a quarantined tool (operator+). */
  readonly canRelease?: boolean
}

/**
 * The release-from-quarantine control, as the design places it: a button on
 * the tool row that opens a small confirmation with a plain-language statement
 * of what release means, a Cancel and the actual POST.
 *
 * The confirmation is NOT decoration. Approving a `changed` tool accepts a new
 * declared surface for a tool an agent may already call, and this modal shows
 * only the description — never the structural `inputSchema` diff. So the text
 * says which of the two cases this is and always points at `/quarantine`,
 * where the diff (and its truncation marker) actually lives.
 */
function renderRelease(tool: ServerToolView, ctx: ToolsPanelContext): Html {
  if (ctx.canRelease !== true || tool.quarantined === undefined) return html``
  const explanation =
    tool.quarantined === 'new'
      ? html`“${renderToolName(tool.name)}” was discovered on the last probe and has never run. Releasing it makes it
          callable by agents connected to ${ctx.serverName}.`
      : html`“${renderToolName(tool.name)}” already ran, and its declared schema has CHANGED since it was approved.
          Releasing it approves the new surface for every agent connected to ${ctx.serverName}.`
  return html`<details class="srv-release">
    <summary class="srv-release-open">Release from quarantine</summary>
    <div class="srv-release-bd">
      <div class="pixel upper srv-release-hd">Release from quarantine</div>
      <p class="muted small pretty">${explanation}</p>
      <p class="small">
        This view shows the description only —
        <a href="${safeUrl('/quarantine')}">review the structural diff</a> before releasing.
      </p>
      <div class="actions">
        <button type="button" class="secondary" data-close-details="">Cancel</button>
        <form method="post" action="/quarantine/approve" class="inline">
          ${csrfField(ctx.csrfToken)}
          <input type="hidden" name="server" value="${ctx.serverName}" />
          <input type="hidden" name="tool" value="${tool.name}" />
          <input type="hidden" name="return_to" value="/servers" />
          <button type="submit" class="approve">Release</button>
        </form>
      </div>
    </div>
  </details>`
}

function renderTool(tool: ServerToolView, ctx: ToolsPanelContext): Html {
  const pill =
    tool.quarantined !== undefined
      ? html`<span class="pill pill-pixel pill-on"><span class="dot dot-s dot-blink"></span>quarantined · ${tool.quarantined}</span>`
      : html``
  const review =
    tool.quarantined !== undefined
      ? html`<a class="small" href="${safeUrl('/quarantine')}">review in quarantine</a>`
      : html``
  const rulePill = tool.rule !== undefined ? renderToolRulePill(tool.rule) : html``
  const controls =
    tool.rule !== undefined && ctx.ruleControls !== undefined
      ? renderToolRuleControls({
          serverName: ctx.serverName,
          toolName: tool.name,
          csrfToken: ctx.csrfToken,
          view: tool.rule,
          controls: ctx.ruleControls,
        })
      : html``
  return html`<div class="srv-tool">
    <div class="row"><span class="srv-tool-name">${renderToolName(tool.name)}</span>${pill}${rulePill}<span class="spacer"></span>${review}</div>
    ${tool.description !== undefined ? renderDescription(tool.description) : html``}
    ${controls}
    ${renderRelease(tool, ctx)}
  </div>`
}

/** The count line the card's tools row shows: `probing…` or the design's split. */
function toolsCountLabel(tools: ServerToolsView | undefined, probing: boolean): string {
  if (probing) return 'probing…'
  const total = tools?.tools.length ?? 0
  const quarantined = tools?.quarantinedCount ?? 0
  return `${total} exposed · ${quarantined} quarantined`
}

/**
 * The card body's tools row (`Servers.dc.html`): a full-width control that
 * opens the modal. It is an `<a>`, not a `<button>`, on purpose — without
 * JavaScript it is a real navigation to `/servers?tools=<name>`, which renders
 * the same modal open; with JavaScript `data-open-details` opens it in place.
 */
export function renderToolsRow(serverName: string, tools: ServerToolsView | undefined, probing: boolean): Html {
  const id = serverToolsModalId(serverName)
  const href = `/servers?${new URLSearchParams({ [TOOLS_QUERY_PARAM]: serverName }).toString()}#${id}`
  const dot = probing || (tools?.quarantinedCount ?? 0) > 0 ? 'dot dot-s dot-blink' : 'dot dot-s'
  return html`<a class="srv-tools-open" href="${safeUrl(href)}" data-open-details="${id}">
    <span class="${dot}"></span>
    <span class="pixel upper">tools</span>
    <span class="dim small num">${toolsCountLabel(tools, probing)}</span>
    <span class="spacer"></span>
    <span class="faint small srv-tools-action">view →</span>
  </a>`
}

/**
 * The tools modal. The body is a settle-only live region keyed per server: a
 * rule action inside it re-fetches `/servers` and swaps ONLY this body, so the
 * open modal stays open. No SSE topic is named — nothing publishes one — so
 * the region never refreshes on its own.
 */
export function renderToolsModal(tools: ServerToolsView | undefined, ctx: ToolsPanelContext): Html {
  const id = serverToolsModalId(ctx.serverName)
  const openAttr = ctx.open === true ? html` open` : html``
  const probing =
    ctx.probing === true
      ? html`<div class="srv-probing"><span class="dot dot-s dot-blink"></span><span class="small">probing… receiving tool list from ${ctx.serverName}</span></div>`
      : html``
  const note = ctx.note !== undefined ? html`<div class="srv-tools-note faint small">${ctx.note}</div>` : html``
  const count = tools?.tools.length ?? 0
  const body =
    tools === undefined || count === 0
      ? html`<div class="empty">no tools reported</div>`
      : join(tools.tools.map((tool) => renderTool(tool, ctx)))
  return html`<details class="drawer srv-tools-modal" id="${id}"${openAttr}>
    <summary class="srv-drawer-sum">Tools of ${ctx.serverName}</summary>
    <div class="drawer-bd srv-modal">
      <div class="srv-modal-hd">
        <span class="pixel upper">Tools</span>
        <span class="faint small ellipsis">${ctx.serverName}</span>
        <span class="spacer"></span>
        <a class="icon srv-modal-x" href="${safeUrl('/servers')}" data-close-details="${id}" title="Close">×</a>
      </div>
      <div class="srv-modal-bd">
        ${probing}
        <div class="rows srv-tool-rows" data-live-region="${serverToolsRegionKey(ctx.serverName)}" data-live-src="/servers" data-live-settle>${note}${body}</div>
      </div>
    </div>
  </details>`
}
