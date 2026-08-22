import { ADMIN_ROLES } from '../../admin/constants.js'
import type { AdminRecord } from '../../admin/store.js'
import type { UiSession } from '../auth.js'
import { html, type Html, join, safeUrl } from '../html.js'
import { csrfField } from './csrf-field.js'
import { type CurrentAdmin, renderLayout } from './layout.js'

/**
 * Server-rendered admin management page (M4 Task 14; McpCut front 2026-08-22)
 * — owner-only. The route is pinned to `owner` in ROUTE_TABLE and the server
 * enforces it before this ever runs, so no page-level role check is repeated
 * here; but the nav LINK to this page is emitted by role (see
 * `pages/agents.ts`) so operators/viewers never see it. Pure view layer: never
 * touches the store, never renders a token hash, and escapes every value
 * through the `html` template.
 */

function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/** The `<details>` id of the add form — also the nav `+` target. */
const ADD_DRAWER_ID = 'add-admin'

/** Role preselected in the add form: the least-surprising default for a new human. */
const DEFAULT_NEW_ROLE = 'operator'

/** A role `<select>` (per-row); options come from the fixed vocabulary, not user input. */
function roleSelect(selected: string): Html {
  const options = ADMIN_ROLES.map((role) =>
    role === selected
      ? html`<option value="${role}" selected>${role}</option>`
      : html`<option value="${role}">${role}</option>`,
  )
  return html`<select name="role" aria-label="Role">${options}</select>`
}

/** The role vocabulary as pill radios (add form); same `name`/values the handler parses. */
function roleChoices(selected: string): Html {
  const choices = ADMIN_ROLES.map((role) =>
    role === selected
      ? html`<label class="choice"><input type="radio" name="role" value="${role}" checked>${role}</label>`
      : html`<label class="choice"><input type="radio" name="role" value="${role}">${role}</label>`,
  )
  return html`<div class="choices">${join(choices)}</div>`
}

/** The role as a pill; `owner` is the on-state (it is the role that can reach this page). */
function rolePill(role: string): Html {
  return role === 'owner'
    ? html`<span class="pill pill-on ad-role">${role}</span>`
    : html`<span class="pill ad-role">${role}</span>`
}

function roleForm(admin: AdminRecord, session: UiSession): Html {
  return html`<form method="post" action="/admins/role" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${admin.name}">
    ${roleSelect(admin.role)}
    <button type="submit" class="secondary">Set role</button>
  </form>`
}

function rotateForm(name: string, session: UiSession): Html {
  return html`<form method="post" action="/admins/rotate" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${name}">
    <button type="submit" class="secondary">Rotate token</button>
  </form>`
}

function removeForm(name: string, session: UiSession): Html {
  return html`<form method="post" action="/admins/remove" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${name}">
    <button type="submit" class="danger">Remove</button>
  </form>`
}

/** One row: name, role, dates, and the per-admin owner actions. */
function adminRow(admin: AdminRecord, session: UiSession): Html {
  const rotated = admin.rotatedAt !== undefined ? html`${admin.rotatedAt}` : html`<span class="faint">—</span>`
  return html`<tr data-admin="${admin.name}">
    <td class="pixel ad-name">${admin.name}</td>
    <td>${rolePill(admin.role)}</td>
    <td class="num muted">${admin.createdAt}</td>
    <td class="num muted">${rotated}</td>
    <td><div class="actions ad-actions">${roleForm(admin, session)}${rotateForm(admin.name, session)}${removeForm(admin.name, session)}</div></td>
  </tr>`
}

/** The "add a new admin" drawer (issues a one-time token on submit). */
function addDrawer(session: UiSession): Html {
  return html`<details class="drawer" id="${ADD_DRAWER_ID}">
    <summary>Add administrator</summary>
    <div class="drawer-bd">
      <form method="post" action="/admins/add" class="stacked">
        ${csrfField(session.csrfToken)}
        <div class="ad-add-grid">
          <label><span>Admin name</span><input type="text" name="name" required placeholder="carol"></label>
          <div class="field"><span class="label">Role</span>${roleChoices(DEFAULT_NEW_ROLE)}</div>
        </div>
        <p class="field-hint">The personal token is shown once, right after creation.</p>
        <div class="form-actions"><button type="submit">Add admin</button></div>
      </form>
    </div>
  </details>`
}

function roster(admins: readonly AdminRecord[], session: UiSession): Html {
  const rows =
    admins.length === 0
      ? html`<tr><td colspan="5" class="faint">no admins</td></tr>`
      : join(admins.map((admin) => adminRow(admin, session)))
  return html`<div class="table-wrap"><table class="admin-roster ad-roster">
    <thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Rotated</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function adminsMeta(admins: readonly AdminRecord[]): string {
  return `${String(admins.length)} admin${admins.length === 1 ? '' : 's'}`
}

/** Full-page render of the admin roster and its management forms. */
export function renderAdminsPage(view: {
  readonly admins: readonly AdminRecord[]
  readonly session: UiSession
}): string {
  const { admins, session } = view
  const content = html`<section class="panel ad-panel" aria-label="Administrators">
    <div class="panel-hd"><h1>Administrators</h1><span class="small dim num">${adminsMeta(admins)}</span></div>
    <div class="panel-bd">
      <p class="hint">Personal tokens; one person, one token. A demoted or removed admin's sessions end immediately.</p>
      ${addDrawer(session)}
      ${roster(admins, session)}
    </div>
  </section>`
  return renderLayout({
    title: 'Admins',
    content,
    csrfToken: session.csrfToken,
    currentAdmin: currentAdmin(session),
    activeNav: 'admins',
    navAction: { title: 'Add an administrator', targetId: ADD_DRAWER_ID },
    navMeta: adminsMeta(admins),
  })
}

/**
 * The one-time token reveal after `add` or `rotate`. The plaintext token is
 * interpolated ONLY here, in the direct HTTP response to the action, with a
 * loud warning; it is never persisted, logged or re-rendered on a later load.
 */
export function renderAdminTokenOnce(view: {
  readonly admin: string
  readonly token: string
  readonly action: 'created' | 'rotated'
  readonly session: UiSession
}): string {
  const content = html`<section class="panel panel-strong ad-token token-reveal" aria-label="Admin token">
    <div class="panel-hd"><h1>Admin “${view.admin}” ${view.action}</h1><span class="label">shown once</span></div>
    <div class="panel-bd">
      <p class="callout">Save this token now — it is shown once and cannot be recovered.</p>
      <pre class="token" data-token>${view.token}</pre>
      <p><a href="${safeUrl('/admins')}">Back to admins</a></p>
    </div>
  </section>`
  return renderLayout({
    title: 'Admin token',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'admins',
  })
}

/** A success/failure notice after remove/role, with a link back. */
export function renderAdminNotice(view: {
  readonly message: string
  readonly ok: boolean
  readonly session: UiSession
}): string {
  const content = html`<section class="notice ${view.ok ? 'ok' : 'error'} ad-notice" role="status">
    <h1>${view.ok ? 'Done' : 'Could not complete the action'}</h1>
    <p>${view.message}</p>
    <p><a href="${safeUrl('/admins')}">Back to admins</a></p>
  </section>`
  return renderLayout({
    title: view.ok ? 'Admins' : 'Admins — error',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'admins',
  })
}
