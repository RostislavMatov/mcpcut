import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'

/**
 * The page shown when a sign-in is admitted but no install can be created yet
 * — either the account ceiling is full or the orchestrator (phase 3) is not
 * available (H5). There is no email on this domain (PRD `hosted-accounts`,
 * HA10 evidence), so the page says the honest thing: come back and sign in
 * again to check, rather than promising a notification that cannot be sent.
 */
export interface WaitlistView {
  /** 1-based position in the waitlist. */
  readonly position: number
}

/** Renders the complete waitlist HTML document. */
export function renderWaitlistPage(view: WaitlistView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>You're on the waitlist</h1></div>
      <div class="panel-bd">
        <p class="callout">Position #${view.position}. We'll open your install when there is room.</p>
        <p>There is no email on this domain, so nothing will notify you — come back and sign in again to check.</p>
        <p><a href="${safeUrl('/signin')}">Sign in again</a></p>
        <p><a href="${safeUrl('/')}">Back to mcpcut.com</a></p>
      </div>
    </section>
  `
  return renderHubLayout({ title: 'Waitlist', content, csrfToken: '', bodyClass: 'page-hub-auth' })
}
