import { HTTP_PROTOCOL_VALUES, VAULT_REF_PREFIX } from '../../registry/constants.js'
import type { ServerRecord } from '../../registry/schema.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { Policy } from '../../policy/schema.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderRefreshForm, renderStatusDot, type ServerStatusView } from './servers-status.js'
import {
  renderToolRuleControls,
  renderToolRulePill,
  serverToolsRegionKey,
  toolRuleViewOf,
  type ToolRuleControls,
  type ToolRuleView,
} from './servers-tool-rule.js'

/**
 * Building blocks of the Servers screen (McpCut console): the server card,
 * its transport-specific body, the env/headers map, the tools sub-panel, and
 * the inventory → per-server tools projection. `servers.ts` composes these
 * into the page and the interstitials; nothing here renders a document.
 *
 * Every value rendered here is untrusted-for-render — registry records come
 * from disk, tool names/descriptions from a remote server via the inventory
 * store — and reaches markup only through the escaping `html` template.
 */

/** One tool of a server as the card lists it (approved or quarantined). */
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
 * text; past this many characters the card shows the head and a VISIBLE
 * truncation marker — never a silent cut, which would let a long description
 * hide its tail (the part an operator reviewing a tool most needs to see).
 */
export const TOOL_DESCRIPTION_MAX_CHARS = 240

