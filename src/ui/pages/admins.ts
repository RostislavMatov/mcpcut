import { ADMIN_ROLES } from '../../admin/constants.js'
import type { AdminRecord } from '../../admin/store.js'
import type { UiSession } from '../auth.js'
import { html, type Html, join, safeUrl } from '../html.js'
import { csrfField } from './csrf-field.js'
import { type CurrentAdmin, renderLayout } from './layout.js'

/**
 * Server-rendered admin management page (M4 Task 14) — owner-only. The route is
 * pinned to `owner` in ROUTE_TABLE and the server enforces it before this ever
 * runs, so no page-level role check is repeated here; but the nav LINK to this
 * page is emitted by role (see `pages/agents.ts`) so operators/viewers never
 * see it. Pure view layer: never touches the store, never renders a token hash,
 * and escapes every value through the `html` template.
 */

function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/** A role `<select>`; options come from the fixed vocabulary, not user input. */
function roleSelect(selected?: string): Html {
  const options = ADMIN_ROLES.map((role) =>
    role === selected
      ? html`<option value="${role}" selected>${role}</option>`
      : html`<option value="${role}">${role}</option>`,
  )
  return html`<select name="role">${options}</select>`
}

/** One row: name, role, dates, and the per-admin owner actions. */
function adminRow(admin: AdminRecord, session: UiSession): Html {
  return html`<tr data-admin="${admin.name}">
    <td>${admin.name}</td>
    <td>${admin.role}</td>
    <td>${admin.createdAt}</td>
    <td>${admin.rotatedAt ?? '—'}</td>
    <td class="actions">
      ${roleForm(admin, session)}
      ${rotateForm(admin.name, session)}
      ${removeForm(admin.name, session)}
    </td>
  </tr>`
}

function roleForm(admin: AdminRecord, session: UiSession): Html {
  return html`<form method="post" action="/admins/role" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${admin.name}">
    ${roleSelect(admin.role)}
    <button type="submit">Set role</button>
  </form>`
}

function rotateForm(name: string, session: UiSession): Html {
  return html`<form method="post" action="/admins/rotate" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${name}">
    <button type="submit">Rotate token</button>
  </form>`
}

function removeForm(name: string, session: UiSession): Html {
  return html`<form method="post" action="/admins/remove" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="name" value="${name}">
    <button type="submit" class="danger">Remove</button>
  </form>`
}

/** The "add a new admin" form (issues a one-time token on submit). */
function addForm(session: UiSession): Html {
  return html`<form method="post" action="/admins/add" class="stacked">
    ${csrfField(session.csrfToken)}
    <label>New admin name <input type="text" name="name" required></label>
    <label>Role ${roleSelect('operator')}</label>
    <button type="submit">Add admin</button>
  </form>`
}

/** Full-page render of the admin roster and its management forms. */
export function renderAdminsPage(view: {
  readonly admins: readonly AdminRecord[]
  readonly session: UiSession
}): string {
  const { admins, session } = view
  const rows =
    admins.length === 0
      ? html`<tr><td colspan="5" class="none">no admins</td></tr>`
      : join(admins.map((admin) => adminRow(admin, session)))
  const content = html`
    <h1>Administrators</h1>
    <p class="hint">Personal tokens; one person, one token. A demoted or removed admin's sessions end immediately.</p>
    <div><h2>Add administrator</h2>${addForm(session)}</div>
    <table class="admin-roster">
      <thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Rotated</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `
  return renderLayout({
    title: 'Admins',
    content,
    csrfToken: session.csrfToken,
    currentAdmin: currentAdmin(session),
    activeNav: 'admins',
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
  const content = html`
    <section class="token-reveal">
      <h1>Admin “${view.admin}” ${view.action}</h1>
      <p class="warning">Save this token now — it is shown once and cannot be recovered.</p>
      <pre class="token" data-token>${view.token}</pre>
      <p><a href="${safeUrl('/admins')}">Back to admins</a></p>
    </section>
  `
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
  const content = html`
    <section class="notice ${view.ok ? 'ok' : 'error'}">
      <h1>${view.ok ? 'Done' : 'Could not complete the action'}</h1>
      <p>${view.message}</p>
      <p><a href="${safeUrl('/admins')}">Back to admins</a></p>
    </section>
  `
  return renderLayout({
    title: view.ok ? 'Admins' : 'Admins — error',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'admins',
  })
}
