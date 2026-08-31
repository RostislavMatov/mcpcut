import type { AgentGrant } from '../../agents/schema.js'
import type { UiSession } from '../auth.js'
import { html, join, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderInterstitial } from './interstitial.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { plural } from './plural.js'

/**
 * The confirmation shown when "Ungrant" would WIDEN access instead of
 * narrowing it (U1).
 *
 * Per ADR-0010 §2 a personal grant takes its server whole, shadowing whatever
 * the agent's groups grant for it. Removing that personal grant therefore does
 * not deny the server — it hands the agent the (unioned, usually wider) group
 * grant instead. The matrix button says "Ungrant", the operator reads
 * "de-escalation", and the two disagree. This panel is where they are made to
 * agree, before the write.
 *
 * Every value here is untrusted for render: group names come off `groups.json`
 * and grant patterns off either document, so all of it goes through `html`.
 */

/** Nav identity for the shared layout. */
function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

export interface UngrantConfirmView {
  readonly agent: string
  readonly server: string
  /** The groups whose grant the personal one shadows, in `listGroups` order. */
  readonly groups: readonly string[]
  /** The merged group grant the agent falls back to once the personal one is gone. */
  readonly fallback: AgentGrant
  readonly session: UiSession
}

/** One grant dimension as escaped cells; same vocabulary as the group matrix. */
function displayGrant(value: AgentGrant['tools'] | AgentGrant['resources']): Html {
  if (value === undefined || value.length === 0) return html`<span class="faint">—</span>`
  if (value === '*') return html`<span class="pill pill-on">all</span>`
  return join(
    value.map((entry) => html`<code>${entry}</code>`),
    html` `,
  )
}

/** The fallback grant, dimension by dimension — what access actually becomes. */
function renderFallback(grant: AgentGrant): Html {
  return html`<p class="small muted">Falls back to</p>
    <div class="table-wrap">
      <table class="ag-fallback">
        <tbody>
          <tr><th scope="row">tools</th><td>${displayGrant(grant.tools)}</td></tr>
          <tr><th scope="row">resources</th><td>${displayGrant(grant.resources)}</td></tr>
          <tr><th scope="row">prompts</th><td>${displayGrant(grant.prompts)}</td></tr>
        </tbody>
      </table>
    </div>`
}

function renderGroupList(groups: readonly string[]): Html {
  const items = join(groups.map((name) => html`<li><code>group:${name}</code></li>`))
  return html`<p class="small muted">Inherited from</p>
    <ul class="rows ag-holders">${items}</ul>`
}

export function renderUngrantConfirm(view: UngrantConfirmView): string {
  const content = renderInterstitial({
    panelClass: 'ag-confirm',
    cancelHref: '/agents',
    cancelLabel: 'Cancel',
    heading: html`Remove “${view.server}” from “${view.agent}”?`,
    warning: html`<p role="alert">
        This personal grant OVERRIDES ${plural(view.groups.length, 'group grant')}. Removing it does
        not deny access — ${view.agent} keeps ${view.server} through
        ${view.groups.length === 1 ? 'that group' : 'those groups'}, with the grant below. To deny
        the server outright, remove ${view.agent} from
        ${view.groups.length === 1 ? 'the group' : 'the groups'} as well, or deny the tools in
        policy.
      </p>`,
    details: html`${renderGroupList(view.groups)}${renderFallback(view.fallback)}`,
    form: html`<form method="post" action="/agents/ungrant">
        ${csrfField(view.session.csrfToken)}
        <input type="hidden" name="agent" value="${view.agent}" />
        <input type="hidden" name="server" value="${view.server}" />
        <input type="hidden" name="confirm" value="true" />
        <div class="actions"><button type="submit" class="danger">Remove it anyway</button></div>
      </form>`,
  })
  return renderLayout({
    title: 'Remove personal grant',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    activeNav: 'agents',
  })
}
