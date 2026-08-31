import type { AgentRecord } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { ServerRecord } from '../../registry/schema.js'
import type { UiSession } from '../auth.js'
import { html, join, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderGroupDrawers, type GroupDrawerId } from './groups-form.js'
import { renderDrawerLink, renderGroupCard, renderNameList } from './groups-parts.js'
import { renderInterstitial } from './interstitial.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { plural } from './plural.js'

/**
 * The `/groups` page of the McpCut console (M5.5 п.2): one disclosure card per
 * server group, carrying the grants the group hands out and the agents that
 * inherit them, plus the owner's three edit drawers.
 *
 * Pure view layer — every function takes already-fetched records and returns
 * markup through the escaping `html` template. Group, agent and server names
 * all come off disk and are untrusted for render.
 *
 * There is no live region here: every action is a native POST answered with a
 * 303, exactly like `/agents`, so nothing on this page needs to be swapped in
 * place and no SSE topic exists for it to subscribe to.
 */

export { type GroupDrawerId } from './groups-form.js'

/** Longest search query echoed back into the top-bar box. */
const MAX_ECHOED_QUERY_CHARS = 200

export interface GroupsView {
  readonly groups: readonly GroupRecord[]
  /** Every agent, for the member badges and the join drawer's options. */
  readonly agents: readonly AgentRecord[]
  /** The registry, for the grant drawer's server options. */
  readonly servers: readonly ServerRecord[]
  readonly session: UiSession
  /** Owner-only editing (G4); `false` renders a read-only page. */
  readonly canManage: boolean
  /** Which drawer the query asked to open; ignored unless `canManage`. */
  readonly drawer?: GroupDrawerId
  /** Current search text, echoed into the top-bar box. */
  readonly query?: string
}

function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/** "N groups · M members" — the tab-bar meta; members are counted once each. */
function groupsMeta(groups: readonly GroupRecord[]): string {
  const members = new Set<string>()
  for (const group of groups) for (const member of group.members) members.add(member)
  return `${plural(groups.length, 'group')} · ${plural(members.size, 'member')}`
}

/** Names of agents whose record is revoked — the source of the member badges. */
function revokedAgentsOf(agents: readonly AgentRecord[]): ReadonlySet<string> {
  return new Set(agents.filter((agent) => agent.revokedAt !== undefined).map((agent) => agent.name))
}

/** The owner's two extra drawer openers (the `+` in the tab bar opens the third). */
function panelActions(view: GroupsView): Html {
  if (!view.canManage) return html``
  return html`${renderDrawerLink('grant-group', 'grant', 'Grant a server')}${renderDrawerLink('join-group', 'join', 'Add an agent')}`
}

function cardList(view: GroupsView): Html {
  if (view.groups.length === 0) return html`<p class="empty">no groups yet</p>`
  const ctx = {
    csrfToken: view.session.csrfToken,
    canManage: view.canManage,
    revokedAgents: revokedAgentsOf(view.agents),
  }
  return html`<div class="stack gr-list">${join(view.groups.map((group) => renderGroupCard(group, ctx)))}</div>`
}

/** Full-page render of the group list and (for an owner) its edit drawers. */
export function renderGroupsPage(view: GroupsView): string {
  const drawers = view.canManage
    ? renderGroupDrawers({
        groups: view.groups,
        agents: view.agents,
        servers: view.servers,
        csrfToken: view.session.csrfToken,
        ...(view.drawer !== undefined ? { open: view.drawer } : {}),
      })
    : html``
  const content = html`<section class="panel gr-panel" aria-label="Server groups">
    <div class="panel-hd">
      <h1>Server groups</h1>
      <span class="row">${panelActions(view)}<span class="small dim num">${groupsMeta(view.groups)}</span></span>
    </div>
    <div class="panel-bd">${cardList(view)}</div>
  </section>
  ${drawers}`
  const query = (view.query ?? '').slice(0, MAX_ECHOED_QUERY_CHARS)
  return renderLayout({
    title: 'Groups',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'groups',
    search: {
      action: '/groups',
      name: 'q',
      placeholder: 'search groups — name, server, agent',
      clientFilter: true,
      ...(query !== '' ? { value: query } : {}),
    },
    ...(view.canManage
      ? {
          navAction: {
            title: 'Create a group',
            targetId: 'create-group',
            href: '/groups?add=1#create-group',
          },
        }
      : {}),
    navMeta: groupsMeta(view.groups),
  })
}

/** What both removal answers need: the group at issue and the session. */
export interface GroupRemovalView {
  readonly group: GroupRecord
  readonly session: UiSession
}

/**
 * The confirmation shown before a group is removed. Removing a group is not
 * destructive to any agent's own grants, but it silently narrows whatever the
 * group was handing out, so the servers it grants are named before the act.
 */
export function renderGroupRemoveConfirm(view: GroupRemovalView): string {
  const servers = Object.keys(view.group.grants).sort()
  const content = renderInterstitial({
    panelClass: 'gr-confirm',
    cancelHref: '/groups',
    heading: html`Remove group “${view.group.name}”?`,
    warning: html`<p role="alert">
        This group grants ${plural(servers.length, 'server')}. Removing it takes those
        grants away from every agent that inherits them; personal grants are untouched.
      </p>`,
    details: renderNameList('Servers granted', servers),
    form: html`<form method="post" action="/groups/remove">
        ${csrfField(view.session.csrfToken)}
        <input type="hidden" name="name" value="${view.group.name}" />
        <input type="hidden" name="confirm" value="true" />
        <div class="actions"><button type="submit" class="danger">Remove it</button></div>
      </form>`,
  })
  return renderLayout({
    title: 'Remove group',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'groups',
  })
}

/**
 * The refusal shown when the group still has members (G3). The same panel with
 * NO confirm form: there is no "remove anyway" here, because a member's access
 * would change without anyone having named that member.
 */
export function renderGroupRemoveRefusal(view: GroupRemovalView): string {
  const content = renderInterstitial({
    panelClass: 'gr-confirm',
    cancelHref: '/groups',
    cancelLabel: 'Back to groups',
    heading: html`Group “${view.group.name}” still has members`,
    warning: html`<p role="alert">
        Remove ${plural(view.group.members.length, 'member')} from the group first — a
        group is deleted only once nobody inherits access from it.
      </p>`,
    details: renderNameList('Members', view.group.members),
    form: html``,
  })
  return renderLayout({
    title: 'Remove group',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'groups',
  })
}
