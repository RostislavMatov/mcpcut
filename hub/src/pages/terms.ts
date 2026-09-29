import { html, safeUrl } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'
import { REPOSITORY_ISSUES_URL } from './links.js'

/**
 * The `/terms` page (HA10, draft — the plan flags it for the owner to
 * proofread before launch). Plain, short, honest: free, "as is", no SLA, no
 * abuse, delete any time, contact is the project's GitHub issues.
 */
export interface TermsView {
  /** Present once a hub session exists — shows the signed-in nav. */
  readonly signedIn?: boolean
  readonly csrfToken?: string
}

/** Renders the complete `/terms` HTML document. */
export function renderTermsPage(view: TermsView = {}): string {
  const content = html`
    <section class="panel">
      <div class="panel-hd"><h1>Terms</h1></div>
      <div class="panel-bd">
        <p>mcpcut hub is a free service, offered as is, with no service-level agreement. It may change, be paused or be shut down without notice.</p>
        <ul class="list">
          <li>You get one account per GitHub identity and one install on a subdomain of mcpcut.com.</li>
          <li>Do not use it to abuse other services, evade the sign-up limits, or attack this host or others through it.</li>
          <li>Outbound traffic from your install reaches only port 443 — that is a constraint of the platform, not a promise of what runs on it.</li>
          <li>You can delete your account at any time from the Account page; deletion is immediate.</li>
          <li>Breaking these terms can get an account blocked (see Privacy for what that means).</li>
        </ul>
        <p class="hint">Questions or reports go to <a href="${safeUrl(REPOSITORY_ISSUES_URL)}">the project's GitHub issues</a>.</p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Terms',
    content,
    csrfToken: view.csrfToken ?? '',
    ...(view.signedIn === true ? { signedIn: true } : {}),
    activeNav: 'terms',
  })
}
