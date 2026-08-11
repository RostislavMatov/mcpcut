import type { ServerRecord } from '../../registry/schema.js'
import type { SecretInfo } from '../../vault/store.js'
import { html, join, type Html } from '../html.js'
import { renderLayout, type CurrentAdmin } from './layout.js'

/**
 * Server-registry and vault pages (M4 Task 13), both read-first and rendered
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

/** A hidden CSRF field for a real `<form>` POST (server enforces the check). */
function csrfField(csrfToken: string): Html {
  return html`<input type="hidden" name="csrf_token" value="${csrfToken}" />`
}

/** Renders one env/header value: a `vault:` reference is badged, else a literal. */
function renderValue(value: string): Html {
  return value.startsWith('vault:')
    ? html`<code class="badge">${value}</code>`
    : html`<code>${value}</code>`
}

/** A `label` section with one `key → value` row per entry; empty maps render nothing. */
function renderValueMap(label: string, map: Record<string, string> | undefined): Html {
  const entries = Object.entries(map ?? {})
  if (entries.length === 0) return html``
  const rows = entries.map(
    ([key, value]) => html`<tr><td><code>${key}</code></td><td>${renderValue(value)}</td></tr>`,
  )
  return html`<h4>${label}</h4><table>${join(rows)}</table>`
}

/** The transport-specific target line and env/header block of one server. */
function renderServerDetails(record: ServerRecord): Html {
  if (record.transport === 'stdio') {
    const args =
      record.args !== undefined && record.args.length > 0
        ? html`<p class="muted">args: <code>${record.args.join(' ')}</code></p>`
        : html``
    return html`
      <p>command: <code>${record.command}</code></p>
      ${args}
      ${renderValueMap('env', record.env)}
    `
  }
  return html`
    <p>url: <code>${record.url}</code></p>
    <p class="muted">protocol: ${record.protocol}</p>
    ${renderValueMap('headers', record.headers)}
  `
}

/** A remove form, shown only to a manager (owner); it posts the server name. */
function renderRemoveForm(name: string, csrfToken: string): Html {
  return html`
    <form method="post" action="/servers/remove">
      ${csrfField(csrfToken)}
      <input type="hidden" name="name" value="${name}" />
      <button type="submit" class="danger">Remove</button>
    </form>
  `
}

/** One server card. `canManage` gates the remove control (owner-only route). */
function renderServerCard(record: ServerRecord, canManage: boolean, csrfToken: string): Html {
  return html`
    <div class="card">
      <h3>${record.name} <span class="badge">${record.transport}</span></h3>
      ${renderServerDetails(record)}
      ${canManage ? renderRemoveForm(record.name, csrfToken) : html``}
    </div>
  `
}

/** The owner-only "register a server" form. Env/headers are one `K=V` per line. */
function renderAddForm(csrfToken: string): Html {
  return html`
    <div class="card">
      <h2>Register a server</h2>
      <form method="post" action="/servers/add">
        ${csrfField(csrfToken)}
        <p><label>name <input name="name" required /></label></p>
        <p>
          <label>transport
            <select name="transport">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </label>
        </p>
        <p><label>command (stdio) <input name="command" /></label></p>
        <p><label>args (comma-separated) <input name="args" /></label></p>
        <p><label>url (http) <input name="url" /></label></p>
        <p><label>protocol (http) <input name="protocol" placeholder="auto" /></label></p>
        <p><label>env — one K=V per line<br /><textarea name="env" rows="3"></textarea></label></p>
        <p><label>headers — one K=V per line<br /><textarea name="headers" rows="3"></textarea></label></p>
        <p class="muted">Secrets never live here: use <code>vault:&lt;name&gt;</code> references, not literals.</p>
        <button type="submit">Register</button>
      </form>
    </div>
  `
}

/** View model for the servers page (built by the handler from the stores). */
export interface ServersView {
  readonly servers: readonly ServerRecord[]
  readonly canManage: boolean
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
  readonly error?: string
}

/** Renders the `/servers` document: the registry list plus, for owners, an add form. */
export function renderServersPage(view: ServersView): string {
  const banner =
    view.error !== undefined ? html`<p class="muted" role="alert">${view.error}</p>` : html``
  const list =
    view.servers.length === 0
      ? html`<p class="muted">No servers registered.</p>`
      : join(view.servers.map((record) => renderServerCard(record, view.canManage, view.csrfToken)))
  const content = html`
    <h1>Servers</h1>
    ${banner}
    ${list}
    ${view.canManage ? renderAddForm(view.csrfToken) : html``}
  `
  return renderLayout({
    title: 'Servers',
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
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
}

/**
 * The confirmation page shown when a server still has active agent grants:
 * it names every affected agent and requires an explicit confirm before the
 * grant-orphaning removal proceeds.
 */
export function renderRemoveWarning(view: RemoveWarningView): string {
  const items = join(view.agents.map((name) => html`<li><code>${name}</code></li>`))
  const content = html`
    <h1>Remove server “${view.serverName}”?</h1>
    <div class="card">
      <p class="muted" role="alert">
        ${view.agents.length} agent(s) still hold grants for this server. Removing it leaves
        those grants pointing at a server that no longer exists:
      </p>
      <ul>${items}</ul>
      <form method="post" action="/servers/remove">
        ${csrfField(view.csrfToken)}
        <input type="hidden" name="name" value="${view.serverName}" />
        <input type="hidden" name="confirm" value="true" />
        <button type="submit" class="danger">Remove anyway</button>
      </form>
      <p><a href="/servers">Cancel</a></p>
    </div>
  `
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
  const content =
    view.secrets === undefined
      ? html`<h1>Vault</h1><p class="muted" role="alert">${view.notice ?? 'Vault unavailable.'}</p>`
      : renderVaultTable(view.secrets)
  return renderLayout({
    title: 'Vault',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
  })
}

/** The names+dates table. Deliberately has no cell that could hold a value. */
function renderVaultTable(secrets: readonly SecretInfo[]): Html {
  if (secrets.length === 0) {
    return html`<h1>Vault</h1><p class="muted">No secrets stored.</p>`
  }
  const rows = secrets.map(
    (secret) => html`
      <tr>
        <td><code>${secret.name}</code></td>
        <td>${secret.createdAt}</td>
        <td>${secret.updatedAt}</td>
      </tr>
    `,
  )
  return html`
    <h1>Vault</h1>
    <p class="muted">Names and dates only — secret values never leave the vault.</p>
    <table>
      <thead><tr><th>Name</th><th>Created</th><th>Updated</th></tr></thead>
      <tbody>${join(rows)}</tbody>
    </table>
  `
}
