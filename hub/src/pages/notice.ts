import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'

/**
 * A short, plain notice page (plan Task 5): the hub's 404, and the answer when
 * an account action could not be completed because the orchestrator was
 * unavailable or failed — "what happened, and that nothing changed". Signed
 * in, it keeps the nav and leads back to the account; signed out, it leads
 * home.
 */
export interface NoticeView {
  /** The headline, e.g. `Not found`. */
  readonly status: string
  readonly message: string
  readonly signedIn?: boolean
  readonly csrfToken?: string
}

/** Renders the complete notice HTML document. */
export function renderNoticePage(view: NoticeView): string {
  const isSignedIn = view.signedIn === true
  const back = isSignedIn
    ? html`<a href="${safeUrl('/account')}">Back to your account</a>`
    : html`<a href="${safeUrl('/')}">Back to mcpcut.com</a>`
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>${view.status}</h1></div>
      <div class="panel-bd">
        <p class="callout">${view.message}</p>
        <p>${back}</p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: view.status,
    content,
    csrfToken: view.csrfToken ?? '',
    ...(isSignedIn ? { signedIn: true } : { bodyClass: 'page-hub-auth' }),
  })
}
