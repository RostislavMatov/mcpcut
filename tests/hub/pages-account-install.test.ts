import { describe, expect, test } from 'vitest'
import { renderAccountPage, STARTING_REFRESH_SECONDS, type AccountView, type InstallState } from '../../hub/src/pages/account.js'

/**
 * The install panel of `/account` (plan `hosted-path-and-ops`, Task C, P6):
 * the idle dates while it runs, "stopped — starting…" with a self-refresh
 * while a stopped install starts, and a plain "missing, contact the operator"
 * when the provisioner holds nothing for the account.
 */

function view(install: InstallState): AccountView {
  return {
    login: 'alice',
    subdomain: 'alice',
    status: 'active',
    serveUrl: 'https://alice.mcpcut.com',
    csrfToken: 'csrf',
    install,
    stopsOn: '2026-11-26',
    removedOn: '2026-12-26',
  }
}

const REFRESH = `<meta http-equiv="refresh" content="${STARTING_REFRESH_SECONDS}; url=/account">`

describe('the install panel', () => {
  test('running: both dates, no refresh', () => {
    const page = renderAccountPage(view('running'))

    expect(page).toContain('stops on 2026-11-26 if unused')
    expect(page).toContain('is removed on 2026-12-26 if unused')
    expect(page).not.toContain(REFRESH)
  })

  test('starting: "stopped — starting…" and a refresh to /account', () => {
    const page = renderAccountPage(view('starting'))

    expect(page).toContain('stopped — starting…')
    expect(page).toContain(REFRESH)
    expect(page).not.toContain('stops on')
  })

  test('stopped with nothing to start it: the removal date, no refresh', () => {
    const page = renderAccountPage(view('stopped'))

    expect(page).toContain('removed on 2026-12-26 if unused')
    expect(page).not.toContain(REFRESH)
  })

  test('missing: says so and names the operator, no dates', () => {
    const page = renderAccountPage(view('missing'))

    expect(page).toContain('Your install is missing')
    expect(page).toContain('contact the operator')
    expect(page).not.toContain('if unused')
  })
})
