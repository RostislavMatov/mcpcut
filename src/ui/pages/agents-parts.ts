import type { AgentGrant, AgentRecord } from '../../agents/schema.js'
import type { UiSession } from '../auth.js'
import { html, type Html, join } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The agent card and the two drawers of the agents page (McpCut front). Every
 * agent/server/pattern value comes from `agents.json` and is untrusted for
 * render; only the escaping `html` template touches markup.
 */

/** Renders one grant dimension (`tools`/`resources`/`prompts`) as escaped cells. */
function displayGrant(value: AgentGrant['tools'] | AgentGrant['resources']): Html {
  if (value === undefined || value.length === 0) return html`<span class="faint">—</span>`
  if (value === '*') return html`<span class="pill pill-on">all</span>`
  return join(
    value.map((entry) => html`<code>${entry}</code>`),
    html` `,
  )
}

/** A per-grant "remove this server" form; a ghost control so the row stays quiet. */
function ungrantForm(agentName: string, server: string, session: UiSession): Html {
  return html`<form method="post" action="/agents/ungrant" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="agent" value="${agentName}">
    <input type="hidden" name="server" value="${server}">
    <button type="submit" class="ghost">Ungrant</button>
  </form>`
}

/** One row of an agent's server × (tools/resources/prompts) matrix. */
function grantRow(agentName: string, server: string, grant: AgentGrant, session: UiSession): Html {
  return html`<tr data-server="${server}">
    <td class="ag-server">${server}</td>
    <td class="tools">${displayGrant(grant.tools)}</td>
    <td class="resources">${displayGrant(grant.resources)}</td>
    <td class="prompts">${displayGrant(grant.prompts)}</td>
    <td class="ag-ungrant">${ungrantForm(agentName, server, session)}</td>
  </tr>`
}

/** The whole grant table for one agent (or an empty-state row). */
function grantTable(agent: AgentRecord, session: UiSession): Html {
  const servers = Object.keys(agent.grants).sort()
  const rows =
    servers.length === 0
      ? html`<tr><td colspan="5" class="faint">no grants</td></tr>`
      : join(servers.map((server) => grantRow(agent.name, server, agent.grants[server] as AgentGrant, session)))
  return html`<div class="table-wrap"><table class="grant-matrix ag-matrix">
    <thead><tr><th>Server</th><th>Tools</th><th>Resources</th><th>Prompts</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

/** A per-agent "revoke this agent" form (card footer, dashed outline). */
function revokeForm(agentName: string, session: UiSession): Html {
  return html`<form method="post" action="/agents/revoke" class="inline">
    ${csrfField(session.csrfToken)}
    <input type="hidden" name="agent" value="${agentName}">
    <button type="submit" class="danger">Revoke agent</button>
  </form>`
}

/** One agent card: name, revoked badge, its matrix, and its revoke action. */
export function renderAgentCard(agent: AgentRecord, session: UiSession): Html {
  const revoked = agent.revokedAt !== undefined
  const badge = revoked ? html`<span class="badge revoked">revoked</span>` : html``
  const grantCount = Object.keys(agent.grants).length
  const footer = revoked
    ? html`<span class="faint small num" title="${agent.revokedAt ?? ''}">revoked ${agent.revokedAt ?? ''}</span>`
    : revokeForm(agent.name, session)
  return html`<section class="card agent ag-card" data-agent="${agent.name}">
    <div class="card-hd">
      <span class="name">${agent.name}</span>
      ${badge}
      <span class="muted small num">${String(grantCount)} server${grantCount === 1 ? '' : 's'} granted</span>
    </div>
    ${grantTable(agent, session)}
    <div class="ag-foot">${footer}</div>
  </section>`
}

/** The "create a new agent" drawer (issues a one-time token on submit). */
export function renderCreateDrawer(id: string, session: UiSession): Html {
  return html`<details class="drawer" id="${id}">
    <summary>Create an agent</summary>
    <div class="drawer-bd">
      <form method="post" action="/agents/create" class="stacked">
        ${csrfField(session.csrfToken)}
        <label><span>Agent name</span><input type="text" name="name" required placeholder="research-bot"></label>
        <p class="field-hint">The agent's token is shown once, right after creation.</p>
        <div class="form-actions"><button type="submit">Create agent</button></div>
      </form>
    </div>
  </details>`
}

/**
 * The "grant a server to an agent" drawer. Tools/resources/prompts are entered as
 * whitespace/comma-separated patterns; a lone `*` means "everything". Leaving a
 * field empty leaves that dimension absent (M3 fail-closed for that method).
 */
export function renderGrantDrawer(id: string, session: UiSession): Html {
  return html`<details class="drawer" id="${id}">
    <summary>Grant a server</summary>
    <div class="drawer-bd">
      <form method="post" action="/agents/grant" class="stacked">
        ${csrfField(session.csrfToken)}
        <div class="ag-grant-who">
          <label><span>Agent</span><input type="text" name="agent" required></label>
          <label><span>Server</span><input type="text" name="server" required></label>
        </div>
        <div class="ag-grant-dims">
          <label><span>Tools</span><input type="text" name="tools" placeholder="* or foo, bar_*"></label>
          <label><span>Resources</span><input type="text" name="resources" placeholder="file:///a/*"></label>
          <label><span>Prompts</span><input type="text" name="prompts" placeholder="* or greet"></label>
        </div>
        <p class="field-hint">A lone <code>*</code> grants everything in that dimension; an empty field leaves it denied.</p>
        <div class="form-actions"><button type="submit">Grant</button></div>
      </form>
    </div>
  </details>`
}
