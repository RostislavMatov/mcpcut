import { SETUP_CODE_FILE_NAME } from '../../admin/constants.js'
import { BRAND_NAME, INSTANCE_LABEL } from '../constants.js'
import { html, type Html } from '../html.js'
import { renderLayout } from './layout.js'

/**
 * The first-run pages (ADR-0004, amendment of 2026-09-19): `/setup`, served
 * only while the install has no admin, and the one-time token reveal that
 * answers its successful POST.
 *
 * Both are PUBLIC documents, rendered for a visitor who holds no credential:
 *
 *  - The form names the code's FILE, never its path. The path is a host fact
 *    (it spells the service account's home); the operator reads it from the
 *    service log, which is where the code's location is announced.
 *  - The typed name is echoed back after a refusal; the code never is — a
 *    wrong code re-rendered into the document would sit in the browser's
 *    view-source and form history for no benefit.
 *  - No page script: the sign-in choreography of `/login` has nothing to
 *    animate here, and a document that reveals a token should run as little
 *    as possible.
 *
 * They reuse the Auth screen's body class and form column, so the first thing
 * an operator sees looks like the console they are about to sign in to.
 */

/**
 * `ADMIN_NAME_PATTERN` as an HTML `pattern`. A browser compiles the attribute
 * with the `v` flag, under which a bare `-` inside a class is a SyntaxError —
 * and a pattern that fails to compile is dropped without a word, leaving the
 * field unchecked (found by the browser smoke). Hence the escaped dash; the
 * test pins this string against the store's own pattern.
 */
const ADMIN_NAME_HTML_PATTERN = '[a-z0-9][a-z0-9\\-]{0,63}'

export interface SetupPageOptions {
  /** Human-readable refusal, shown above the form (escaped). */
  readonly error?: string
  /** The name the visitor typed, echoed back after a refusal (escaped). */
  readonly name?: string
}

function brandSection(tagline: string): Html {
  return html`<section class="login-brand" aria-label="First run">
      <h1 class="brand">${BRAND_NAME}</h1>
      <p class="tagline">${tagline}</p>
    </section>`
}

function statusFoot(hint: Html): Html {
  return html`<section class="login-foot setup-foot">
      ${hint}
      <div class="status"><span class="dot blink"></span><span>first run · ${INSTANCE_LABEL}</span></div>
    </section>`
}

/** Renders the complete `/setup` HTML document. */
export function renderSetupPage(options: SetupPageOptions = {}): string {
  const banner =
    options.error !== undefined ? html`<p class="error" role="alert">${options.error}</p>` : html``
  const content = html`
    ${brandSection('This install has no admin yet. Create its owner.')}
    <div class="login-form">
    <form method="post" action="/setup">
      ${banner}
      <label>
        <span>Setup code</span>
        <input
          id="code"
          name="code"
          type="password"
          placeholder="mcps_••••••••••••••••"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
        />
        <span class="field-hint">One-time, from the file <code>${SETUP_CODE_FILE_NAME}</code> in this install's data directory (default <code>~/.mcpcut/data</code>).</span>
      </label>
      <label>
        <span>Admin name</span>
        <input
          id="name"
          name="name"
          type="text"
          value="${options.name ?? ''}"
          placeholder="your-name"
          pattern="${ADMIN_NAME_HTML_PATTERN}"
          maxlength="64"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
        />
        <span class="field-hint">Lowercase letters, digits and dashes. Every change you make is journalled under this name.</span>
      </label>
      <label>
        <span>Role</span>
        <input type="text" value="owner" disabled />
        <span class="field-hint">The first admin is always the owner; owners add operators and viewers under Admins.</span>
      </label>
      <button type="submit">Create owner</button>
    </form>
    </div>
    ${statusFoot(html`<p class="hint">The service log names the exact path of the code file. Reading it proves you can reach this host.</p>
      <p class="hint">Rather not use a browser? Run <code>mcpcut</code> on the host — in Docker, <code>docker compose exec -it ui mcpcut</code>. The console creates the owner and asks for no code.</p>`)}
  `
  return renderLayout({ title: 'First run', content, csrfToken: '', bodyClass: 'page-login' })
}

export interface SetupDoneView {
  readonly admin: string
  /** The one-time plaintext token: interpolated here and nowhere else. */
  readonly token: string
  /** Set when the creation's audit record did not reach the journal (escaped). */
  readonly warning?: string
}

/**
 * The answer to a successful `POST /setup`: the owner's token, once. The
 * sign-in button posts that same token to `/login` from a hidden field, so
 * "I saved it" is one press instead of a copy-paste into the next page — the
 * token is already in this document, and the hidden field adds no copy of it
 * anywhere this response is not.
 */
export function renderSetupDonePage(view: SetupDoneView): string {
  const warning =
    view.warning === undefined ? html`` : html`<p class="notice-warning" role="alert">${view.warning}</p>`
  const content = html`
    ${brandSection('Owner created.')}
    <div class="login-form token-reveal">
      <p class="callout">Save this token now — it is shown once and cannot be recovered.</p>
      <p class="label">Token of “${view.admin}” · role owner</p>
      <pre class="token" data-token>${view.token}</pre>
      ${warning}
      <form method="post" action="/login">
        <input type="hidden" name="csrf_token" value="" />
        <input type="hidden" name="token" value="${view.token}" />
        <button type="submit">I saved it — enter console</button>
      </form>
    </div>
    ${statusFoot(html`<p class="hint">Lost it before signing in? A shell on this host issues a new one:<br /><code>mcpcut admin rotate ${view.admin} --recover</code></p>`)}
  `
  return renderLayout({ title: 'Owner created', content, csrfToken: '', bodyClass: 'page-login' })
}
