import { html, safeUrl } from '../../../src/ui/html.js'
import { DELETE_COOLDOWN_DAYS } from '../signup-policy.js'
import { renderHubLayout } from './layout.js'

/**
 * The `/privacy` page (HA10/HA11, draft — the plan flags it for the owner to
 * proofread before launch). States what is stored, what the operator can and
 * cannot see, and the journal's real guarantee — the project refuses
 * "tamper-proof" and "audit-ready" everywhere, and states "tamper-evident"
 * only paired with "external anchor" (CLAUDE.md, `tests/hub/pages.test.ts`).
 */
export interface PrivacyView {
  /** The configured GitHub-account-age gate (`HUB_MIN_ACCOUNT_AGE_DAYS`). */
  readonly minAccountAgeDays: number
  /** Present once a hub session exists — shows the signed-in nav. */
  readonly signedIn?: boolean
  readonly csrfToken?: string
}

const REPOSITORY_ISSUES_URL = 'https://github.com/RostislavMatov/mcpcut/issues'

/** Renders the complete `/privacy` HTML document. */
export function renderPrivacyPage(view: PrivacyView): string {
  const content = html`
    <section class="panel">
      <div class="panel-hd"><h1>Privacy</h1></div>
      <div class="panel-bd">
        <h2>What we store</h2>
        <p>Your GitHub numeric id and login, the dates your GitHub account and your mcpcut account were created, and when you were last seen. Your GitHub access token is never stored: we read your profile once and revoke it immediately.</p>
        <h2>Your journal</h2>
        <p>The call journal your install writes lives on our host, in your own install's data — not in a shared database. It is tamper-evident with an external anchor, which means a rewrite of the chain on this host is detectable once that anchor exists, not that the file is hidden from us. The host operator can technically read it, the same way any host's root user can read anything running on it.</p>
        <h2>What the operator does and does not do</h2>
        <p>The operator (us) sees the list of accounts, their status, and coarse resource use and record counts. We do not open your journal, your vault or your policy through any tool the hub gives us — there isn't one. As the host's root user we technically could; that is the honest limit of self-hosting on someone else's machine, not a promise we do not act on it.</p>
        <h2>Deletion</h2>
        <p>Deleting your account from the Account page removes your install immediately. A tombstone of the deletion is kept for ${DELETE_COOLDOWN_DAYS} days so the same GitHub identity cannot immediately sign up again — after that window it is purged.</p>
        <h2>Abuse</h2>
        <p>Sign-up is limited to GitHub accounts older than ${view.minAccountAgeDays} days and to a few sign-ups per hour per network, to keep the free tier usable. An account can be blocked for abuse; a blocked login cannot sign in again.</p>
        <p class="hint">Questions go to <a href="${safeUrl(REPOSITORY_ISSUES_URL)}">the project's GitHub issues</a>.</p>
      </div>
    </section>
  `
  return renderHubLayout({
    title: 'Privacy',
    content,
    csrfToken: view.csrfToken ?? '',
    ...(view.signedIn === true ? { signedIn: true } : {}),
    activeNav: 'privacy',
  })
}