/**
 * Projects the inventory into the card view: the union of approved and
 * quarantined tool names per server, quarantined state winning when a tool is
 * in both (a `changed` tool keeps its approved record while the new one waits).
 * Sorted by name so the listing is stable across re-renders. With a loaded
 * `policy`, every tool also carries its effective rule (`effectiveToolRule`).
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

/** What the tools panel needs beyond the tools: whose panel, and the rule controls' state. */
export interface ToolsPanelContext {
  readonly serverName: string
  readonly csrfToken: string
  /** Absent → no rule controls at all (the page has no policy port). */
  readonly ruleControls?: ToolRuleControls
  /** One line shown above the tools (O4: "no policy — enforcement off"). */
  readonly note?: string
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
    <div class="row"><span class="srv-tool-name">${tool.name}</span>${pill}${rulePill}<span class="spacer"></span>${review}</div>
    ${tool.description !== undefined ? renderDescription(tool.description) : html``}
    ${controls}
  </div>`
}

/**
 * The tools sub-panel: a nested disclosure listing every tool the inventory
 * knows for this server. Absent entirely when the page has no inventory
 * (the port is optional); "no tools observed yet" when the inventory has no
 * entry for the server (it fills on the first `tools/list` seen by the proxy).
 *
 * The body is a settle-only live region keyed per server (finding 9): a rule
 * action inside it re-fetches `/servers` and swaps ONLY this body, so the
 * open `<details>` stays open. No SSE topic is named — nothing publishes
 * one — so the region never refreshes on its own.
 */
export function renderToolsPanel(tools: ServerToolsView | undefined, ctx: ToolsPanelContext): Html {
  const count = tools?.tools.length ?? 0
  const dot = (tools?.quarantinedCount ?? 0) > 0 ? 'dot dot-s dot-blink' : 'dot dot-s'
  const note = ctx.note !== undefined ? html`<div class="srv-tools-note faint small">${ctx.note}</div>` : html``
  const body =
    tools === undefined || count === 0
      ? html`<div class="empty">no tools observed yet</div>`
      : join(tools.tools.map((tool) => renderTool(tool, ctx)))
  return html`<details class="disclosure srv-tools">
    <summary class="srv-tools-sum"><span class="${dot}"></span><span class="pixel upper">tools</span><span class="dim small num">${String(count)}</span><span class="spacer"></span><span class="caret">▼</span></summary>
    <div class="rows srv-tool-rows" data-live-region="${serverToolsRegionKey(ctx.serverName)}" data-live-src="/servers" data-live-settle>${note}${body}</div>
  </details>`
}

/** Renders one env/header value: a `vault:` reference is a solid badge, else a dashed literal. */
function renderValue(value: string): Html {
  return value.startsWith(VAULT_REF_PREFIX)
    ? html`<span class="badge vault"><span class="dot dot-s"></span>${value}</span>`
    : html`<code>${value}</code>`
}

/** A labelled `key → value` map section; an empty map says so rather than vanishing. */
export function renderValueMap(label: string, map: Record<string, string> | undefined): Html {
  const entries = Object.entries(map ?? {})
  const rows =
    entries.length === 0
      ? html`<div class="empty">no ${label}</div>`
      : join(entries.map(([key, value]) => html`<div class="kv"><span class="k">${key}</span><span class="v">${renderValue(value)}</span></div>`))
  return html`<div class="srv-field">
    <div class="between"><span class="label">${label}</span><span class="faint small num">${String(entries.length)}</span></div>
    <div class="rows srv-map">${rows}</div>
  </div>`
}

/**
 * The argument vector, one argument per row (numbered by CSS counter).
 * Deliberately NOT joined with spaces: an argument that itself contains a
 * space would then be indistinguishable from two arguments, and this markup
 * is reused by the confirmation interstitial — the one screen whose whole
 * purpose is letting a human see the exact command line that will be spawned
 * on their host. Each argument still goes through the escaping `html` tag,
 * like every other untrusted value here.
 */
export function renderArgs(args: readonly string[] | undefined): Html {
  const list = args ?? []
  const items =
    list.length === 0
      ? html`<li class="empty">no args</li>`
      : join(list.map((arg) => html`<li><code>${arg}</code></li>`))
  return html`<div class="srv-field">
    <div class="between"><span class="label">args</span><span class="faint small num">${String(list.length)}</span></div>
    <ol class="srv-args">${items}</ol>
  </div>`
}

function renderProtocolPills(chosen: string): Html {
  return join(
    HTTP_PROTOCOL_VALUES.map((value) =>
      value === chosen ? html`<span class="pill pill-on">${value}</span>` : html`<span class="pill">${value}</span>`,
    ),
  )
}

/** The transport-specific target, args/protocol and env/header block of one server. */
export function renderServerDetails(record: ServerRecord): Html {
  if (record.transport === 'stdio') {
    return html`
      <div class="srv-field"><span class="label">command</span><div class="srv-box">${record.command}</div></div>
      ${renderArgs(record.args)}
      ${renderValueMap('env', record.env)}
    `
  }
  return html`
    <div class="srv-field"><span class="label">url</span><div class="srv-box">${record.url}</div></div>
    <div class="row"><span class="label">protocol</span>${renderProtocolPills(record.protocol)}</div>
    ${renderValueMap('headers', record.headers)}
  `
}

/** What the env/header value styles mean, stated once per card. */
export function renderLegend(): Html {
  return html`<div class="srv-legend faint small">
    <span><span class="srv-swatch srv-swatch-vault"></span> vault:&lt;name&gt; — reference, resolved at launch</span>
    <span><span class="srv-swatch srv-swatch-literal"></span> plain literal — stored as written</span>
  </div>`
}

/**
 * The card actions row, as the design's expanded card: Refresh (operator+,
 * `canRefresh`) beside the owner's Edit (a link to `/servers?edit=<name>` —
 * the server prefills the modal drawer, so it works without JavaScript) and
 * Remove form. Empty when the viewer may do neither.
 */
function renderCardActions(options: ServerCardOptions): Html {
  const { record, canManage, csrfToken } = options
  const canRefresh = options.canRefresh === true
  if (!canManage && !canRefresh) return html``
  const editHref = `/servers?${new URLSearchParams({ edit: record.name }).toString()}#add-server`
  const manage = canManage
    ? html`<a class="btn srv-edit" href="${safeUrl(editHref)}">Edit</a>
    ${renderRemoveForm(record.name, csrfToken)}`
    : html``
  return html`<div class="actions srv-actions">
    ${canRefresh ? renderRefreshForm(record.name, csrfToken) : html``}
    ${manage}
  </div>`
}

