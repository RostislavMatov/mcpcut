import { describe, expect, test } from 'vitest'
import {
  renderAccountDeleteConfirmPage,
  type AccountDeleteConfirmView,
} from '../../hub/src/pages/account-delete-confirm.js'
import { renderAccountPage, type AccountView } from '../../hub/src/pages/account.js'
import { renderDeletedPage } from '../../hub/src/pages/deleted.js'
import { renderHubLayout } from '../../hub/src/pages/layout.js'
import { renderPreparingPage } from '../../hub/src/pages/preparing.js'
import { renderPrivacyPage } from '../../hub/src/pages/privacy.js'
import { renderSigninRefusedPage, type SigninRefusalReason } from '../../hub/src/pages/signin-refused.js'
import { renderTermsPage } from '../../hub/src/pages/terms.js'
import { renderTokenOncePage } from '../../hub/src/pages/token-once.js'
import { renderWaitlistPage } from '../../hub/src/pages/waitlist.js'
import { DELETE_COOLDOWN_DAYS } from '../../hub/src/signup-policy.js'
import { html } from '../../src/ui/html.js'
import { expectNoBannedWords } from '../support/banned-words.js'

/**
 * Pure-render tests for every hub page (plan `hub-signin-accounts`, Task 4).
 * No IO, no harness: every page here is `(view) => string`, so these tests
 * feed representative views and inspect the returned document directly —
 * the same style as `tests/ui/pages-shared.test.ts` and `tests/ui/page-
 * contracts.test.ts` for the console.
 */

const XSS_LOGIN = '<script>alert(1)</script>'
const CSRF_TOKEN = 'csrf-token-value-123456'

const ALL_REFUSAL_REASONS: readonly SigninRefusalReason[] = [
  { kind: 'too-young', retryOn: '2026-10-27', minAccountAgeDays: 30 },
  { kind: 'blocked' },
  { kind: 'recently-deleted', retryOn: '2026-10-27' },
  { kind: 'rate-limited' },
  { kind: 'cancelled' },
  { kind: 'github-unavailable' },
  { kind: 'try-again' },
  { kind: 'install-failed' },
]

function accountView(overrides: Partial<AccountView> = {}): AccountView {
  return {
    login: 'alice',
    subdomain: 'alice',
    status: 'active',
    serveUrl: 'https://alice.mcpcut.com',
    csrfToken: CSRF_TOKEN,
    install: 'running',
    stopsOn: '2026-11-26',
    removedOn: '2026-12-26',
    ...overrides,
  }
}

function deleteConfirmView(overrides: Partial<AccountDeleteConfirmView> = {}): AccountDeleteConfirmView {
  return { login: 'alice', csrfToken: CSRF_TOKEN, ...overrides }
}

/** Every page document the hub can serve, rendered with a representative view. */
function allPages(): ReadonlyArray<{ readonly name: string; readonly html: string }> {
  return [
    { name: 'account', html: renderAccountPage(accountView()) },
    { name: 'account-xss-login', html: renderAccountPage(accountView({ login: XSS_LOGIN })) },
    {
      name: 'account-delete-confirm',
      html: renderAccountDeleteConfirmPage(deleteConfirmView()),
    },
    {
      name: 'account-delete-confirm-error',
      html: renderAccountDeleteConfirmPage(deleteConfirmView({ error: 'that login did not match' })),
    },
    { name: 'deleted', html: renderDeletedPage({ login: 'alice' }) },
    { name: 'deleted-xss-login', html: renderDeletedPage({ login: XSS_LOGIN }) },
    {
      name: 'token-once',
      html: renderTokenOncePage({ login: 'alice', token: 'mcpo_secrettoken', csrfToken: CSRF_TOKEN }),
    },
    { name: 'preparing', html: renderPreparingPage({ login: 'alice', csrfToken: CSRF_TOKEN }) },
    { name: 'preparing-xss-login', html: renderPreparingPage({ login: XSS_LOGIN, csrfToken: CSRF_TOKEN }) },
    { name: 'waitlist', html: renderWaitlistPage({ position: 3 }) },
    { name: 'terms', html: renderTermsPage() },
    { name: 'terms-signed-in', html: renderTermsPage({ signedIn: true, csrfToken: CSRF_TOKEN }) },
    { name: 'privacy', html: renderPrivacyPage({ minAccountAgeDays: 30 }) },
    { name: 'privacy-signed-in', html: renderPrivacyPage({ minAccountAgeDays: 30, signedIn: true, csrfToken: CSRF_TOKEN }) },
    ...ALL_REFUSAL_REASONS.map((reason) => ({
      name: `signin-refused-${reason.kind}`,
      html: renderSigninRefusedPage({ reason }),
    })),
  ]
}

