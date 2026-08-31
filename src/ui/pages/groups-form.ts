import type { AgentRecord } from '../../agents/schema.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { ServerRecord } from '../../registry/schema.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The three owner-only overlay drawers of `/groups` (M5.5 п.2): create a
 * group, grant it a server, add an agent to it.
 *
 * They mirror the servers page's register drawer exactly — a `<details>` whose
 * summary is visually hidden and whose body is a fixed-position modal — so the
 * no-JS path is the same one: the tab bar's `+` (and the two panel links) point
 * at `/groups?add=1#create-group`, and the handler renders that drawer `open`.
 * The element+class selector `details.gr-drawer` is deliberate: the shared
 * `details.drawer` rule in `components.ts` out-specifies a bare class, and a
 * closed overlay that loses that fight leaves a bordered sliver on the page.
 */

/** What the three drawers need: the lists they offer and the session's token. */
export interface GroupDrawersView {
  readonly groups: readonly GroupRecord[]
  readonly agents: readonly AgentRecord[]
  readonly servers: readonly ServerRecord[]
  readonly csrfToken: string
  /** Which drawer (if any) a `?add=1` / `?grant=1` / `?join=1` asked to open. */
  readonly open?: GroupDrawerId
}

/** The `<details>` ids, which are also the no-JS anchor targets. */
export type GroupDrawerId = 'create-group' | 'grant-group' | 'join-group'

/** The modal chrome shared by all three drawers. */
function drawer(id: GroupDrawerId, title: string, open: boolean, body: Html): Html {
  const openAttr = open ? html` open` : html``
  return html`<details class="drawer gr-drawer" id="${id}"${openAttr}>
    <summary class="gr-drawer-sum">${title}</summary>
    <div class="drawer-bd gr-modal">
      <div class="gr-modal-hd"><span class="pixel upper">${title}</span><a class="icon gr-modal-x" href="${safeUrl('/groups')}" data-close-details="${id}" title="Close">×</a></div>
      ${body}
    </div>
  </details>`
}

/** A `<select>` of names; the first option is the empty "choose one" prompt. */
function nameSelect(name: string, label: string, options: readonly string[]): Html {
  const items = join(options.map((value) => html`<option value="${value}">${value}</option>`))
  return html`<div class="field"><label><span>${label}</span><select name="${name}" required><option value="">—</option>${items}</select></label></div>`
}

/** The cancel/submit pair; cancel is a real link so it works without JS. */
function actions(id: GroupDrawerId, submitLabel: string): Html {
  return html`<div class="form-actions">
    <a class="btn btn-secondary" href="${safeUrl('/groups')}" data-close-details="${id}">Cancel</a>
    <button type="submit">${submitLabel}</button>
  </div>`
}

/** "Create a group": the name is the only field a new group has. */
function createBody(view: GroupDrawersView): Html {
  return html`<form method="post" action="${safeUrl('/groups/create')}" class="gr-form">
    ${csrfField(view.csrfToken)}
    <div class="field">
      <label><span>name</span><input type="text" name="name" required placeholder="analytics"></label>
      <span class="field-hint">lowercase, digits and hyphens · up to 64 chars</span>
    </div>
    ${actions('create-group', 'Create group')}
  </form>`
}

/**
 * "Grant a server to a group": the same three pattern fields as the agents
 * grant drawer, with the same asymmetric defaults — a lone `*` grants
 * everything in that dimension, an empty field leaves it denied (M3).
 */
function grantBody(view: GroupDrawersView): Html {
  return html`<form method="post" action="${safeUrl('/groups/grant')}" class="gr-form">
    ${csrfField(view.csrfToken)}
    <div class="gr-grant-who">
      ${nameSelect('group', 'Group', view.groups.map((group) => group.name))}
      ${nameSelect('server', 'Server', view.servers.map((server) => server.name))}
    </div>
    <div class="gr-grant-dims">
      <div class="field"><label><span>Tools</span><input type="text" name="tools" placeholder="* or foo, bar_*"></label></div>
      <div class="field"><label><span>Resources</span><input type="text" name="resources" placeholder="file:///a/*"></label></div>
      <div class="field"><label><span>Prompts</span><input type="text" name="prompts" placeholder="* or greet"></label></div>
    </div>
    <p class="field-hint">A lone <code>*</code> grants everything in that dimension; an empty field leaves it denied.</p>
    ${actions('grant-group', 'Grant')}
  </form>`
}

/**
 * "Add an agent to a group". Revoked agents are NOT offered: the group would
 * hand back access the revoke just took away, and the handler refuses it too —
 * the form simply stops it being the obvious thing to try.
 */
function joinBody(view: GroupDrawersView): Html {
  const active = view.agents.filter((agent) => agent.revokedAt === undefined).map((agent) => agent.name)
  return html`<form method="post" action="${safeUrl('/groups/join')}" class="gr-form">
    ${csrfField(view.csrfToken)}
    <div class="gr-grant-who">
      ${nameSelect('group', 'Group', view.groups.map((group) => group.name))}
      ${nameSelect('agent', 'Agent', active)}
    </div>
    <p class="field-hint">The agent inherits every grant the group carries. Its token does not change — the journal still attributes each call to the agent.</p>
    ${actions('join-group', 'Add to group')}
  </form>`
}

/**
 * All three drawers, always rendered for an owner and closed unless the query
 * asked for one. They are siblings of the card list, never nested in a card: a
 * closed `<details>` renders none of its content, so a drawer inside a
 * collapsed card would be invisible on exactly the no-JS path it exists for.
 */
export function renderGroupDrawers(view: GroupDrawersView): Html {
  return html`${drawer('create-group', 'Create a group', view.open === 'create-group', createBody(view))}
    ${drawer('grant-group', 'Grant a server to a group', view.open === 'grant-group', grantBody(view))}
    ${drawer('join-group', 'Add an agent to a group', view.open === 'join-group', joinBody(view))}`
}