/** A remove form, shown only to a manager (owner); it posts the server name. */
function renderRemoveForm(name: string, csrfToken: string): Html {
  return html`<form method="post" action="/servers/remove" class="inline srv-remove">
      ${csrfField(csrfToken)}
      <input type="hidden" name="name" value="${name}" />
      <button type="submit" class="danger">Remove</button>
    </form>`
}

function targetOf(record: ServerRecord): string {
  return record.transport === 'stdio' ? record.command : record.url
}

/** The collapsed tile's meta line, as the design writes it per transport. */
function summaryMetaOf(record: ServerRecord, tools: ServerToolsView | undefined): string {
  const base =
    record.transport === 'stdio'
      ? `${(record.args ?? []).length} args · ${Object.keys(record.env ?? {}).length} env`
      : `${record.protocol} · ${Object.keys(record.headers ?? {}).length} headers`
  if (tools === undefined) return base
  return `${base} · ${tools.tools.length} tools`
}

function renderSummary(
  record: ServerRecord,
  tools: ServerToolsView | undefined,
  status: ServerStatusView | undefined,
): Html {
  const quarantined = tools?.quarantinedCount ?? 0
  const flag =
    quarantined > 0
      ? html`<span class="pill pill-pixel pill-on shimmer">${String(quarantined)} quarantined</span>`
      : html``
  const tpill = record.transport === 'stdio' ? 'tpill tpill-stdio' : 'tpill tpill-http'
  return html`<summary class="srv-sum">
    <span class="row srv-sum-top">${renderStatusDot(record.name, status)}<span class="name pixel ellipsis">${record.name}</span></span>
    <span class="srv-sum-badges"><span class="${tpill}">${record.transport}</span>${flag}</span>
    <span class="spacer-v"></span>
    <span class="srv-sum-target faint small ellipsis">${targetOf(record)}</span>
    <span class="srv-sum-meta faint small num">${summaryMetaOf(record, tools)}</span>
  </summary>`
}

export interface ServerCardOptions {
  readonly record: ServerRecord
  /** Tools of this server; `undefined` when the page has no inventory or none for it. */
  readonly tools?: ServerToolsView
  /** Whether the inventory was available at all (controls the tools panel). */
  readonly hasInventory: boolean
  readonly canManage: boolean
  /** True when the viewer's role may force-probe (operator+; Task 6 sets it). */
  readonly canRefresh?: boolean
  /** Status dot state; absence renders the neutral never-checked dot. */
  readonly status?: ServerStatusView
  readonly csrfToken: string
  /** Rule controls' state for this viewer (ADR-0009); absent → none rendered. */
  readonly ruleControls?: ToolRuleControls
  /** One-line note above the tools (O4). */
  readonly toolsNote?: string
}

/**
 * One server card: a `<details>` whose summary is the compact row and whose
 * body holds the definition, the tools panel and (owner) the remove form.
 * `data-filter-text` feeds the top-bar client filter with name, target and
 * transport, so typing "http" or a command name narrows the grid.
 */
function toolsPanelContextOf(options: ServerCardOptions): ToolsPanelContext {
  return {
    serverName: options.record.name,
    csrfToken: options.csrfToken,
    ...(options.ruleControls !== undefined ? { ruleControls: options.ruleControls } : {}),
    ...(options.toolsNote !== undefined ? { note: options.toolsNote } : {}),
  }
}

export function renderServerCard(options: ServerCardOptions): Html {
  const { record, tools } = options
  const filterText = `${record.name} ${targetOf(record)} ${record.transport}`
  return html`<details class="disclosure card srv-card" data-filter-item data-filter-text="${filterText}">
    ${renderSummary(record, tools, options.status)}
    <div class="srv-bd">
      ${renderServerDetails(record)}
      ${options.hasInventory ? renderToolsPanel(tools, toolsPanelContextOf(options)) : html``}
      ${renderLegend()}
      ${renderCardActions(options)}
    </div>
  </details>`
}
