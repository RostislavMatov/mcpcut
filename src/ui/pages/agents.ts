import type { AgentRecord } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { ServeAddress } from '../../setup/serve-address.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import { html, type Html, join, safeUrl } from '../html.js'
import {
  renderAgentCard,
  renderCreateDrawer,
  renderGrantDrawer,
  renderGroupGrantDrawer,
} from './agents-parts.js'
import { renderTokenPageConfig } from './agents-config.js'
import { type CurrentAdmin, renderLayout } from './layout.js'
import { plural } from './plural.js'

/**
 * Server-rendered agent permission matrix (M4 Task 14; McpCut front
 * 2026-08-22). Pure view layer: every function here takes already-fetched data
 * and returns a complete HTML document string built exclusively through the
 * escaping `html` template — no store, no I/O, no bare string concatenation.
 * All agent/server/tool values originate on disk (agents.json) and are treated
 * as untrusted for render, so the default escaping of `html` is the whole XSS
 * defence for this page. Card and drawer markup lives in `agents-parts.ts`.
 */

/** Nav identity for the shared layout (both fields escaped downstream). */
function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/** The `<details>` id of the create form — also the nav `+` target. */
const CREATE_DRAWER_ID = 'create-agent'

/** The `<details>` id of the owner-only "add an agent to a group" form. */
const GROUP_DRAWER_ID = 'grant-group'

/**
 * The owner-only link to the admin-management page. `operator`/`viewer` never
 * see it (nor can they reach the route — ROUTE_TABLE pins `/admins` to owner);
 * the link is rendered by role here because the shared nav is fixed.
 */
function ownerAdminsLink(session: UiSession): Html {
  return session.role === 'owner'
    ? html`<a class="btn-ghost" href="${safeUrl('/admins')}">Manage admins</a>`
    : html``
}

/**
 * Editing the matrix — creating an agent, granting a server, adding an agent
 * to a group — is an owner-only action (G4 for membership, decision T4 for
 * personal grants). Below `owner` the drawers are not rendered at all: a form
 * the route would refuse with a 403 is worse than no form.
 */
function editDrawers(
  groups: readonly GroupRecord[],
  agents: readonly AgentRecord[],
  session: UiSession,
): Html {
  if (!roleSatisfies(session.role, 'owner')) return html``
  return html`<div class="grid-2 ag-drawers">
    ${renderCreateDrawer(CREATE_DRAWER_ID, session)}
    ${renderGrantDrawer('grant-server', session)}
    ${renderGroupGrantDrawer(GROUP_DRAWER_ID, { groups, agents, session })}
  </div>`
}

/** "N agents · M active" — the tab-bar meta. */
function agentsMeta(agents: readonly AgentRecord[]): string {
  const active = agents.filter((agent) => agent.revokedAt === undefined).length
  return `${plural(agents.length, 'agent')} · ${String(active)} active`
}

/**
 * Full-page render of the agent matrix and its edit drawers. `groups` is the
 * whole group list; each card derives its own effective rows from it. It
 * defaults to none so a caller with no groups store (and every pre-groups
 * render path) keeps producing exactly the personal matrix.
 */
export function renderAgentsPage(view: {
  readonly agents: readonly AgentRecord[]
  readonly groups?: readonly GroupRecord[]
  readonly session: UiSession
  /** The address every card's client config dials (ADR-0015, phase 4). */
  readonly serveAddress: ServeAddress
}): string {
  const { agents, session, serveAddress } = view
  const groups = view.groups ?? []
  const canManage = roleSatisfies(session.role, 'owner')
  const cards = agents.map((agent) => renderAgentCard({ agent, groups, canManage, session, serveAddress }))
  const list =
    agents.length === 0
      ? html`<p class="empty">no agents yet</p>`
      : html`<div class="stack ag-list">${join(cards)}</div>`
  const content = html`<section class="panel ag-panel" aria-label="Agent permissions">
    <div class="panel-hd">
      <h1>Agent permissions</h1>
      <span class="row">${ownerAdminsLink(session)}<span class="small dim num">${agentsMeta(agents)}</span></span>
    </div>
    <div class="panel-bd">
      ${editDrawers(groups, agents, session)}
      ${list}
    </div>
  </section>`
  return renderLayout({
    title: 'Agents',
    content,
    csrfToken: session.csrfToken,
    currentAdmin: currentAdmin(session),
    activeNav: 'agents',
    ...(canManage ? { navAction: { title: 'Create an agent', targetId: CREATE_DRAWER_ID } } : {}),
    navMeta: agentsMeta(agents),
  })
}

/**
 * The one-time token reveal after `create`. The plaintext token is interpolated
 * ONLY here, in the direct HTTP response to the create action, with a loud
 * warning; it is never persisted, logged or re-rendered on a later page load.
 * The client config under it carries the same token (ADR-0015, phase 4);
 * `warning` is the H4 slot for a dropped `agent.create` record (C6) — the
 * reveal cannot be swapped for a notice without losing the token.
 */
export function renderAgentTokenOnce(view: {
  readonly agent: string
  readonly token: string
  readonly session: UiSession
  readonly serveAddress: ServeAddress
  readonly warning?: string
}): string {
  const warning =
    view.warning === undefined ? html`` : html`<p class="notice-warning" role="alert">${view.warning}</p>`
  const content = html`<section class="panel panel-strong ag-token token-reveal" aria-label="Agent token">
    <div class="panel-hd"><h1>Agent “${view.agent}” created</h1><span class="label">shown once</span></div>
    <div class="panel-bd">
      <p class="callout">Save this token now — it is shown once and cannot be recovered.</p>
      <pre class="token" data-token>${view.token}</pre>
      ${warning}
      ${renderTokenPageConfig(view.serveAddress, view.token)}
      <p><a href="${safeUrl('/agents')}">Back to agents</a></p>
    </div>
  </section>`
  return renderLayout({
    title: 'Agent created',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'agents',
  })
}

/** A success/failure notice after grant/ungrant/revoke, with a link back. */
export function renderAgentNotice(view: {
  readonly message: string
  readonly ok: boolean
  readonly session: UiSession
}): string {
  const content = html`<section class="notice ${view.ok ? 'ok' : 'error'} ag-notice" role="status">
    <h1>${view.ok ? 'Done' : 'Could not complete the action'}</h1>
    <p>${view.message}</p>
    <p><a href="${safeUrl('/agents')}">Back to agents</a></p>
  </section>`
  return renderLayout({
    title: view.ok ? 'Agents' : 'Agents — error',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'agents',
  })
}
