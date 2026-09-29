import { describe, expect, test } from 'vitest'
import { renderAccountPage, type AccountView, type InstallState } from '../../hub/src/pages/account.js'
import { renderSigninRefusedPage } from '../../hub/src/pages/signin-refused.js'
import { renderTokenOncePage } from '../../hub/src/pages/token-once.js'

/**
 * Hub pages end with the next step (owner's rule 2026-09-29): the console
 * the owner token opens, where an agent token is made, where to write when
 * something is wrong — and, since the hub keeps no email, the one place a
 * person can tell us whether it worked.
 */

const CONSOLE = 'https://alice.mcpcut.com'
const ISSUES = 'https://github.com/RostislavMatov/mcpcut/issues'
const FEEDBACK = 'https://github.com/RostislavMatov/mcpcut/discussions/1'

function view(install: InstallState = 'running'): AccountView {
  return {
    login: 'alice',
    subdomain: 'alice',
    status: 'active',
    serveUrl: CONSOLE,
    csrfToken: 'csrf',
    install,
    stopsOn: '2026-11-26',
    removedOn: '2026-12-26',
  }
}

describe('account', () => {
  test('asks whether it worked, one click to the feedback discussion', () => {
    const page = renderAccountPage(view())
    expect(page).toMatch(new RegExp(`Did it work for you\\? <a href="${FEEDBACK}">Tell us in one click</a>`))
  })

  test('links the console the owner token signs in to', () => {
    const page = renderAccountPage(view())
    expect(page).toMatch(/<a href="https:\/\/alice\.mcpcut\.com\/">alice\.mcpcut\.com<\/a> — your console; sign in there with your owner token\./)
  })

  test('the agent token is made in the console, linked — not with a CLI the hosted user cannot run', () => {
    const page = renderAccountPage(view())
    expect(page).toContain(`<a href="${CONSOLE}/agents">Agents → Create an agent</a>`)
    expect(page).not.toContain('mcpcut agent create')
  })

  test('a missing install says where to report it', () => {
    const page = renderAccountPage(view('missing'))
    expect(page).toContain('Your install is missing')
    expect(page).toContain(`<a href="${ISSUES}">`)
  })

  test('a stopped install offers to check again', () => {
    const page = renderAccountPage(view('stopped'))
    expect(page).toContain('<a href="/account">Check again</a>')
  })
})

describe('owner token, shown once', () => {
  test('says where the token is used, with the real console address', () => {
    const page = renderTokenOncePage({ login: 'alice', token: 'mcpo_x', csrfToken: 'c', serveUrl: CONSOLE })
    expect(page).toMatch(/Next: sign in to your console at <a href="https:\/\/alice\.mcpcut\.com\/">alice\.mcpcut\.com<\/a> with it\./)
    expect(page).toContain('<a href="/account">Continue to your account</a>')
  })
})

describe('sign-in refused', () => {
  test('blocked: the repository issues are a link, not a description', () => {
    const page = renderSigninRefusedPage({ reason: { kind: 'blocked' } })
    expect(page).toContain(`<a href="${ISSUES}">`)
  })
})
