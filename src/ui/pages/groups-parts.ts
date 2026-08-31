import type { AgentGrant } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The group card of the `/groups` page (M5.5 п.2, decision G4): the group's
 * per-server grant matrix and its member list, with the owner-only controls
 * that edit either.
 *
 * Every name here comes off disk (`groups.json`, `agents.json`) and is
 * untrusted for render — the escaping `html` template is the whole XSS defence,
 * exactly as on the agents page. `displayGrant` deliberately repeats the agents
 * card's cell rendering rather than importing it: `agents-parts.ts` keeps it
 * private, and a group grant IS an agent grant (G1), so the two must look
 * identical. Hoisting one shared cell helper is a safe later cleanup.
 */

/** One shared render context for every card on the page. */
export interface GroupCardContext {
  readonly csrfToken: string
  /** Owner-only controls (create/remove/grant/ungrant/join/leave) — G4. */
  readonly canManage: boolean
  /** Names of agents whose record is revoked; members are marked from this. */
  readonly revokedAgents: ReadonlySet<string>
}

/** Renders one grant dimension (`tools`/`resources`/`prompts`) as escaped cells. */
function displayGrant(value: AgentGrant['tools'] | AgentGrant['resources']): Html {
  if (value === undefined || value.length === 0) return html`<span class="faint">—</span>`
  if (value === '*') return html`<span class="pill pill-on">all</span>`
  return join(
    value.map((entry) => html`<code>${entry}</code>`),
    html` `,
  )
}

/** The owner's "drop this server from the group" control. */
function ungrantForm(group: string, server: string, ctx: GroupCardContext): Html {
  if (!ctx.canManage) return html``
  return html`<form method="post" action="/groups/ungrant" class="inline">
    ${csrfField(ctx.csrfToken)}
    <input type="hidden" name="group" value="${group}">
    <input type="hidden" name="server" value="${server}">
    <button type="submit" class="ghost">Ungrant</button>
  </form>`
}

/** One row of the group's server × (tools/resources/prompts) matrix. */
function grantRow(group: string, server: string, grant: AgentGrant, ctx: GroupCardContext): Html {
  return html`<tr data-server="${server}">
    <td class="gr-server">${server}</td>
    <td class="tools">${displayGrant(grant.tools)}</td>
    <td class="resources">${displayGrant(grant.resources)}</td>
    <td class="prompts">${displayGrant(grant.prompts)}</td>
    <td class="gr-ungrant">${ungrantForm(group, server, ctx)}</td>
  </tr>`
}

/** The whole grant table for one group (or an empty-state row). */
function grantTable(group: GroupRecord, ctx: GroupCardContext): Html {
  const servers = Object.keys(group.grants).sort()
  const rows =
    servers.length === 0
      ? html`<tr><td colspan="5" class="faint">no servers granted</td></tr>`
      : join(
          servers.map((server) =>
            grantRow(group.name, server, group.grants[server] as AgentGrant, ctx),
          ),
        )
  return html`<div class="table-wrap"><table class="grant-matrix gr-matrix">
    <thead><tr><th>Server</th><th>Tools</th><th>Resources</th><th>Prompts</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

/** The owner's "take this agent out of the group" control. */
function leaveForm(group: string, agent: string, ctx: GroupCardContext): Html {
  if (!ctx.canManage) return html``
  return html`<form method="post" action="/groups/leave" class="inline">
    ${csrfField(ctx.csrfToken)}
    <input type="hidden" name="group" value="${group}">
    <input type="hidden" name="agent" value="${agent}">
    <button type="submit" class="ghost">Leave</button>
  </form>`
}

/**
 * One member. A revoked agent is still SHOWN — membership outlives a revoke,
 * and an operator restoring the agent needs to see that the group would hand
 * it this access back — but it is marked, so the list is never read as "these
 * agents can reach these servers right now".
 */
function memberItem(group: GroupRecord, agent: string, ctx: GroupCardContext): Html {
  const badge = ctx.revokedAgents.has(agent) ? html`<span class="badge revoked">revoked</span>` : html``
  return html`<li class="gr-member"><span class="pill">${agent}</span>${badge}${leaveForm(group.name, agent, ctx)}</li>`
}

function memberList(group: GroupRecord, ctx: GroupCardContext): Html {
  if (group.members.length === 0) return html`<p class="empty">no members</p>`
  return html`<ul class="gr-member-list">${join(group.members.map((agent) => memberItem(group, agent, ctx)))}</ul>`
}

/** The owner's "remove this group" control; the handler confirms before it acts. */
function removeForm(group: GroupRecord, ctx: GroupCardContext): Html {
  if (!ctx.canManage) return html``
  return html`<div class="gr-foot"><form method="post" action="/groups/remove" class="inline">
    ${csrfField(ctx.csrfToken)}
    <input type="hidden" name="name" value="${group.name}">
    <button type="submit" class="danger">Remove group</button>
  </form></div>`
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * One group card. The `id` is the anchor `/agents` links an inherited grant row
 * to (`/groups#group-<name>`), and `data-filter-text` feeds the top-bar client
 * filter with the group's name plus every server and member it names, so
 * typing an agent name narrows the page to the groups that carry it.
 */
export function renderGroupCard(group: GroupRecord, ctx: GroupCardContext): Html {
  const servers = Object.keys(group.grants).sort()
  const filterText = [group.name, ...servers, ...group.members].join(' ')
  const meta = `${plural(servers.length, 'server')} · ${plural(group.members.length, 'member')}`
  return html`<details class="disclosure card gr-card" id="group-${group.name}" data-filter-item data-filter-text="${filterText}">
    <summary class="gr-sum">
      <span class="name pixel">${group.name}</span>
      <span class="muted small num">${meta}</span>
    </summary>
    <div class="gr-bd">
      ${grantTable(group, ctx)}
      <div class="gr-members"><span class="label">Members</span>${memberList(group, ctx)}</div>
      ${removeForm(group, ctx)}
    </div>
  </details>`
}

/** A labelled list of names for the removal interstitial and its refusal twin. */
export function renderNameList(label: string, names: readonly string[]): Html {
  if (names.length === 0) return html``
  const items = join(names.map((name) => html`<li><code>${name}</code></li>`))
  return html`<p class="small muted">${label}</p>
    <ul class="rows gr-holders">${items}</ul>`
}

/** A link that opens one of the page's overlay drawers (and works without JS). */
export function renderDrawerLink(targetId: string, param: string, label: string): Html {
  return html`<a class="btn-ghost" href="${safeUrl(`/groups?${param}=1#${targetId}`)}" data-open-details="${targetId}">${label}</a>`
}
