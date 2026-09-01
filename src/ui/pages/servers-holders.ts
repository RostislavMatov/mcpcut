import { html, join, safeUrl, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderInterstitial } from './interstitial.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { plural } from './plural.js'

/**
 * The pages that answer "who still names this server" (M5.5 п.2 + owner
 * decision T5, 2026-09-01): the remove confirmation, the prune interstitial
 * for a name the registry no longer knows, and the callout `server add` shows
 * when the name being registered is already granted.
 *
 * They live together, and apart from `pages/servers.ts`, because they share
 * one fact and one wording: a grant document can outlive the registration it
 * was written against, and every one of these screens exists to say so out
 * loud. Every agent, group and server name here is untrusted for render and
 * goes through the escaping `html` template.
 */

/** View model for the remove-with-grants confirmation interstitial. */
export interface RemoveWarningView {
  readonly serverName: string
  readonly agents: readonly string[]
  /**
   * Groups holding a grant for the server (G6). Optional so a caller that
   * predates groups still renders the agent half unchanged; the handler
   * always passes it.
   */
  readonly groups?: readonly string[]
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
}

/** One labelled list of holders, or nothing when that half is empty. */
function holderList(label: string, names: readonly string[]): Html {
  if (names.length === 0) return html``
  const items = join(names.map((name) => html`<li><code>${name}</code></li>`))
  return html`<p class="small muted">${label}</p>
    <ul class="rows srv-holders">${items}</ul>`
}

/**
 * The confirmation page shown when a server is still granted to agents or
 * groups: it names every affected holder and requires an explicit confirm,
 * because confirming CASCADES (G6) — the grants are dropped with the server,
 * not left pointing at something that no longer exists.
 */
export function renderRemoveWarning(view: RemoveWarningView): string {
  const groups = view.groups ?? []
  const content = renderInterstitial({
    panelClass: 'srv-confirm',
    cancelHref: '/servers',
    heading: html`Remove server “${view.serverName}”?`,
    // The count and the listed set are the SAME set — active agents — because
    // that is what the panel below names. The cascade is wider: it also drops
    // the dangling grants of revoked agents, which nothing here can list
    // meaningfully, so the sentence says so instead of quietly under-counting.
    warning: html`<p role="alert">
        Removing this server also removes it from
        ${plural(view.agents.length, 'active agent grant')}
        (revoked agents’ dangling grants are dropped too) and ${plural(groups.length, 'group')}:
      </p>`,
    details: html`${holderList('Agents', view.agents)}${holderList('Groups', groups)}`,
    form: html`<form method="post" action="/servers/remove">
        ${csrfField(view.csrfToken)}
        <input type="hidden" name="name" value="${view.serverName}" />
        <input type="hidden" name="confirm" value="true" />
        <div class="actions"><button type="submit" class="danger">Remove anyway</button></div>
      </form>`,
  })
  return renderLayout({
    title: 'Remove server',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'servers',
  })
}

/** View model for the prune interstitial of an unregistered-but-granted name. */
export interface PruneDanglingView {
  readonly serverName: string
  /** Agents whose grants still name the server, revoked ones included. */
  readonly agents: readonly string[]
  readonly groups: readonly string[]
  readonly csrfToken: string
  readonly currentAdmin: CurrentAdmin
}

/**
 * The page shown when `POST /servers/remove` names something the registry does
 * NOT hold, while agent or group grants still do — what a crashed cascade
 * leaves behind (three documents, no shared transaction).
 *
 * Pruning is offered, never performed on its own (owner decision T5): typing a
 * name into "remove" must not silently rewrite two other documents, and the
 * word "remove" must not quietly mean "repair". The explicit `prune=true` of
 * this form is the only thing that runs the cascade halves.
 */
export function renderPruneDangling(view: PruneDanglingView): string {
  const content = renderInterstitial({
    panelClass: 'srv-confirm',
    cancelHref: '/servers',
    cancelLabel: 'Leave them alone',
    heading: html`Prune dangling grants for “${view.serverName}”?`,
    warning: html`<p role="alert">
        “${view.serverName}” is not registered, but ${plural(view.agents.length, 'agent grant')}
        and ${plural(view.groups.length, 'group')} still name it. Nothing was removed: pruning
        drops the name from those grants and records the change in the journal.
      </p>`,
    details: html`${holderList('Agents', view.agents)}${holderList('Groups', view.groups)}`,
    form: html`<form method="post" action="/servers/remove">
        ${csrfField(view.csrfToken)}
        <input type="hidden" name="name" value="${view.serverName}" />
        <input type="hidden" name="prune" value="true" />
        <div class="actions"><button type="submit" class="danger">Prune dangling grants</button></div>
      </form>`,
  })
  return renderLayout({
    title: 'Prune dangling grants',
    content,
    csrfToken: view.csrfToken,
    currentAdmin: view.currentAdmin,
    activeNav: 'servers',
  })
}

/**
 * The `server add` callout (owner decision T3 — parity with the CLI's
 * `[warn] "x" is already granted to …`): registering a name that agents or
 * groups already grant silently hands those grantees whatever the name now
 * points at. That is the M3a threat, and the confirmation step is where it has
 * to be visible.
 *
 * Returns an empty fragment when nothing grants the name.
 */
export function renderGrantedElsewhereCallout(view: {
  readonly serverName: string
  readonly agents: readonly string[]
  readonly groups: readonly string[]
}): Html {
  if (view.agents.length === 0 && view.groups.length === 0) return html``
  return html`<p class="callout" role="alert">
    “${view.serverName}” is already granted to ${plural(view.agents.length, 'agent')}
    ${nameList(view.agents)} and ${plural(view.groups.length, 'group')} ${nameList(view.groups)}
    from an earlier registration — review on
    <a href="${safeUrl('/agents')}">/agents</a> and <a href="${safeUrl('/groups')}">/groups</a>
    after registering.
  </p>`
}

/** "(a, b)" — the holders by name, or nothing when that half is empty. */
function nameList(names: readonly string[]): Html {
  if (names.length === 0) return html``
  return html`(${join(
    names.map((name) => html`<code>${name}</code>`),
    html`, `,
  )})`
}
