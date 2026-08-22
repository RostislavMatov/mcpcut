import { BRAND_NAME, INSTANCE_LABEL } from '../constants.js'
import { html, type Html, join, render, safeUrl } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The shared page shell — the McpCut console (Claude Design, 2026-08-22).
 * Every server-rendered UI page is wrapped by this so the security-relevant
 * head (charset, viewport, CSRF meta, same-origin stylesheet/script) is
 * written in exactly one place and cannot drift per page.
 *
 * CSP posture (the actual header is set by `security-headers.ts`; this shell
 * is built to satisfy it): `default-src 'none'; script-src 'self'; style-src
 * 'self'; font-src 'self'`. Therefore the shell emits NO inline `<script>`
 * code and NO inline styles — the stylesheet, the client script and the
 * embedded pixel font are referenced by same-origin path. The CSRF token is
 * carried in a `<meta>` tag for `app-js` to read; pages using real form POSTs
 * additionally embed it as a hidden field.
 *
 * Shell anatomy (class names are the contract with `assets/css/layout.ts`):
 *  - `.topbar`: brand · live status line · optional search box · whoami ·
 *    sign-out;
 *  - `.tabs`: the primary navigation as pixel-font tabs, the active one
 *    optionally paired with a `+` action (e.g. "register a server");
 *  - `<main>`: the page body;
 *  - `.toast-region`: the client script's announcements.
 *
 * `content` is pre-built `Html` (already escaped by the page); every other
 * option is a plain value and is escaped here.
 */

/** The signed-in admin, shown in the nav. Both fields are untrusted-for-render. */
export interface CurrentAdmin {
  readonly name: string
  readonly role: string
}

/**
 * A search box in the top bar. It is a real `GET` form so it works without
 * JavaScript; a page that filters client-side instead sets `clientFilter`
 * (the client script then narrows `[data-filter-item]` nodes as you type and
 * the form's submit is a no-op reload).
 */
export interface SearchBox {
  /** Form action, a same-origin path (e.g. `/journal`). */
  readonly action: string
  /** Query parameter name (e.g. `q`). */
  readonly name: string
  readonly placeholder: string
  /** Current value echoed into the field (escaped). */
  readonly value?: string
  /** When true, the client script filters `[data-filter-item]` nodes live. */
  readonly clientFilter?: boolean
}

/** The `+` control paired with the active tab; opens a `<details id=…>` on the page. */
export interface NavAction {
  readonly title: string
  /** Id of the `<details>` the control opens (also the no-JS anchor target). */
  readonly targetId: string
}

export interface LayoutOptions {
  /** Page title; escaped into `<title>` and used for the status line. */
  readonly title: string
  /** Pre-rendered page body, inserted verbatim (already escaped). */
  readonly content: Html
  /** Per-session CSRF token; escaped into the meta tag. */
  readonly csrfToken: string
  /** Signed-in admin for the nav; omitted on pre-auth pages like `/login`. */
  readonly currentAdmin?: CurrentAdmin
  /** Nav key of the active page, e.g. `'approvals'`, for `aria-current`. */
  readonly activeNav?: string
  /** Optional search box in the top bar. */
  readonly search?: SearchBox
  /** Optional `+` action paired with the active tab. */
  readonly navAction?: NavAction
  /** Optional right-aligned meta text in the tab bar (e.g. "4 / 50 servers"). */
  readonly navMeta?: string
  /** `body` class hook for page-level layout (e.g. `page-login`). */
  readonly bodyClass?: string
  /**
   * Extra same-origin scripts (asset names under `/assets/`, e.g. `login.js`)
   * loaded after `app.js`. Names only — never a URL — so a page cannot point
   * the shell at anything the asset allowlist does not serve.
   */
  readonly scripts?: readonly string[]
}

/** Primary nav entries: [href, key, label, minRole]. */
interface NavItem {
  readonly href: string
  readonly key: string
  readonly label: string
  /** Roles that see the entry; absent = everyone signed in. */
  readonly roles?: readonly string[]
}

