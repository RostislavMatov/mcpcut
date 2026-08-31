import {
  HTTP_PROTOCOL_VALUES,
  MAX_ARGS_PER_SERVER,
  MAX_ENV_ENTRIES_PER_SERVER,
  MAX_HEADER_ENTRIES_PER_SERVER,
  VAULT_REF_PREFIX,
} from '../../registry/constants.js'
import type { ServerRecord } from '../../registry/schema.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderRefreshForm, renderStatusDot, type ServerStatusView } from './servers-status.js'
import {
  renderToolsModal,
  renderToolsRow,
  type ServerToolsView,
  type ToolsPanelContext,
} from './servers-tools.js'
import type { ToolRuleControls } from './servers-tool-rule.js'

export {
  serverToolsModalId,
  toServerToolsByName,
  TOOL_DESCRIPTION_MAX_CHARS,
  TOOLS_QUERY_PARAM,
  type ServerToolsByName,
  type ServerToolsView,
  type ServerToolView,
  type ToolsPanelContext,
} from './servers-tools.js'

/**
 * Building blocks of the Servers screen (McpCut console): the server card,
 * its transport-specific body, the env/headers map and the card actions.
 * `servers.ts` composes these into the page and the interstitials; nothing
 * here renders a document, and the tool list lives in `servers-tools.ts`.
 *
 * Every value rendered here is untrusted-for-render — registry records come
 * from disk — and reaches markup only through the escaping `html` template.
 */

/** Renders one env/header value: a `vault:` reference is a solid badge, else a dashed literal. */
function renderValue(value: string): Html {
  return value.startsWith(VAULT_REF_PREFIX)
    ? html`<span class="badge vault"><span class="dot dot-s"></span>${value}</span>`
    : html`<code>${value}</code>`
}

/**
 * A labelled `key → value` map section. The count is written against its cap
 * (`3 / 100`) as the design does: the number alone says nothing about how much
 * room is left before the registry schema starts refusing entries.
 */
export function renderValueMap(label: string, map: Record<string, string> | undefined): Html {
  const entries = Object.entries(map ?? {})
  const cap = label === 'env' ? MAX_ENV_ENTRIES_PER_SERVER : MAX_HEADER_ENTRIES_PER_SERVER
  const emptyLabel = label === 'env' ? 'no env entries' : 'no headers'
  const rows =
    entries.length === 0
      ? html`<div class="empty">${emptyLabel}</div>`
      : join(entries.map(([key, value]) => html`<div class="kv"><span class="k">${key}</span><span class="v">${renderValue(value)}</span></div>`))
  return html`<div class="srv-field">
    <div class="between"><span class="label">${label}</span><span class="faint small num">${String(entries.length)} / ${String(cap)}</span></div>
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
    <div class="between"><span class="label">args</span><span class="faint small num">${String(list.length)} / ${String(MAX_ARGS_PER_SERVER)}</span></div>
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

/**
 * What the collapsed tile prints as the target. The design drops the scheme
 * from an http target (`mcp.github.example/sse`) — inside a tile the `https://`
 * is eight characters of nothing, and the transport pill right above already
 * says the shape. The full url stays in the expanded body.
 */
function summaryTargetOf(record: ServerRecord): string {
  return record.transport === 'stdio' ? record.command : record.url.replace(/^https?:\/\//, '')
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

/**
 * The state word beside the transport pill (`s.stateLabel` in the design). The
 * dot alone carries the state in colour, which is unreadable to anyone who
 * cannot tell the dots apart and invisible in a screenshot; the word says it.
 * It carries `data-server` so the SSE updater can swap it with the dot.
 */
function renderStateLabel(serverName: string, status: ServerStatusView | undefined): Html {
  return html`<span class="srv-state upper faint small" data-server="${serverName}">${status?.status ?? 'never-checked'}</span>`
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
    <span class="srv-sum-badges"><span class="${tpill}">${record.transport}</span>${renderStateLabel(record.name, status)}${flag}</span>
    <span class="spacer-v"></span>
    <span class="srv-sum-target faint small ellipsis">${summaryTargetOf(record)}</span>
    <span class="srv-sum-meta faint small num">${summaryMetaOf(record, tools)}</span>
  </summary>`
}

export interface ServerCardOptions {
  readonly record: ServerRecord
  /** Tools of this server; `undefined` when the page has no inventory or none for it. */
  readonly tools?: ServerToolsView
  /** Whether the inventory was available at all (controls the tools row + modal). */
  readonly hasInventory: boolean
  readonly canManage: boolean
  /** True when the viewer's role may force-probe (operator+). */
  readonly canRefresh?: boolean
  /** True when the viewer's role may release a quarantined tool (operator+). */
  readonly canRelease?: boolean
  /** Status dot state; absence renders the neutral never-checked dot. */
  readonly status?: ServerStatusView
  readonly csrfToken: string
  /** Rule controls' state for this viewer (ADR-0009); absent → none rendered. */
  readonly ruleControls?: ToolRuleControls
  /** One-line note above the tools (O4). */
  readonly toolsNote?: string
  /** True when `?tools=<name>` named this server: its tools modal renders open. */
  readonly toolsOpen?: boolean
}

/** The tools context of one card; exported so the page can render the modal outside the card. */
export function toolsPanelContextOf(options: ServerCardOptions): ToolsPanelContext {
  return {
    serverName: options.record.name,
    csrfToken: options.csrfToken,
    probing: options.status?.status === 'probing',
    ...(options.toolsOpen !== undefined ? { open: options.toolsOpen } : {}),
    ...(options.canRelease !== undefined ? { canRelease: options.canRelease } : {}),
    ...(options.ruleControls !== undefined ? { ruleControls: options.ruleControls } : {}),
    ...(options.toolsNote !== undefined ? { note: options.toolsNote } : {}),
  }
}

/**
 * One server's tools modal. Rendered by the PAGE, as a sibling of the grid —
 * never inside the card: a closed `<details>` renders none of its content, so
 * a modal nested in a collapsed card would be invisible exactly on the no-JS
 * path (`/servers?tools=<name>`) it exists to serve, and a card mid-animation
 * has a transform, which would anchor a `position: fixed` overlay to the tile.
 */
export function renderServerToolsModal(options: ServerCardOptions): Html {
  if (!options.hasInventory) return html``
  return renderToolsModal(options.tools, toolsPanelContextOf(options))
}

/**
 * One server card: a `<details>` whose summary is the compact row and whose
 * body holds the definition, the tools row (which opens the tools modal), the
 * legend and the actions. `data-filter-text` feeds the top-bar client filter
 * with name, target and transport, so typing "http" or a command name narrows
 * the grid.
 *
 * A card whose tools modal was asked for renders EXPANDED: the `view →` row
 * that opens the modal lives in the body, so coming back from
 * `/servers?tools=<name>` to a collapsed card would hide the control that got
 * you there.
 */
export function renderServerCard(options: ServerCardOptions): Html {
  const { record, tools } = options
  const filterText = `${record.name} ${targetOf(record)} ${record.transport}`
  const ctx = toolsPanelContextOf(options)
  const openAttr = options.toolsOpen === true ? html` open` : html``
  const toolsParts = options.hasInventory
    ? renderToolsRow(record.name, tools, ctx.probing === true)
    : html``
  return html`<details class="disclosure card srv-card" data-filter-item data-filter-text="${filterText}"${openAttr}>
    ${renderSummary(record, tools, options.status)}
    <div class="srv-bd">
      ${renderServerDetails(record)}
      ${toolsParts}
      ${renderLegend()}
      ${renderCardActions(options)}
    </div>
  </details>`
}
