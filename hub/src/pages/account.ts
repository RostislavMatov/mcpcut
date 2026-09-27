import { html, safeUrl, type Html } from '../../../src/ui/html.js'
import type { AccountStatus } from '../account-row.js'
import { csrfField } from './csrf-field.js'
import { renderHubLayout } from './layout.js'

/**
 * The `/account` page (UX Design, Task 4). It shows the tenant's identity and
 * status, how the install lives and when an unused one stops and is removed
 * (plan `hosted-path-and-ops`, P6), a button to mint a fresh OWNER token (the install's admin
 * credential — shown once by `token-once.ts`), and the block a visitor pastes
 * into an agent's MCP client to reach their install through the bridge
 * (ADR-0015 §4, `connect --url`).
 *
 * That block deliberately duplicates the SHAPE of
 * `src/agents/client-config.ts` rather than importing it: `src/agents/**` is
 * not on the hub's H1 allowlist (`tests/architecture/hub-imports.test.ts`),
 * and that module resolves `PRODUCT_VERSION` — the PLANE's own version,
 * meaningless here where the visitor is about to run a fresh `npx` for the
 * very first time. Pinning nothing (`npx -y mcpcut …`, no `@version`) is
 * simpler and cannot go stale.
 *
 * The AGENT token itself is never shown here — only the install's owner can
 * mint one, from their own console (`mcpcut agent create <name>`), which is
 * why the JSON block carries a placeholder and the page says so in plain
 * words (plan Task 4).
 */

/**
 * How the install lives (plan `hosted-path-and-ops`, Task C, P6): `running`;
 * `starting` — stopped after 60 idle days and being started again now;
 * `stopped` — stopped, and cannot be started right now (no orchestrator);
 * `missing` — the provisioner holds nothing for an active account.
 */
export type InstallState = 'running' | 'starting' | 'stopped' | 'missing'

export interface AccountView {
  /** The GitHub login, shown for identity only (never the key — that's the numeric id). */
  readonly login: string
  readonly subdomain: string
  readonly status: AccountStatus
  /** The tenant's origin, e.g. `https://alice.mcpcut.com` (no trailing slash). */
  readonly serveUrl: string
  readonly csrfToken: string
  readonly install: InstallState
  /** `YYYY-MM-DD`: when an unused install stops (P6). */
  readonly stopsOn: string
  /** `YYYY-MM-DD`: when an unused install and this account are removed (P6). */
  readonly removedOn: string
}

/** How often the page asks again while a stopped install starts. */
export const STARTING_REFRESH_SECONDS = 5
const ACCOUNT_PATH = '/account'

/** The one entry name the client config carries — mirrors `CLIENT_CONFIG_ENTRY_NAME`. */
const CLIENT_CONFIG_ENTRY_NAME = 'mcpcut'

/** Stands in for the real agent token, which the hub never holds or shows. */
const AGENT_TOKEN_PLACEHOLDER = '<your-agent-token>'

/** Env var an agent's MCP client reads the token from — mirrors `AGENT_TOKEN_ENV_VAR`. */
const AGENT_TOKEN_ENV_VAR = 'MCP_AGENT_TOKEN'

const JSON_INDENT = 2

/** The pool address a client reaches this tenant's install at. */
function mcpAddressOf(view: AccountView): string {
  return `${view.serveUrl}/mcp`
}

/** The one-liner a visitor can run directly, mirroring `agent config`'s stdio form. */
function connectCommandOf(view: AccountView): string {
  return `npx mcpcut connect --url ${mcpAddressOf(view)}`
}

/** Pretty JSON for a client's config file — same shape as `renderClientConfig`. */
function clientConfigJsonOf(view: AccountView): string {
  const document = {
    mcpServers: {
      [CLIENT_CONFIG_ENTRY_NAME]: {
        command: 'npx',
        args: ['-y', 'mcpcut', 'connect', '--url', mcpAddressOf(view)],
        env: { [AGENT_TOKEN_ENV_VAR]: AGENT_TOKEN_PLACEHOLDER },
      },
    },
  }
  return `${JSON.stringify(document, null, JSON_INDENT)}\n`
}

