import { html, safeUrl, type Html } from '../../../src/ui/html.js'
import { csrfField } from './csrf-field.js'
import { renderHubLayout } from './layout.js'

/**
 * The `/account/delete` confirmation page: a visitor types their own GitHub
 * login to confirm, the same "type the name back" pattern the console uses
 * for a destructive action (`renderInterstitial` in `src/ui/pages/
 * interstitial.ts`) — not imported (that module is not on the H1 allowlist),
 * but the shape is deliberately the same: an unmissable consequence, the
 * confirming field, and a way back that changes nothing.
 */
export interface AccountDeleteConfirmView {
  readonly login: string
  readonly csrfToken: string
  /** Set after a refusal (e.g. the typed login did not match). */
  readonly error?: string
}

function renderBanner(error: string | undefined): Html {
  return error === undefined ? html`` : html`<p class="error" role="alert">${error}</p>`
}

/** Renders the complete `/account/delete` HTML document. */
export function renderAccountDeleteConfirmPage(view: AccountDeleteConfirmView): string {
  const content = html`
    <section class="panel panel-strong hub-danger">
      <div class="panel-hd"><h1>Delete account</h1></div>
      <div class="panel-bd">
        <p class="callout">This removes your install and everything in it — servers, agents, journal, report. This cannot be undone.</p>
        ${renderBanner(view.error)}
        <form method="post" action="/account/delete">
          ${csrfField(view.csrfToken)}
          <label>
            <span>Type your GitHub login to confirm</span>
            <input
              name="login"
              type="text"
              placeholder="${view.login}"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              required
            />
          </label>
          <button type="submit" class="danger">Delete account</button>
        </form>
        <p><a href="${safeUrl('/account')}">Cancel</a></p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Delete account',
    content,
    csrfToken: view.csrfToken,
    signedIn: true,
    activeNav: 'account',
  })
}
