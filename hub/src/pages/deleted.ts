import { html, safeUrl } from '../../../src/ui/html.js'
import { DELETE_COOLDOWN_DAYS } from '../signup-policy.js'
import { renderHubLayout } from './layout.js'

/**
 * The page shown after a successful `POST /account/delete`. The session that
 * carried it is already gone by the time this renders (`sessions.ts`
 * destroys it before the response), so the shell has no nav and no sign-out
 * — there is nothing left to sign out of.
 */
export interface DeletedView {
  readonly login: string
}

/** Renders the complete "account deleted" HTML document. */
export function renderDeletedPage(view: DeletedView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>Account deleted</h1></div>
      <div class="panel-bd">
        <p>The mcpcut account for @${view.login} has been deleted.</p>
        <p class="hint">If you sign in again within ${DELETE_COOLDOWN_DAYS} days, the ceiling and waitlist rules treat you as recently deleted.</p>
        <p><a href="${safeUrl('/')}">Back to mcpcut.com</a></p>
      </div>
    </section>
  `
  return renderHubLayout({ title: 'Account deleted', content, csrfToken: '', bodyClass: 'page-hub-auth' })
}
