import type { AgentRecord } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import { html, type Html, join, safeUrl } from '../html.js'
import {
  renderAgentCard,
  renderCreateDrawer,
  renderGrantDrawer,
  renderGroupGrantDrawer,
} from './agents-parts.js'
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
 * Membership is an owner-only edit (G4), so `operator`/`viewer` are not shown
 * a form the route would refuse anyway.
 */
function byGroupDrawer(
  groups: readonly GroupRecord[],
  agents: readonly AgentRecord[],
  session: UiSession,
): Html {
  const canManageGroups = roleSatisfies(session.role, 'owner')
  return canManageGroups ? renderGroupGrantDrawer(GROUP_DRAWER_ID, { groups, agents, session }) : html``
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
}): string {
  const { agents, session } = view
  const groups = view.groups ?? []
  const list =
    agents.length === 0
      ? html`<p class="empty">no agents yet</p>`
      : html`<div class="stack ag-list">${join(agents.map((agent) => renderAgentCard(agent, groups, session)))}</div>`
  const content = html`<section class="panel ag-panel" aria-label="Agent permissions">
    <div class="panel-hd">
      <h1>Agent permissions</h1>
      <span class="row">${ownerAdminsLink(session)}<span class="small dim num">${agentsMeta(agents)}</span></span>
    </div>
    <div class="panel-bd">
      <div class="grid-2 ag-drawers">
        ${renderCreateDrawer(CREATE_DRAWER_ID, session)}
        ${renderGrantDrawer('grant-server', session)}
        ${byGroupDrawer(groups, agents, session)}
      </div>
      ${list}
    </div>
  </section>`
  return renderLayout({
    title: 'Agents',
    content,
    csrfToken: session.csrfToken,
    currentAdmin: currentAdmin(session),
    activeNav: 'agents',
    navAction: { title: 'Create an agent', targetId: CREATE_DRAWER_ID },
    navMeta: agentsMeta(agents),
  })
}

/**
 * The one-time token reveal after `create`. The plaintext token is interpolated
 * ONLY here, in the direct HTTP response to the create action, with a loud
 * warning; it is never persisted, logged or re-rendered on a later page load.
 */
export function renderAgentTokenOnce(view: {
  readonly agent: string
  readonly token: string
  readonly session: UiSession
}): string {
  const content = html`<section class="panel panel-strong ag-token token-reveal" aria-label="Agent token">
    <div class="panel-hd"><h1>Agent “${view.agent}” created</h1><span class="label">shown once</span></div>
    <div class="panel-bd">
      <p class="callout">Save this token now — it is shown once and cannot be recovered.</p>
      <pre class="token" data-token>${view.token}</pre>
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
