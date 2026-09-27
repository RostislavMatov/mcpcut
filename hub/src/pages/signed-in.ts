import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'

/**
 * The hand-over from the GitHub callback to `/account` for a returning
 * visitor (plan Task 5). Not a redirect, on purpose: the callback is the tail
 * of a navigation that began on github.com, and a browser keeps treating a
 * redirect chain started cross-site as cross-site — the `SameSite=Strict`
 * session cookie just set would be withheld from `/account` and the visitor
 * bounced back to sign in. A navigation THIS page starts (the refresh below,
 * or the link for a browser that ignores it) is same-site, so the cookie
 * rides along. No script: the hub's CSP allows none inline.
 */
export interface SignedInView {
  readonly login: string
  readonly csrfToken: string
}

const ACCOUNT_PATH = '/account'

/** Renders the complete hand-over HTML document. */
export function renderSignedInPage(view: SignedInView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>Signed in</h1></div>
      <div class="panel-bd">
        <p>Signed in as @${view.login}.</p>
        <p><a href="${safeUrl(ACCOUNT_PATH)}">Continue to your account</a></p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Signed in',
    content,
    csrfToken: view.csrfToken,
    bodyClass: 'page-hub-auth',
    refreshTo: ACCOUNT_PATH,
  })
}
