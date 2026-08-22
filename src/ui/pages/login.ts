import { BRAND_NAME, INSTANCE_LABEL } from '../constants.js'
import { html, safeUrl } from '../html.js'
import { renderLayout } from './layout.js'

/**
 * The public `/login` page — the Auth screen of the McpCut design. Renders the
 * brand, a one-line promise, the token-entry form, a status line and a glass
 * footer. It carries NO session — the login POST is the one request that mints
 * one — so there is no per-session CSRF token yet; `SameSite=Strict` on the
 * session cookie and the `Origin`/`Host` checks in `server.ts` guard the login
 * POST, and the hidden `csrf_token` field is present (empty) only so the form
 * shape matches every other page and the no-JS fallback posts an identical
 * body.
 *
 * Two deliberate departures from the prototype: there is no "Admin" field,
 * because the personal token IS the identity (`admin add` mints one token per
 * person and the server resolves the name from it — a name field would be
 * decorative and misleading); and there is no "keep this session" toggle,
 * because the session lifetime is fixed by `SESSION_TTL_MS`/idle timeout and a
 * control with no effect would be a lie.
 *
 * Rendered exclusively through the escaping `html` template + `renderLayout`
 * (the single sanctioned path to markup); the optional `error` is untrusted
 * (e.g. an echoed status) and is escaped like any other interpolation.
 */

export interface LoginPageOptions {
  /** Optional human-readable error to surface above the form (escaped). */
  readonly error?: string
}

/** Renders the complete `/login` HTML document. */
export function renderLoginPage(options: LoginPageOptions = {}): string {
  const banner =
    options.error !== undefined
      ? html`<p class="error" role="alert">${options.error}</p>`
      : html``
  const content = html`
    <section class="login-brand" aria-label="Sign in">
      <h1 class="brand">${BRAND_NAME}</h1>
      <p class="tagline">The whole history of your MCP — every call, every decision, in one place.</p>
    </section>
    <div class="login-form">
    <form method="post" action="/login">
      <input type="hidden" name="csrf_token" value="" />
      ${banner}
      <label>
        <span>Access token</span>
        <input
          id="token"
          name="token"
          type="password"
          placeholder="mcpa_••••••••••••••••"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
        />
      </label>
      <button type="submit">Enter console</button>
    </form>
    </div>
    <section class="login-foot">
      <p class="hint">One personal token per admin, issued with <code>mcp-journal admin add</code>. Lost it? The instance owner rotates it under Admins — there is no email recovery.</p>
      <div class="status"><span class="dot blink"></span><span>ready · ${INSTANCE_LABEL}</span></div>
    </section>
    <footer class="login-footer">
      <div class="col">
        <div class="brand">${BRAND_NAME}</div>
        <p class="pretty">Self-hosted control plane for MCP servers. Every call, approval and quarantine decision is journalled locally and never leaves your instance.</p>
        <div class="version"><span class="dot"></span><span>${INSTANCE_LABEL}</span></div>
      </div>
      <div class="col">
        <div class="label">Product</div>
        <a href="${safeUrl('/')}">Approval queue</a>
        <a href="${safeUrl('/journal')}">Call journal</a>
        <a href="${safeUrl('/quarantine')}">Tool quarantine</a>
        <a href="${safeUrl('/servers')}">Server registry</a>
      </div>
      <div class="col">
        <div class="label">Operations</div>
        <a href="${safeUrl('/agents')}">Agents</a>
        <a href="${safeUrl('/admins')}">Token rotation</a>
        <a href="${safeUrl('/vault')}">Vault</a>
      </div>
    </footer>
  `
  return renderLayout({ title: 'Sign in', content, csrfToken: '', bodyClass: 'page-login' })
}
