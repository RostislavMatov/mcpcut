import { MAX_SERVERS_IN_REGISTRY } from '../../registry/constants.js'
import type { ServerRecord } from '../../registry/schema.js'
import type { SecretInfo } from '../../vault/store.js'
import type { PolicyView } from '../../policy/edit/policy-view.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { EMPTY_SERVER_FORM, type ServerFormValues } from '../server-form.js'
import { csrfField } from './csrf-field.js'
import { renderInterstitial } from './interstitial.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { renderServerDrawer, type ServerDrawerOptions } from './servers-form.js'
import {
  renderServerCard,
  renderServerDetails,
  renderServerToolsModal,
  type ServerCardOptions,
  type ServerToolsByName,
} from './servers-parts.js'
import { renderPolicyBanner, renderPolicySources, ruleControlsOf, toolsNoteOf } from './servers-policy-view.js'
import type { ServerStatusesByName } from './servers-status.js'
import { plural } from './plural.js'

export {
  serverToolsModalId,
  toServerToolsByName,
  TOOL_DESCRIPTION_MAX_CHARS,
  TOOLS_QUERY_PARAM,
  type ServerToolsByName,
  type ServerToolsView,
  type ServerToolView,
} from './servers-parts.js'

export {
  REFRESH_ACTION,
  SERVER_STATUS_KINDS,
  toServerStatusesByName,
  type ServerStatusesByName,
  type ServerStatusKind,
  type ServerStatusView,
  type ServerStatusViewEntry,
} from './servers-status.js'

/**
 * Server-registry and vault pages in the McpCut console (Servers screen of
 * the design): a grid of disclosure cards, the owner's register drawer, the
 * two confirmation interstitials and the read-only vault table. All rendered
 * only through the escaping `html` template + `renderLayout`.
 *
 * Two hard invariants live here:
 *  - The vault page shows secret NAMES and DATES only. It is handed a
 *    `SecretInfo[]` (which by construction has no `value` field), so a value
 *    cannot reach the browser even by mistake — there is nothing to render.
 *  - Every env/header value is either a `vault:<name>` reference or a
 *    non-secret literal (the registry schema forbids secret literals), and all
 *    of it is untrusted-for-render, so each value is escaped.
 */

/** Longest search query echoed back into the top-bar box. */
const MAX_ECHOED_QUERY_CHARS = 200

/** The two card layouts of the design's Servers screen. */
export type ServersViewMode = 'grid' | 'list'

/** The modal drawer's full state, built by the handler. */
export interface ServerDrawerState extends ServerDrawerOptions {
  readonly form: ServerFormValues
}

/** View model for the servers page (built by the handler from the stores). */
export interface ServersView {
  readonly servers: readonly ServerRecord[]
  readonly canManage: boolean
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
  /** Shown as a bare alert to a non-owner (owners get it inside the drawer). */
  readonly error?: string
  /**
   * The modal drawer's state: mode (add/edit), whether it renders open, the
   * form values (already echo-safe) and the drawer-local error. Absent →
   * a closed, blank register drawer (owners always get the node, so the tab
   * bar's `+` has something to open).
   */
  readonly drawer?: ServerDrawerState
  /** Tiles or list; `?view=list` switches, tiles are the default. */
  readonly viewMode?: ServersViewMode
  /**
   * Per-server tools from the inventory store. Absent when the handler has no
   * inventory port — the page then renders no tools panels and no counts.
   */
  readonly tools?: ServerToolsByName
  /**
   * Per-server probe/traffic status for the dot + tooltip (M5.5 p.1, O7),
   * built by the handler from `server-status.json` and the passive activity
   * signal. Absent map or absent entry both render the neutral
   * never-checked dot.
   */
  readonly statuses?: ServerStatusesByName
  /** True when the viewer's role may POST `/servers/refresh` (operator+). */
  readonly canRefresh?: boolean
  /** True when the viewer's role may POST `/quarantine/approve` (operator+). */
  readonly canRelease?: boolean
  /**
   * The server named by `?tools=<name>`: its tools modal renders open, which
   * is the no-JS path behind the card's `view →` row.
   */
  readonly openTools?: string
  /** The `q` query, echoed into the search box (the client filter applies it on load). */
  readonly query?: string
  /**
   * The policy as read for the UI (ADR-0009, the ADR-0005 sources panel).
   * Absent when the handler has no policy port — no pills, no controls.
   */
  readonly policyView?: PolicyView
}

function navMetaOf(view: ServersView): string {
  const servers = `${view.servers.length} / ${MAX_SERVERS_IN_REGISTRY} servers`
  if (view.tools === undefined) return servers
  let quarantined = 0
  for (const record of view.servers) quarantined += view.tools.get(record.name)?.quarantinedCount ?? 0
  return quarantined > 0 ? `${servers} · ${quarantined} quarantined` : servers
}

/** `/servers` with the mode and (when set) the search query preserved. */
function viewHref(mode: ServersViewMode, view: ServersView): string {
  const query = new URLSearchParams()
  if (view.query !== undefined && view.query !== '') query.set('q', view.query)
  if (mode === 'list') query.set('view', 'list')
  const qs = query.toString()
  return qs === '' ? '/servers' : `/servers?${qs}`
}

