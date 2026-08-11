import { html } from '../html.js'
import { renderLayout } from './layout.js'

/**
 * The public `/login` page (M4 Task 13). Renders a minimal token-entry form.
 * It carries NO session — the login POST is the one request that mints one — so
 * there is no per-session CSRF token yet; `SameSite=Strict` on the session
 * cookie and the `Origin`/`Host` checks in `server.ts` guard the login POST,
 * and the hidden `csrf_token` field is present (empty) only so the form shape
 * matches every other page and the no-JS fallback posts an identical body.
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
      ? html`<p class="muted" role="alert">${options.error}</p>`
      : html``
  const content = html`
    <section class="card" aria-label="Sign in">
      <h1>Sign in</h1>
      ${banner}
      <form method="post" action="/login">
        <input type="hidden" name="csrf_token" value="" />
        <p>
          <label for="token">Admin token</label><br />
          <input
            id="token"
            name="token"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            required
          />
        </p>
        <button type="submit">Sign in</button>
      </form>
      <p class="muted">One personal token per admin. Tokens are issued with <code>mcp-journal admin add</code>.</p>
    </section>
  `
  return renderLayout({ title: 'Sign in', content, csrfToken: '' })
}