function statusPillOf(status: AccountStatus): Html {
  const cls = status === 'active' ? 'pill pill-on' : 'pill'
  return html`<span class="${cls}">${status}</span>`
}

function renderInstallBody(view: AccountView): Html {
  switch (view.install) {
    case 'missing':
      return html`<p><strong>Your install is missing.</strong> Nothing was removed on purpose — please contact the operator.</p>`
    case 'starting':
      return html`
        <p><strong>stopped — starting…</strong></p>
        <p class="hint">Your install was stopped after 60 days without use and is starting again. This page checks again in a few seconds.</p>
      `
    case 'stopped':
      return html`<p class="hint">Your install was stopped after 60 days without use and cannot be started right now. Try again later; it is removed on ${view.removedOn} if unused.</p>`
    case 'running':
      return html`
        <p>Your install stops on ${view.stopsOn} if unused, and is removed on ${view.removedOn} if unused.</p>
        <p class="hint">Signing in here or any call from your agents moves both dates. A stopped install starts again when you sign in.</p>
      `
  }
}

function renderInstallPanel(view: AccountView): Html {
  return html`
    <section class="panel">
      <div class="panel-hd"><h2>Install</h2></div>
      <div class="panel-bd">${renderInstallBody(view)}</div>
    </section>
  `
}

function renderTokenPanel(view: AccountView): Html {
  return html`
    <section class="panel">
      <div class="panel-hd"><h2>Owner token</h2></div>
      <div class="panel-bd">
        <p class="hint">Your install's owner token is shown once, at creation. If you lost it, issue a new one — the old one stops working immediately.</p>
        <form method="post" action="/account/token">
          ${csrfField(view.csrfToken)}
          <button type="submit">Issue a new owner token</button>
        </form>
      </div>
    </section>
  `
}

function renderClientConfigPanel(view: AccountView): Html {
  return html`
    <section class="panel">
      <div class="panel-hd"><h2>Connect an agent</h2></div>
      <div class="panel-bd">
        <p class="hint">Your install's address:</p>
        <pre><code>${mcpAddressOf(view)}</code></pre>
        <p class="hint">Run this once to bridge a stdio agent to it:</p>
        <pre><code>${connectCommandOf(view)}</code></pre>
        <p class="hint">Or drop this into your agent's MCP client config:</p>
        <pre><code>${clientConfigJsonOf(view)}</code></pre>
        <p class="field-hint">The agent token above is a placeholder — mcpcut hub never sees or shows it. Create a real one from your own install's console: <code>mcpcut agent create &lt;name&gt;</code>, then paste it in.</p>
      </div>
    </section>
  `
}

/** Renders the complete `/account` HTML document. */
export function renderAccountPage(view: AccountView): string {
  const content = html`
    <section class="panel panel-strong">
      <div class="panel-hd">
        <h1>@${view.login}</h1>
        ${statusPillOf(view.status)}
      </div>
      <div class="panel-bd">
        <p class="hint">${view.subdomain}.mcpcut.com</p>
      </div>
    </section>
    ${renderInstallPanel(view)}
    ${renderTokenPanel(view)}
    ${renderClientConfigPanel(view)}
    <section class="panel hub-danger">
      <div class="panel-hd"><h2>Delete account</h2></div>
      <div class="panel-bd">
        <p class="hint">Removes your install and everything in it. This cannot be undone.</p>
        <p><a href="${safeUrl('/account/delete')}">Delete account</a></p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Account',
    content,
    csrfToken: view.csrfToken,
    signedIn: true,
    activeNav: 'account',
    ...(view.install === 'starting' ? { refreshTo: ACCOUNT_PATH, refreshAfterSeconds: STARTING_REFRESH_SECONDS } : {}),
  })
}
