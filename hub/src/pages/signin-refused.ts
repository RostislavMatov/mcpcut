import { html, safeUrl, type Html } from '../../../src/ui/html.js'
import { renderHubLayout } from './layout.js'

/**
 * The page shown when `GET /auth/github/callback` does not end in an
 * account (plan Task 5 wires the routes; this module is only the pure
 * render). One reason per outcome named in the plan's UX design and Task 5
 * route sketch — the wording is plain and states the fact, never a bare
 * error code (KISS, and the same "no existence oracle" spirit as the
 * console's uniform 401/403 bodies, though here the audience is a human, not
 * a script, so the sentence is specific rather than uniform).
 *
 * `retryOn` is an ISO date (`YYYY-MM-DD`) rather than a timestamp: the page
 * states a day a visitor can act on, not a rendering of `Date` that would
 * make this otherwise-pure function depend on a time zone or a clock.
 * `minAccountAgeDays` is the configured gate (`HUB_MIN_ACCOUNT_AGE_DAYS`),
 * so the sentence states the rule that actually refused the visitor.
 */
export type SigninRefusalReason =
  | { readonly kind: 'too-young'; readonly retryOn: string; readonly minAccountAgeDays: number }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'recently-deleted'; readonly retryOn: string }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'github-unavailable' }
  | { readonly kind: 'try-again' }
  /** The install was being made in the background and that failed (plan `hosted-path-and-ops`, P3). */
  | { readonly kind: 'install-failed' }

export interface SigninRefusedView {
  readonly reason: SigninRefusalReason
}

function messageOf(reason: SigninRefusalReason): Html {
  switch (reason.kind) {
    case 'too-young':
      return html`Your GitHub account is younger than ${reason.minAccountAgeDays} days. Try again on ${reason.retryOn}.`
    case 'blocked':
      return html`This GitHub account has been blocked from mcpcut. If you think this is a mistake, open an issue on the project's GitHub repository.`
    case 'recently-deleted':
      return html`An mcpcut account for this GitHub login was deleted recently. You can sign up again on or after ${reason.retryOn}.`
    case 'rate-limited':
      return html`Too many sign-ins from this network in the last hour. Wait a bit and try again.`
    case 'cancelled':
      return html`Sign-in was cancelled.`
    case 'github-unavailable':
      return html`GitHub did not answer in time. Try again in a moment.`
    case 'try-again':
      return html`Something went wrong completing sign-in. Nothing was created — try again.`
    case 'install-failed':
      return html`We could not create your install — sign in again. Nothing was kept.`
  }
}

/** Renders the complete refused-sign-in HTML document. */
export function renderSigninRefusedPage(view: SigninRefusedView): string {
  const content = html`
    <section class="panel panel-strong hub-notice">
      <div class="panel-hd"><h1>Sign-in did not complete</h1></div>
      <div class="panel-bd">
        <p class="callout">${messageOf(view.reason)}</p>
        <p><a href="${safeUrl('/signin')}">Try signing in again</a></p>
        <p><a href="${safeUrl('/')}">Back to mcpcut.com</a></p>
      </div>
    </section>
  `
  return renderHubLayout({ title: 'Sign-in', content, csrfToken: '', bodyClass: 'page-hub-auth' })
}