/** The design's ▦ / ≡ toggle at the right end of the tab bar. */
function renderViewToggle(view: ServersView, mode: ServersViewMode): Html {
  const cell = (m: ServersViewMode, glyph: string, title: string): Html => {
    const cls = m === mode ? 'is-on' : ''
    return html`<a class="${cls}" href="${safeUrl(viewHref(m, view))}" title="${title}">${glyph}</a>`
  }
  return html`<span class="view-toggle">${cell('grid', '▦', 'Tiles')}${cell('list', '≡', 'List')}</span>`
}

function renderGrid(view: ServersView, mode: ServersViewMode): Html {
  if (view.servers.length === 0) {
    return html`<p class="empty">No servers registered.</p>`
  }
  const options = cardOptionsOf(view)
  const viewClass = mode === 'list' ? 'srv-grid view-list' : 'srv-grid view-grid'
  return html`<section class="${viewClass}" aria-label="Servers">
    ${join(options.map(renderServerCard))}
    <p class="empty srv-no-match" data-filter-empty hidden>No server matches this search.</p>
  </section>
  ${join(options.map(renderServerToolsModal))}`
}

/** One `ServerCardOptions` per registered server, shared by the card and its modal. */
function cardOptionsOf(view: ServersView): readonly ServerCardOptions[] {
  const ruleControls = ruleControlsOf(view.policyView, view.canManage)
  const toolsNote = toolsNoteOf(view.policyView)
  return view.servers.map((record) => {
    const tools = view.tools?.get(record.name)
    const status = view.statuses?.get(record.name)
    return {
      record,
      ...(tools !== undefined ? { tools } : {}),
      ...(status !== undefined ? { status } : {}),
      hasInventory: view.tools !== undefined,
      canManage: view.canManage,
      ...(view.canRefresh !== undefined ? { canRefresh: view.canRefresh } : {}),
      ...(view.canRelease !== undefined ? { canRelease: view.canRelease } : {}),
      ...(view.openTools !== undefined ? { toolsOpen: view.openTools === record.name } : {}),
      csrfToken: view.csrfToken,
      ...(ruleControls !== undefined ? { ruleControls } : {}),
      ...(toolsNote !== undefined ? { toolsNote } : {}),
    }
  })
}

/**
 * The owner's modal drawer. Always rendered for an owner (closed and blank
 * when nothing forced it open) so the tab bar's `+` has a node to open; the
 * handler forces it open — with the error inside — when re-rendering a
 * rejected submission, and prefilled for `?add=1` / `?edit=<name>`.
 */
function renderManage(view: ServersView): Html {
  if (!view.canManage) {
    return view.error !== undefined ? html`<p role="alert">${view.error}</p>` : html``
  }
  const drawer: ServerDrawerState = view.drawer ?? { mode: 'add', open: false, form: EMPTY_SERVER_FORM }
  const { form, ...options } = drawer
  return renderServerDrawer(view.csrfToken, form, options)
}

/** Renders the `/servers` document: the card grid/list plus, for owners, the modal drawer. */
export function renderServersPage(view: ServersView): string {
  const mode: ServersViewMode = view.viewMode ?? 'grid'
  const content = html`
    ${renderPolicyBanner(view.policyView)}
    ${renderManage(view)}
    ${renderPolicySources(view.policyView)}
    ${renderGrid(view, mode)}
  `
  const query = (view.query ?? '').slice(0, MAX_ECHOED_QUERY_CHARS)
  return renderLayout({
    title: 'Servers',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'servers',
    search: {
      action: '/servers',
      name: 'q',
      placeholder: 'search servers — name, command, url',
      clientFilter: true,
      ...(query !== '' ? { value: query } : {}),
    },
    ...(view.canManage
      ? {
          navAction: {
            title: 'Register a server',
            targetId: 'add-server',
            href: '/servers?add=1#add-server',
          },
        }
      : {}),
    navMeta: navMetaOf(view),
    navControls: renderViewToggle(view, mode),
    scripts: ['servers.js'],
  })
}

/** View model for the add-server confirmation interstitial. */
export interface AddConfirmView {
  /** The record as the registry schema accepted it — already validated. */
  readonly record: ServerRecord
  /** The submitted form fields, replayed verbatim so confirming re-posts them. */
  readonly fields: Readonly<Record<string, string>>
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
  /** `edit` posts the confirmation to `/servers/edit` and words it as a save. */
  readonly mode?: 'add' | 'edit'
}

/**
 * The confirmation page shown before a server is registered. Registering a
 * `stdio` server is remote code execution by design — the plane will spawn that
 * command line — and a `http` one names an endpoint the plane will speak to
 * with vault-held credentials. The CLI's `server add` makes an operator type
 * the command out; the browser form otherwise turns the same power into a
 * single POST, so this step shows exactly what is about to be registered.
 *
 * Every echoed value goes through the escaping `html` template: the command,
 * args and env come from the form and are untrusted for render.
 */
