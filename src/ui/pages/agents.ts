import type { AgentGrant, AgentRecord } from '../../agents/schema.js'
import type { UiSession } from '../auth.js'
import { html, type Html, join, safeUrl } from '../html.js'
import { type CurrentAdmin, renderLayout } from './layout.js'

/**
 * Server-rendered agent permission matrix (M4 Task 14). Pure view layer: every
 * function here takes already-fetched data and returns a complete HTML document
 * string built exclusively through the escaping `html` template — no store, no
 * I/O, no bare string concatenation. All agent/server/tool values originate on
 * disk (agents.json) and are treated as untrusted for render, so the default
 * escaping of `html` is the whole XSS defence for this page.
 */

/** Nav identity for the shared layout (both fields escaped downstream). */
function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/** The hidden anti-CSRF field every state-changing form embeds. */
function csrfField(session: UiSession): Html {
  return html`<input type="hidden" name="csrf_token" value="${session.csrfToken}">`
}

/**
 * The owner-only link to the admin-management page. `operator`/`viewer` never
 * see it (nor can they reach the route — ROUTE_TABLE pins `/admins` to owner);
 * the link is rendered by role here because the shared nav is fixed.
 */
function ownerAdminsLink(session: UiSession): Html {
  return session.role === 'owner'
    ? html`<p class="owner-links"><a href="${safeUrl('/admins')}">Manage admins</a></p>`
    : html``
}

/** Renders one grant dimension (`tools`/`resources`/`prompts`) as escaped cells. */
function displayGrant(value: AgentGrant['tools'] | AgentGrant['resources']): Html {
  if (value === undefined) return html`<span class="none">—</span>`
  if (value === '*') return html`<span class="all">all</span>`
  if (value.length === 0) return html`<span class="none">—</span>`
  return join(
    value.map((entry) => html`<code>${entry}</code>`),
    html`, `,
  )
}

/** A per-grant "remove this server" form. */
function ungrantForm(agentName: string, server: string, session: UiSession): Html {
  return html`<form method="post" action="/agents/ungrant" class="inline">
    ${csrfField(session)}
    <input type="hidden" name="agent" value="${agentName}">
    <input type="hidden" name="server" value="${server}">
    <button type="submit">Ungrant</button>
  </form>`
}

/** One row of an agent's server × (tools/resources/prompts) matrix. */
function grantRow(agentName: string, server: string, grant: AgentGrant, session: UiSession): Html {
  return html`<tr data-server="${server}">
    <td>${server}</td>
    <td class="tools">${displayGrant(grant.tools)}</td>
    <td class="resources">${displayGrant(grant.resources)}</td>
    <td class="prompts">${displayGrant(grant.prompts)}</td>
    <td>${ungrantForm(agentName, server, session)}</td>
  </tr>`
}

/** The whole grant table for one agent (or an empty-state row). */
function grantTable(agent: AgentRecord, session: UiSession): Html {
  const servers = Object.keys(agent.grants).sort()
  const rows =
    servers.length === 0
      ? html`<tr><td colspan="5" class="none">no grants</td></tr>`
      : join(servers.map((server) => grantRow(agent.name, server, agent.grants[server] as AgentGrant, session)))
  return html`<table class="grant-matrix">
    <thead><tr><th>Server</th><th>Tools</th><th>Resources</th><th>Prompts</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

/** A per-agent "revoke this agent" form. */
function revokeForm(agentName: string, session: UiSession): Html {
  return html`<form method="post" action="/agents/revoke" class="inline">
    ${csrfField(session)}
    <input type="hidden" name="agent" value="${agentName}">
    <button type="submit" class="danger">Revoke agent</button>
  </form>`
}

/** One agent block: name, revoked badge, its matrix, and its revoke action. */
function agentSection(agent: AgentRecord, session: UiSession): Html {
  const revoked = agent.revokedAt ? html`<span class="badge revoked">revoked</span>` : html``
  return html`<section class="agent" data-agent="${agent.name}">
    <h3>${agent.name} ${revoked}</h3>
    ${grantTable(agent, session)}
    ${agent.revokedAt ? html`` : revokeForm(agent.name, session)}
  </section>`
}

/** The "create a new agent" form (issues a one-time token on submit). */
function createForm(session: UiSession): Html {
  return html`<form method="post" action="/agents/create" class="stacked">
    ${csrfField(session)}
    <label>New agent name <input type="text" name="name" required></label>
    <button type="submit">Create agent</button>
  </form>`
}

/**
 * The "grant a server to an agent" form. Tools/resources/prompts are entered as
 * whitespace/comma-separated patterns; a lone `*` means "everything". Leaving a
 * field empty leaves that dimension absent (M3 fail-closed for that method).
 */
function grantForm(session: UiSession): Html {
  return html`<form method="post" action="/agents/grant" class="stacked">
    ${csrfField(session)}
    <label>Agent <input type="text" name="agent" required></label>
    <label>Server <input type="text" name="server" required></label>
    <label>Tools <input type="text" name="tools" placeholder="* or foo, bar_*"></label>
    <label>Resources <input type="text" name="resources" placeholder="file:///a/*"></label>
    <label>Prompts <input type="text" name="prompts" placeholder="* or greet"></label>
    <button type="submit">Grant</button>
  </form>`
}

/** Full-page render of the agent matrix and its edit forms. */
export function renderAgentsPage(view: {
  readonly agents: readonly AgentRecord[]
  readonly session: UiSession
}): string {
  const { agents, session } = view
  const sections =
    agents.length === 0
      ? html`<p class="none">no agents yet</p>`
      : join(agents.map((agent) => agentSection(agent, session)))
  const content = html`
    ${ownerAdminsLink(session)}
    <h1>Agent permissions</h1>
    <div class="agent-actions">
      <div><h2>Create agent</h2>${createForm(session)}</div>
      <div><h2>Grant a server</h2>${grantForm(session)}</div>
    </div>
    <div class="agent-list">${sections}</div>
  `
  return renderLayout({
    title: 'Agents',
    content,
    csrfToken: session.csrfToken,
    currentAdmin: currentAdmin(session),
    activeNav: 'agents',
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
  const content = html`
    <section class="token-reveal">
      <h1>Agent “${view.agent}” created</h1>
      <p class="warning">Save this token now — it is shown once and cannot be recovered.</p>
      <pre class="token" data-token>${view.token}</pre>
      <p><a href="${safeUrl('/agents')}">Back to agents</a></p>
    </section>
  `
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
  const content = html`
    <section class="notice ${view.ok ? 'ok' : 'error'}">
      <h1>${view.ok ? 'Done' : 'Could not complete the action'}</h1>
      <p>${view.message}</p>
      <p><a href="${safeUrl('/agents')}">Back to agents</a></p>
    </section>
  `
  return renderLayout({
    title: view.ok ? 'Agents' : 'Agents — error',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'agents',
  })
}
