import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'
import { consoleLink } from './links.js'

/**
 * The one-time owner-token reveal — the answer to a successful account
 * creation and to `POST /account/token` (rotate). Mirrors the console's
 * `renderSetupDonePage` (`src/ui/pages/setup.ts`): the token is interpolated
 * here and nowhere else in the response, and the page states plainly that it
 * will not be shown again.
 */
export interface TokenOnceView {
  readonly login: string
  /** The one-time plaintext owner token. */
  readonly token: string
  readonly csrfToken: string
  /** The tenant's console, e.g. `https://alice.mcpcut.com` — where the token signs in. */
  readonly serveUrl: string
}

/** Renders the complete token-reveal HTML document. */
export function renderTokenOncePage(view: TokenOnceView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>Owner token</h1></div>
      <div class="panel-bd">
        <p class="callout">Save this token now — it is shown once and cannot be recovered. It is the admin credential for @${view.login}'s install.</p>
        <pre class="token" data-token>${view.token}</pre>
        <p>Next: sign in to your console at ${consoleLink(view.serveUrl)} with it.</p>
        <p><a href="${safeUrl('/account')}">Continue to your account</a></p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Owner token',
    content,
    csrfToken: view.csrfToken,
    signedIn: true,
    activeNav: 'account',
  })
}
