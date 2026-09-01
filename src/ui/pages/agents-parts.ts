import { effectiveGrantsOf, type EffectiveGrants, type GrantSource } from '../../agents/effective.js'
import type { AgentGrant, AgentRecord } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { UiSession } from '../auth.js'
import { html, type Html, join, safeUrl } from '../html.js'
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

/** "group:a, group:b" — one label per contributing group, escaped. */
function groupLabels(names: readonly string[]): Html {
  return join(
    names.map((name) => html`group:${name}`),
    html`, `,
  )
}

/**
 * The provenance cell (G2): a personal grant reads `agent` and, when it took a
 * server the agent also inherits, names the groups it overrode; an inherited
 * row names every group that contributed to the union.
 */
function sourceCell(source: GrantSource): Html {
  if (source.kind === 'group') {
    return html`<td class="ag-source">${groupLabels(source.groups)}</td>`
  }
  const hint =
    source.shadowedGroups.length === 0
      ? html``
      : html`<span class="small dim">overrides ${groupLabels(source.shadowedGroups)}</span>`
  return html`<td class="ag-source">agent${hint}</td>`
}

/**
 * The trailing action cell. An inherited row has nothing to ungrant HERE — the
 * grant belongs to the group — so it links to the group's card instead of
 * offering a control that would silently do nothing. Below `owner` the
 * personal row keeps its (empty) cell rather than losing a column: the matrix
 * stays readable, it simply stops being editable (decision T4).
 */
function actionCell(row: {
  readonly agentName: string
  readonly server: string
  readonly source: GrantSource
  readonly canManage: boolean
  readonly session: UiSession
}): Html {
  const { agentName, server, source, canManage, session } = row
  if (source.kind === 'agent') {
    const control = canManage ? ungrantForm(agentName, server, session) : html``
    return html`<td class="ag-ungrant">${control}</td>`
  }
  const group = source.groups[0] ?? ''
  return html`<td class="ag-ungrant"><a class="small" href="${safeUrl(`/groups#group-${group}`)}">manage in groups</a></td>`
}

/** One row of an agent's server × (tools/resources/prompts/source) matrix. */
function grantRow(row: {
  readonly agentName: string
  readonly server: string
  readonly grant: AgentGrant
  readonly source: GrantSource
  readonly canManage: boolean
  readonly session: UiSession
}): Html {
  const { agentName, server, grant, source, canManage, session } = row
  return html`<tr data-server="${server}">
    <td class="ag-server">${server}</td>
    <td class="tools">${displayGrant(grant.tools)}</td>
    <td class="resources">${displayGrant(grant.resources)}</td>
    <td class="prompts">${displayGrant(grant.prompts)}</td>
    ${sourceCell(source)}
    ${actionCell({ agentName, server, source, canManage, session })}
  </tr>`
}

/** A server present in the matrix but not in `sources` can only be personal. */
const PERSONAL_SOURCE: GrantSource = { kind: 'agent', shadowedGroups: [] }

/** The whole effective grant table for one agent (or an empty-state row). */
function grantTable(view: {
  readonly agentName: string
  readonly effective: EffectiveGrants
  readonly canManage: boolean
  readonly session: UiSession
}): Html {
  const { agentName, effective, canManage, session } = view
  const servers = Object.keys(effective.grants).sort()
  const rows =
    servers.length === 0
      ? html`<tr><td colspan="6" class="faint">no grants</td></tr>`
      : join(
          servers.map((server) =>
            grantRow({
              agentName,
              server,
              grant: effective.grants[server] as AgentGrant,
              source: effective.sources[server] ?? PERSONAL_SOURCE,
              canManage,
              session,
            }),
          ),
        )
  return html`<div class="table-wrap"><table class="grant-matrix ag-matrix">
    <thead><tr><th>Server</th><th>Tools</th><th>Resources</th><th>Prompts</th><th>Source</th><th></th></tr></thead>
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

/**
 * One agent card: name, revoked badge, its EFFECTIVE matrix (personal grants
 * widened by the groups it belongs to) and its revoke action. `groups` may be
 * every group of the installation — `effectiveGrantsOf` ignores the ones this
 * agent is not a member of.
 */
export function renderAgentCard(view: {
  readonly agent: AgentRecord
  readonly groups: readonly GroupRecord[]
  /** `owner` only (decision T4): below it the card is a read-only matrix. */
  readonly canManage: boolean
  readonly session: UiSession
}): Html {
  const { agent, groups, canManage, session } = view
  const revoked = agent.revokedAt !== undefined
  const badge = revoked ? html`<span class="badge revoked">revoked</span>` : html``
  const effective = effectiveGrantsOf(agent, groups)
  const grantCount = Object.keys(effective.grants).length
  const footer = revoked
    ? html`<span class="faint small num" title="${agent.revokedAt ?? ''}">revoked ${agent.revokedAt ?? ''}</span>`
    : canManage
      ? revokeForm(agent.name, session)
      : html``
  return html`<section class="card agent ag-card" data-agent="${agent.name}">
    <div class="card-hd">
      <span class="name">${agent.name}</span>
      ${badge}
      <span class="muted small num">${String(grantCount)} server${grantCount === 1 ? '' : 's'} granted</span>
    </div>
    ${grantTable({ agentName: agent.name, effective, canManage, session })}
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

/** `<option>` list for a native select; every value is escaped by `html`. */
function options(values: readonly string[]): Html {
  return join(values.map((value) => html`<option value="${value}">${value}</option>`))
}

/**
 * The owner-only "grant by group" drawer. It does not edit grants at all — it
 * adds an agent to a group, so the single membership path stays `POST
 * /groups/join` (no second way to join from the agents page). With no group to
 * pick, the select is replaced by a pointer to `/groups`: an empty select would
 * be a control that cannot succeed.
 */
export function renderGroupGrantDrawer(
  id: string,
  view: {
    readonly groups: readonly GroupRecord[]
    readonly agents: readonly AgentRecord[]
    readonly session: UiSession
  },
): Html {
  const groupField =
    view.groups.length === 0
      ? html`<p class="field-hint">no groups yet — create one on <a href="${safeUrl('/groups')}">/groups</a></p>`
      : html`<label><span>Group</span><select name="group" required>${options(view.groups.map((group) => group.name))}</select></label>`
  const agentNames = view.agents
    .filter((agent) => agent.revokedAt === undefined)
    .map((agent) => agent.name)
  return html`<details class="drawer" id="${id}">
    <summary>Grant by group</summary>
    <div class="drawer-bd">
      <form method="post" action="/groups/join" class="stacked">
        ${csrfField(view.session.csrfToken)}
        <div class="ag-grant-who">
          ${groupField}
          <label><span>Agent</span><select name="agent" required>${options(agentNames)}</select></label>
        </div>
        <p class="field-hint">The agent inherits every server the group grants, unless it holds its own grant for that server.</p>
        <div class="form-actions"><button type="submit">Add to group</button></div>
      </form>
    </div>
  </details>`
}