/**
 * Hrefs must match a real GET route in `ROUTE_TABLE`: the dashboard (approval
 * queue + journal summary) is served at `/`, the rest map one-to-one. Owner-only
 * pages are listed by role here AND gated by `ROUTE_TABLE` — the link is a
 * convenience, the table is the check.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', key: 'approvals', label: 'Dashboard' },
  { href: '/journal', key: 'journal', label: 'Journal' },
  { href: '/quarantine', key: 'quarantine', label: 'Quarantine' },
  { href: '/servers', key: 'servers', label: 'Servers' },
  { href: '/agents', key: 'agents', label: 'Agents' },
  { href: '/vault', key: 'vault', label: 'Vault', roles: ['owner'] },
  { href: '/admins', key: 'admins', label: 'Admins', roles: ['owner'] },
]

function navLabelFor(activeNav: string | undefined): string | undefined {
  return NAV_ITEMS.find((item) => item.key === activeNav)?.label
}

function renderTab(item: NavItem, options: LayoutOptions): Html {
  const href = safeUrl(item.href)
  if (item.key !== options.activeNav) {
    return html`<a class="tab" href="${href}">${item.label}</a>`
  }
  if (options.navAction === undefined) {
    return html`<a class="tab" href="${href}" aria-current="page">${item.label}</a>`
  }
  const target = `#${options.navAction.targetId}`
  return html`<div class="tab-group">
      <a class="tab" href="${href}" aria-current="page">${item.label}</a>
      <a class="tab-plus" href="${safeUrl(target)}" title="${options.navAction.title}" data-open-details="${options.navAction.targetId}">+</a>
    </div>`
}

function visibleNavItems(options: LayoutOptions): readonly NavItem[] {
  const role = options.currentAdmin?.role
  return NAV_ITEMS.filter((item) => item.roles === undefined || (role !== undefined && item.roles.includes(role)))
}

function renderTabs(options: LayoutOptions): Html {
  if (options.currentAdmin === undefined) return html``
  const tabs = visibleNavItems(options).map((item) => renderTab(item, options))
  const meta = options.navMeta !== undefined ? html`<span class="meta num">${options.navMeta}</span>` : html``
  return html`<nav class="tabs" aria-label="Primary">${tabs}<span class="spacer"></span>${meta}</nav>`
}

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

function renderSearch(options: LayoutOptions): Html {
  const search = options.search
  if (search === undefined) return html``
  const clientFilter = search.clientFilter === true ? html` data-client-filter="1"` : html``
  return html`<form class="search" method="get" action="${safeUrl(search.action)}" role="search"${clientFilter}>
      <span class="dot dot-s"></span>
      <input type="search" name="${search.name}" value="${search.value ?? ''}" placeholder="${search.placeholder}" aria-label="${search.placeholder}" autocomplete="off">
    </form>`
}

function renderStatus(options: LayoutOptions): Html {
  const label = (navLabelFor(options.activeNav) ?? options.title).toLowerCase()
  return html`<div class="status"><span class="dot blink"></span><span>${label} · ${INSTANCE_LABEL}</span></div>`
}

function renderTopbar(options: LayoutOptions): Html {
  const whoami = options.currentAdmin
    ? html`<span class="whoami"><span class="avatar"></span><span>${options.currentAdmin.name}</span><span class="role">· ${options.currentAdmin.role}</span></span>`
    : html``
  return html`
    <header class="topbar">
      <a class="brand" href="${safeUrl('/')}">${BRAND_NAME}</a>
      ${renderStatus(options)}
      ${renderSearch(options)}
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
function bodyAttributes(options: LayoutOptions): Html {
  const events = options.currentAdmin === undefined ? html`` : html` data-events-url="/events"`
  const cls = options.bodyClass !== undefined ? html` class="${options.bodyClass}"` : html``
  return html`${cls}${events}`
}

/** Only a plain asset NAME is accepted (`[a-z0-9-]+\.js`); anything else is dropped. */
const ASSET_NAME_PATTERN = /^[a-z0-9-]+\.js$/

function renderExtraScripts(options: LayoutOptions): Html {
  const names = (options.scripts ?? []).filter((name) => ASSET_NAME_PATTERN.test(name))
  return join(names.map((name) => html`<script src="${safeUrl(`/assets/${name}`)}" defer></script>
`))
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
<title>${options.title} · ${BRAND_NAME}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body${bodyAttributes(options)}>
${options.currentAdmin === undefined ? html`` : renderTopbar(options)}
${renderTabs(options)}
<main>
${options.content}
</main>
<div class="toast-region" aria-live="polite"></div>
<script src="/assets/app.js" defer></script>
${renderExtraScripts(options)}</body>
</html>`
  return render(doc)
}