export function renderAddConfirm(view: AddConfirmView): string {
  const isEdit = view.mode === 'edit'
  const replay = join(
    Object.entries(view.fields)
      .filter(([key]) => key !== 'csrf_token' && key !== 'confirm')
      .map(([key, value]) => html`<input type="hidden" name="${key}" value="${value}" />`),
  )
  const heading = isEdit
    ? html`Save changes to “${view.record.name}”?`
    : html`Register server “${view.record.name}”?`
  const content = renderInterstitial({
    panelClass: 'srv-confirm',
    cancelHref: '/servers',
    heading,
    warning: html`<p role="alert">
        The control plane will use this definition to reach the server. A
        <code>stdio</code> server means the plane spawns this exact command on this host.
        Confirm that it is what you intend to run.
      </p>`,
    details: html`<div class="srv-bd srv-confirm-details">${renderServerDetails(view.record)}</div>`,
    form: html`<form method="post" action="${safeUrl(isEdit ? '/servers/edit' : '/servers/add')}">
        ${csrfField(view.csrfToken)}
        ${replay}
        <input type="hidden" name="confirm" value="true" />
        <div class="actions"><button type="submit" class="danger">${isEdit ? html`Save it` : html`Register it`}</button></div>
      </form>`,
  })
  return renderLayout({
    title: isEdit ? 'Edit server' : 'Register server',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'servers',
  })
}

/** View model for the remove-with-grants confirmation interstitial. */
export interface RemoveWarningView {
  readonly serverName: string
  readonly agents: readonly string[]
  /**
   * Groups holding a grant for the server (G6). Optional so a caller that
   * predates groups still renders the agent half unchanged; the handler
   * always passes it.
   */
  readonly groups?: readonly string[]
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
}

/** One labelled list of holders, or nothing when that half is empty. */
function holderList(label: string, names: readonly string[]): Html {
  if (names.length === 0) return html``
  const items = join(names.map((name) => html`<li><code>${name}</code></li>`))
  return html`<p class="small muted">${label}</p>
    <ul class="rows srv-holders">${items}</ul>`
}

/**
 * The confirmation page shown when a server is still granted to agents or
 * groups: it names every affected holder and requires an explicit confirm,
 * because confirming CASCADES (G6) — the grants are dropped with the server,
 * not left pointing at something that no longer exists.
 */
export function renderRemoveWarning(view: RemoveWarningView): string {
  const groups = view.groups ?? []
  const content = renderInterstitial({
    panelClass: 'srv-confirm',
    cancelHref: '/servers',
    heading: html`Remove server “${view.serverName}”?`,
    // The count and the listed set are the SAME set — active agents — because
    // that is what the panel below names. The cascade is wider: it also drops
    // the dangling grants of revoked agents, which nothing here can list
    // meaningfully, so the sentence says so instead of quietly under-counting.
    warning: html`<p role="alert">
        Removing this server also removes it from
        ${plural(view.agents.length, 'active agent grant')}
        (revoked agents’ dangling grants are dropped too) and ${plural(groups.length, 'group')}:
      </p>`,
    details: html`${holderList('Agents', view.agents)}${holderList('Groups', groups)}`,
    form: html`<form method="post" action="/servers/remove">
        ${csrfField(view.csrfToken)}
        <input type="hidden" name="name" value="${view.serverName}" />
        <input type="hidden" name="confirm" value="true" />
        <div class="actions"><button type="submit" class="danger">Remove anyway</button></div>
      </form>`,
  })
  return renderLayout({
    title: 'Remove server',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'servers',
  })
}

/** View model for the vault page. Only ever carries metadata, never values. */
export interface VaultView {
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
  readonly secrets?: readonly SecretInfo[]
  /** Human-readable note when the vault is not initialized or is corrupt. */
  readonly notice?: string
}

/** Renders the `/vault` document: secret names and dates only — no values, ever. */
export function renderVaultPage(view: VaultView): string {
  const body =
    view.secrets === undefined
      ? html`<p role="alert">${view.notice ?? 'Vault unavailable.'}</p>`
      : renderVaultTable(view.secrets)
  const meta = view.secrets === undefined ? html`` : html`<span class="small muted num">${String(view.secrets.length)} stored</span>`
  const content = html`<section class="panel">
    <div class="panel-hd"><h1>Vault</h1>${meta}</div>
    <div class="panel-bd">${body}</div>
  </section>`
  return renderLayout({
    title: 'Vault',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'vault',
  })
}

/** The names+dates table. Deliberately has no cell that could hold a value. */
function renderVaultTable(secrets: readonly SecretInfo[]): Html {
  const note = html`<p class="muted small">Names and dates only — secret values never leave the vault.</p>`
  if (secrets.length === 0) {
    return html`${note}<p class="empty">No secrets stored.</p>`
  }
  const rows = secrets.map(
    (secret) => html`
      <tr>
        <td><code>${secret.name}</code></td>
        <td class="num">${secret.createdAt}</td>
        <td class="num">${secret.updatedAt}</td>
      </tr>
    `,
  )
  return html`
    ${note}
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Created</th><th>Updated</th></tr></thead>
      <tbody>${join(rows)}</tbody>
    </table></div>
  `
}
