import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'

/**
 * "Your install is being prepared" (plan `hosted-path-and-ops`, Task A, P1):
 * the answer to a new person's GitHub callback, and `/account`'s answer for
 * as long as the account is `pending`. The install is made in the background
 * — it can take longer than Cloudflare waits for an answer — so this page
 * refreshes itself to `/account` every few seconds until `/account` has
 * something else to say: the owner token, once, or that creation failed.
 *
 * From the callback this is also the same-site hand-over `signed-in.ts`
 * describes: the refresh is a navigation this page starts, so the
 * `SameSite=Strict` session cookie rides along. No script (the CSP allows none).
 */
export interface PreparingView {
  readonly login: string
  readonly csrfToken: string
}

const ACCOUNT_PATH = '/account'
/** How often the page asks again. */
export const PREPARING_REFRESH_SECONDS = 3

/** Renders the complete "preparing" HTML document. */
export function renderPreparingPage(view: PreparingView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>Preparing your install</h1></div>
      <div class="panel-bd">
        <p>Signed in as @${view.login}. Your install is being created — this usually takes under a minute.</p>
        <p class="hint">This page checks again every few seconds. Your owner token appears here once the install is ready — it is shown only once.</p>
        <p><a href="${safeUrl(ACCOUNT_PATH)}">Check now</a></p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Preparing your install',
    content,
    csrfToken: view.csrfToken,
    signedIn: true,
    activeNav: 'account',
    refreshTo: ACCOUNT_PATH,
    refreshAfterSeconds: PREPARING_REFRESH_SECONDS,
  })
}
