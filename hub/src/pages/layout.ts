import { BRAND_NAME } from '../../../src/ui/constants.js'
import { html, join, render, safeUrl, type Html } from '../../../src/ui/html.js'
import { csrfField } from './csrf-field.js'

/**
 * The shared hub page shell (plan `hub-signin-accounts`, Task 4, H2). Unlike
 * the console's `renderLayout` (`src/ui/pages/layout.ts`), the hub has no
 * roles at all — a visitor either holds a hub session or does not, so the
 * nav is a fixed three items (Account, Terms, Privacy) plus a POST sign-out
 * form, shown only when `signedIn` is true. Pre-auth documents (the refused
 * sign-in, the waitlist position, a public Terms/Privacy view) render with
 * `signedIn` left unset and get no nav at all — exactly the login page's
 * shape in the console.
 *
 * CSP posture mirrors the console's: `default-src 'none'` with a same-origin
 * `'self'` allowlist per directive (`src/ui/security-headers.ts`, reused by
 * the hub's own response headers wiring), so this shell carries no inline
 * `<script>` and no inline styles — the stylesheet is a same-origin
 * `/hub-assets/hub.css` reference and every page works with JavaScript off.
 */

export interface HubLayoutOptions {
  /** Page title; escaped into `<title>` and combined with the brand. */
  readonly title: string
  /** Pre-rendered page body, inserted verbatim (already escaped). */
  readonly content: Html
  /** Per-session CSRF token; escaped into the meta tag and the sign-out form. */
  readonly csrfToken: string
  /** True once a hub session exists — shows Account/Terms/Privacy + Sign out. */
  readonly signedIn?: boolean
  /** Nav key of the active page (`'account'`, `'terms'`, `'privacy'`), for `aria-current`. */
  readonly activeNav?: string
  /** `body` class hook for page-level layout (e.g. `page-hub-auth`). */
  readonly bodyClass?: string
  /**
   * A same-origin path the page moves on to at once (`<meta http-equiv=
   * "refresh">`). Used by the sign-in hand-over (`pages/signed-in.ts`): a
   * navigation this page starts is same-site, so the `SameSite=Strict`
   * session cookie rides along — a redirect from the callback would not carry
   * it, the callback being the tail of a navigation that began on github.com.
   */
  readonly refreshTo?: string
  /** Seconds before `refreshTo` is followed; 0 (at once) when unset. The "preparing" page polls with it. */
  readonly refreshAfterSeconds?: number
}

interface NavItem {
  readonly href: string
  readonly key: string
  readonly label: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/account', key: 'account', label: 'Account' },
  { href: '/terms', key: 'terms', label: 'Terms' },
  { href: '/privacy', key: 'privacy', label: 'Privacy' },
]

function renderTab(item: NavItem, activeNav: string | undefined): Html {
  const href = safeUrl(item.href)
  return item.key === activeNav
    ? html`<a class="tab" href="${href}" aria-current="page">${item.label}</a>`
    : html`<a class="tab" href="${href}">${item.label}</a>`
}

/**
 * The sign-out control: a real POST form (not a link), screened like every
 * other state change by `Origin` plus the double-submit CSRF token — neither
 * of which a link carries.
 */
function renderSignOut(csrfToken: string): Html {
  return html`
    <form method="post" action="/signout" class="sign-out">
      ${csrfField(csrfToken)}
      <button type="submit" class="secondary">Sign out</button>
    </form>
  `
}

function renderTopbar(options: HubLayoutOptions): Html {
  return html`
    <header class="topbar">
      <a class="brand" href="${safeUrl('/account')}">${BRAND_NAME}</a>
      <nav class="tabs" aria-label="Primary">
        ${join(NAV_ITEMS.map((item) => renderTab(item, options.activeNav)))}
      </nav>
      <span class="spacer"></span>
      ${renderSignOut(options.csrfToken)}
    </header>
  `
}

/**
 * The public-page foot: Terms and Privacy stay reachable even before a
 * session exists (a rejected or waitlisted visitor still deserves the
 * policy), rendered as plain links rather than the full nav+sign-out bar.
 */
function renderPublicFoot(activeNav: string | undefined): Html {
  const links = NAV_ITEMS.filter((item) => item.key !== 'account').map((item) => renderTab(item, activeNav))
  return html`<footer class="hub-foot"><nav aria-label="Policies">${join(links, html` · `)}</nav></footer>`
}

function renderRefresh(path: string, afterSeconds: number): Html {
  if (!Number.isInteger(afterSeconds) || afterSeconds < 0) throw new RangeError('renderHubLayout: refreshAfterSeconds must be a whole number of seconds')
  return html`<meta http-equiv="refresh" content="${String(afterSeconds)}; url=${safeUrl(path)}">`
}

/** Renders a complete HTML document string ready for the HTTP body. */
export function renderHubLayout(options: HubLayoutOptions): string {
  const doc = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${options.csrfToken}">
${options.refreshTo !== undefined ? renderRefresh(options.refreshTo, options.refreshAfterSeconds ?? 0) : html``}
<title>${options.title} · ${BRAND_NAME}</title>
<link rel="stylesheet" href="/hub-assets/hub.css">
<link rel="icon" href="/hub-assets/favicon.svg" type="image/svg+xml">
</head>
<body${options.bodyClass !== undefined ? html` class="${options.bodyClass}"` : html``}>
${options.signedIn === true ? renderTopbar(options) : html``}
<main>
${options.content}
</main>
${options.signedIn === true ? html`` : renderPublicFoot(options.activeNav)}
</body>
</html>`
  return render(doc)
}