const ALLOWED_LINK_PREFIXES = ['/', '#'] as const
const ALLOWED_EXTERNAL_ORIGIN = 'https://github.com/RostislavMatov/mcpcut'

function isAllowedLink(href: string): boolean {
  if (ALLOWED_LINK_PREFIXES.some((prefix) => href.startsWith(prefix))) return true
  return href === ALLOWED_EXTERNAL_ORIGIN || href.startsWith(`${ALLOWED_EXTERNAL_ORIGIN}/`)
}

describe('hub pages — escaping (XSS)', () => {
  test('an untrusted login is escaped everywhere it is rendered', () => {
    for (const page of allPages()) {
      expect(page.html, page.name).not.toContain(XSS_LOGIN)
      expect(page.html, page.name).not.toContain('<script>alert(1)</script>')
    }
    expect(renderAccountPage(accountView({ login: XSS_LOGIN }))).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(renderDeletedPage({ login: XSS_LOGIN })).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('an echoed delete-confirm error is escaped', () => {
    const document = renderAccountDeleteConfirmPage(
      deleteConfirmView({ error: '<img src=x onerror=alert(1)>' }),
    )
    expect(document).not.toContain('<img src=x onerror=alert(1)>')
    expect(document).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('hub pages — no inline scripts or styles (CSP: default-src \'none\')', () => {
  test('no page emits <script, <style or a style= attribute', () => {
    for (const page of allPages()) {
      expect(page.html, page.name).not.toMatch(/<script/i)
      expect(page.html, page.name).not.toMatch(/<style/i)
      expect(page.html, page.name).not.toMatch(/\sstyle\s*=/i)
      expect(page.html, page.name).not.toMatch(/\son[a-z]+\s*=/i)
    }
  })

  test('the stylesheet and icon are referenced same-origin, under /hub-assets/', () => {
    for (const page of allPages()) {
      expect(page.html, page.name).toContain('<link rel="stylesheet" href="/hub-assets/hub.css">')
      expect(page.html, page.name).toContain('/hub-assets/favicon.svg')
    }
  })
})

describe('hub pages — every POST form carries the CSRF field', () => {
  test('every <form method="post"> includes the hidden csrf_token input', () => {
    for (const page of allPages()) {
      const forms = page.html.match(/<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/gi) ?? []
      for (const form of forms) {
        expect(form, `${page.name}: ${form.slice(0, 80)}`).toMatch(/name="csrf_token"/)
      }
    }
  })

  test('the signed-in shell\'s sign-out form carries the session CSRF token', () => {
    const document = renderAccountPage(accountView({ csrfToken: 'the-session-token' }))
    const form = /<form method="post" action="\/signout" class="sign-out">[\s\S]*?<\/form>/.exec(document)?.[0]
    expect(form).toBeDefined()
    expect(form).toContain('name="csrf_token" value="the-session-token"')
  })
})

describe('hub pages — links stay relative or on the project repository', () => {
  test('every href is relative, an in-page anchor, or the mcpcut repository', () => {
    for (const page of allPages()) {
      const hrefs = [...page.html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1] ?? '')
      for (const href of hrefs) {
        expect(isAllowedLink(href), `${page.name}: href="${href}"`).toBe(true)
      }
    }
  })
})

describe('hub pages — forbidden words (CLAUDE.md)', () => {
  test('no page says tamper-proof or audit-ready, and tamper-evident is always qualified', () => {
    for (const page of allPages()) {
      expectNoBannedWords(page.html)
    }
  })
})

describe('renderHubLayout — nav shown only for a signed-in session', () => {
  test('signedIn omitted renders no topbar, no tabs and no sign-out form', () => {
    const document = renderHubLayout({ title: 'Sign-in', content: html`<p>hi</p>`, csrfToken: '' })
    expect(document).not.toContain('class="topbar"')
    expect(document).not.toContain('action="/signout"')
    // Terms/Privacy stay reachable even with no session.
    expect(document).toContain('href="/terms"')
    expect(document).toContain('href="/privacy"')
  })

  test('signedIn renders the full nav plus the sign-out form', () => {
    const document = renderHubLayout({
      title: 'Account',
      content: html`<p>hi</p>`,
      csrfToken: CSRF_TOKEN,
      signedIn: true,
      activeNav: 'account',
    })
    expect(document).toContain('class="topbar"')
    expect(document).toContain('href="/account" aria-current="page"')
    expect(document).toContain('action="/signout"')
  })
})

describe('signin-refused — every reason renders a distinct, human message', () => {
  test('each reason produces its own wording and no two collide', () => {
    const bodies = ALL_REFUSAL_REASONS.map((reason) => renderSigninRefusedPage({ reason }))
    expect(new Set(bodies).size).toBe(ALL_REFUSAL_REASONS.length)
  })

  test('too-young and recently-deleted both surface the retry date', () => {
    expect(renderSigninRefusedPage({ reason: { kind: 'too-young', retryOn: '2026-10-27', minAccountAgeDays: 30 } })).toContain(
      '2026-10-27',
    )
    expect(
      renderSigninRefusedPage({ reason: { kind: 'recently-deleted', retryOn: '2026-11-01' } }),
    ).toContain('2026-11-01')
  })

  test('too-young states the configured minimum age, not a fixed one', () => {
    const document = renderSigninRefusedPage({
      reason: { kind: 'too-young', retryOn: '2026-10-04', minAccountAgeDays: 7 },
    })

    expect(document).toContain('younger than 7 days')
    expect(document).not.toContain('30 days')
  })
})

describe('waitlist — shows the position and sets no expectation of email', () => {
  test('the position is rendered and no email promise is made', () => {
    const document = renderWaitlistPage({ position: 7 })
    expect(document).toContain('#7')
    expect(document).not.toMatch(/we('| )ll email|notify you by email/i)
  })
})

describe('account — the client config block', () => {
  test('carries the mcp address, the connect one-liner and a placeholder agent token', () => {
    const document = renderAccountPage(accountView({ serveUrl: 'https://alice.mcpcut.com' }))
    expect(document).toContain('https://alice.mcpcut.com/mcp')
    expect(document).toContain('npx mcpcut connect --url https://alice.mcpcut.com/mcp')
    // The JSON block sits inside <pre><code>, so its quotes are HTML entities.
    expect(document).toContain('&quot;mcpServers&quot;')
    expect(document).toContain('&quot;mcpcut&quot;')
    expect(document).toContain('MCP_AGENT_TOKEN')
    expect(document).toContain('&lt;your-agent-token&gt;')
    // Never a real-looking secret value in the placeholder's place.
    expect(document).not.toMatch(/MCP_AGENT_TOKEN&quot;:\s*&quot;(?!&lt;)/)
  })

  test('never claims to show the agent token itself', () => {
    const document = renderAccountPage(accountView())
    expect(document).toMatch(/agent create/)
  })
})

describe('terms and privacy — HA10 key points are present', () => {
  test('terms states free, as-is, no SLA, and links the repository issues', () => {
    const document = renderTermsPage()
    expect(document).toMatch(/free/i)
    expect(document).toMatch(/as is/i)
    expect(document).toMatch(/service-level agreement|SLA/i)
    expect(document).toContain('https://github.com/RostislavMatov/mcpcut/issues')
  })

  test('privacy discloses what is stored, operator access and the journal guarantee', () => {
    const document = renderPrivacyPage({ minAccountAgeDays: 30 })
    expect(document).toMatch(/GitHub.*(id|login)/i)
    expect(document).toMatch(/operator/i)
    expect(document).toContain('tamper-evident with an external anchor')
    expect(document).toMatch(/30 days/)
    expect(document).toContain('https://github.com/RostislavMatov/mcpcut/issues')
  })

  test('privacy states the configured minimum account age and the tombstone cooldown', () => {
    const document = renderPrivacyPage({ minAccountAgeDays: 7 })

    expect(document).toContain('older than 7 days')
    expect(document).toContain(`kept for ${DELETE_COOLDOWN_DAYS} days`)
  })
})
