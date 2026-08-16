import { html, type Html, render, safeUrl } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The shared page shell. Every server-rendered UI page is wrapped by this so
 * the security-relevant head (charset, viewport, CSRF meta, same-origin
 * stylesheet/script) is written in exactly one place and cannot drift per
 * page.
 *
 * CSP posture (the actual header is set by Task 9's `security-headers.ts`;
 * this shell is built to satisfy it): `default-src 'none'; script-src 'self';
 * style-src 'self'`. Therefore the shell emits NO inline `<script>` code and
 * NO inline styles — the stylesheet and client script are referenced by
 * same-origin path (`/assets/app.css`, `/assets/app.js`). The CSRF token is
 * carried in a `<meta>` tag for `app-js` to read; pages using real form POSTs
 * additionally embed it as a hidden field (their concern, Wave 3).
 *
 * `content` is pre-built `Html` (already escaped by the page); `title`,
 * `csrfToken` and `currentAdmin` are plain values and are escaped here.
 */

/** The signed-in admin, shown in the nav. Both fields are untrusted-for-render. */
export interface CurrentAdmin {
  readonly name: string
  readonly role: string
}

export interface LayoutOptions {
  /** Page title; escaped into `<title>` and mirrored in the header. */
  readonly title: string
  /** Pre-rendered page body, inserted verbatim (already escaped). */
  readonly content: Html
  /** Per-session CSRF token; escaped into the meta tag. */
  readonly csrfToken: string
  /** Signed-in admin for the nav; omitted on pre-auth pages like `/login`. */
  readonly currentAdmin?: CurrentAdmin
  /** Nav key of the active page, e.g. `'approvals'`, for `aria-current`. */
  readonly activeNav?: string
}

/** Primary nav entries: [href, key, label]. Owner-only pages are gated by Task 9. */
const NAV_ITEMS: readonly (readonly [string, string, string])[] = [
  // Hrefs must match a real GET route in `ROUTE_TABLE`: the approvals page is
  // served at `/` (not `/approvals`), the rest map one-to-one.
  ['/', 'approvals', 'Approvals'],
  ['/quarantine', 'quarantine', 'Quarantine'],
  ['/servers', 'servers', 'Servers'],
  ['/agents', 'agents', 'Agents'],
  ['/journal', 'journal', 'Journal'],
]

function renderNavLink([href, key, label]: readonly [string, string, string], activeNav?: string): Html {
  return key === activeNav
    ? html`<a href="${safeUrl(href)}" aria-current="page">${label}</a>`
    : html`<a href="${safeUrl(href)}">${label}</a>`
}

/** A hidden CSRF field for a real `<form>` POST (server enforces the check). */
/**
 * The sign-out control, rendered only when a session exists.
 *
 * It is a real POST form, not a link, for two reasons that are the same reason:
 * `GET /logout` is not a route at all, and every state change is screened on
 * `Origin` plus a double-submit CSRF token — neither of which a link carries.
 *
 * Why it lives in the shell: before this, `POST /logout` worked but nothing
 * rendered a way to reach it, so a session ended only by idle timeout, absolute
 * TTL or `admin rotate` (manual browser smoke, post-M4.5 hardening). On a shared
 * workstation that is precisely when signing out is needed. Putting it here puts
 * it on every authenticated page and on no pre-auth one: `/login` renders with
 * no `currentAdmin`, where the control could only produce a 403 anyway.
 */
function renderSignOut(options: LayoutOptions): Html {
  if (options.currentAdmin === undefined) return html``
  return html`
    <form method="post" action="/logout" class="sign-out">
      ${csrfField(options.csrfToken)}
      <button type="submit" class="secondary">Sign out</button>
    </form>
  `
}

function renderNav(options: LayoutOptions): Html {
  const links = NAV_ITEMS.map((item) => renderNavLink(item, options.activeNav))
  const whoami = options.currentAdmin
    ? html`<span class="whoami">${options.currentAdmin.name} · ${options.currentAdmin.role}</span>`
    : html``
  return html`
    <header class="app-nav">
      <strong>mcp-journal</strong>
      ${links}
      <span class="spacer"></span>
      ${whoami}
      ${renderSignOut(options)}
    </header>
  `
}

/**
 * The live-updates attribute, present only on an AUTHENTICATED page.
 *
 * `GET /events` requires a session, so the login page carrying this attribute
 * made every visitor's browser open a stream that could only be refused — a 403
 * in the console of the one page an operator looks at while suspecting
 * something is wrong (manual M4 smoke). No attribute, no connection: the client
 * script treats its absence as "this page has no live channel".
 */
function liveAttribute(options: LayoutOptions): Html {
  return options.currentAdmin === undefined ? html`` : html` data-events-url="/events"`
}

/**
 * Renders a complete HTML document string ready for the HTTP body. Returns a
 * `string` (not `Html`) because it is the terminal render step; internally it
 * is built entirely through the escaping `html` template.
 */
export function renderLayout(options: LayoutOptions): string {
  const doc = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${options.csrfToken}">
<title>${options.title} · mcp-journal</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body${liveAttribute(options)}>
${renderNav(options)}
<main>
${options.content}
</main>
<div class="toast-region" aria-live="polite"></div>
<script src="/assets/app.js" defer></script>
</body>
</html>`
  return render(doc)
}
