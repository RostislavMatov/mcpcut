import { describe, expect, test } from 'vitest'
import { renderNoticePage } from '../../hub/src/pages/notice.js'
import { renderSignedInPage } from '../../hub/src/pages/signed-in.js'
import { expectNoBannedWords } from '../support/banned-words.js'

/**
 * The two pages Task 5 added: the generic notice (404, an action the
 * orchestrator could not complete) and the sign-in hand-over to `/account`.
 */

describe('renderNoticePage', () => {
  test('escapes the title and the message', () => {
    const page = renderNoticePage({ status: 'Not found', message: '<b>x</b>' })

    expect(page).toContain('<h1>Not found</h1>')
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(page).not.toContain('<b>x</b>')
  })

  test('signed in, it carries the nav and the CSRF token', () => {
    const page = renderNoticePage({ status: 'Owner token not issued', message: 'm', signedIn: true, csrfToken: 'tok' })

    expect(page).toContain('Sign out')
    expect(page).toContain('<meta name="csrf-token" content="tok">')
    expect(page).toContain('href="/account"')
  })

  test('signed out, it links home and has no sign-out', () => {
    const page = renderNoticePage({ status: 'Not found', message: 'm' })

    expect(page).not.toContain('Sign out')
    expect(page).toContain('href="/"')
    expectNoBannedWords(page)
  })
})

describe('renderSignedInPage', () => {
  test('moves on to /account at once, with a link for anyone whose browser does not', () => {
    const page = renderSignedInPage({ login: 'alice', csrfToken: 'tok' })

    expect(page).toContain('<meta http-equiv="refresh" content="0; url=/account">')
    expect(page).toContain('href="/account"')
    expect(page).toContain('@alice')
    expect(page).not.toMatch(/<script/i)
  })
})
