import { afterEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, findTombstone, setStatus } from '../../hub/src/accounts-db.js'
import { createGithubClient } from '../../hub/src/github.js'
import { createHubServer } from '../../hub/src/server.js'
import type { FakeProfile } from './fake-github.js'
import { HUB_TEST_PUBLIC_URL, setCookiesOf, startHub, type Browser, type HubHarness } from './harness.js'

/**
 * The signed-in surface (plan Task 5): `/account`, rotating the owner token,
 * deleting the account, signing out, a blocked account's live session, the
 * public policy pages, and what a restart does to sessions.
 */

const ALICE: FakeProfile = { id: 3001, login: 'alice', created_at: '2019-03-04T05:06:07Z' }

let hub: HubHarness | undefined

async function signedIn(): Promise<{ h: HubHarness; browser: Browser }> {
  hub = await startHub()
  const browser = hub.browser()
  await browser.signIn(ALICE)
  // The install is made in the background; the first `/account` after it shows the owner token once.
  await hub.settle()
  await browser.get('/account')
  return { h: hub, browser }
}

afterEach(async () => {
  await hub?.close()
  hub = undefined
})

describe('GET /account', () => {
  test('shows the subdomain, the status and the client config, CSRF in the page', async () => {
    const { browser } = await signedIn()

    const response = await browser.get('/account')

    expect(response.status).toBe(200)
    expect(response.body).toContain('@alice')
    expect(response.body).toContain('https://alice.mcpcut.com/mcp')
    expect(browser.csrfToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('without a session a visit is sent to sign in', async () => {
    hub = await startHub()

    const response = await hub.request('GET', '/account')

    expect(response.status).toBe(303)
    expect(response.headers.location).toBe('/signin')
  })

  test('a dead session cookie is cleared on the way', async () => {
    hub = await startHub()

    const response = await hub.request('GET', '/account', { cookie: `__Host-mcpcut_hub=${'z'.repeat(43)}` })

    expect(response.status).toBe(303)
    expect(setCookiesOf(response).some((cookie) => cookie.startsWith('__Host-mcpcut_hub=;'))).toBe(true)
  })

  test('a session idle for 24 hours is over', async () => {
    const { h, browser } = await signedIn()

    h.advance(24 * 60 * 60 * 1000)

    expect((await browser.get('/account')).status).toBe(303)
  })
})

describe('POST /account/token', () => {
  test('rotates the owner token and shows the new one once', async () => {
    const { h, browser } = await signedIn()

    const response = await browser.post('/account/token')

    expect(response.status).toBe(200)
    const tokens = h.orchestrator.tokens()
    expect(tokens).toHaveLength(2)
    expect(response.body).toContain(tokens[1])
    expect(h.orchestrator.calls().at(-1)).toEqual({ method: 'rotateOwnerToken', subdomain: 'alice' })
  })

  test('without the CSRF token it is refused and nothing rotates', async () => {
    const { h, browser } = await signedIn()

    const response = await browser.post('/account/token', { csrf_token: '' })

    expect(response.status).toBe(403)
    expect(h.orchestrator.tokens()).toHaveLength(1)
  })

  test('with another session’s CSRF token it is refused', async () => {
    const { h, browser } = await signedIn()
    const other = h.browser()
    await other.signIn({ id: 3002, login: 'bob', created_at: '2019-03-04T05:06:07Z' })
    await other.get('/account')

    const response = await browser.post('/account/token', { csrf_token: other.csrfToken() })

    expect(response.status).toBe(403)
  })

  test('from a foreign origin it is refused', async () => {
    const { browser } = await signedIn()

    const response = await browser.post('/account/token', {}, { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  test('without a session it is refused, not redirected', async () => {
    hub = await startHub()

    const response = await hub.request('POST', '/account/token', { form: { csrf_token: 'x' } })

    expect(response.status).toBe(403)
  })

  test('an orchestrator failure is a notice, not a 500', async () => {
    const { h, browser } = await signedIn()
    h.orchestrator.fail('rotateOwnerToken')

    const response = await browser.post('/account/token')

    expect(response.status).toBe(503)
    expect(response.body).toContain('not issued')
  })

  test('an orchestrator that is not available refuses before calling it', async () => {
    const { h, browser } = await signedIn()
    h.orchestrator.available = false

    const response = await browser.post('/account/token')

    expect(response.status).toBe(503)
    expect(h.orchestrator.calls().filter((call) => call.method === 'rotateOwnerToken')).toEqual([])
  })
})

describe('deleting the account', () => {
  test('the confirmation page asks for the login', async () => {
    const { browser } = await signedIn()

    const response = await browser.get('/account/delete')

    expect(response.status).toBe(200)
    expect(response.body).toContain('Type your GitHub login to confirm')
  })

  test('a mistyped login deletes nothing', async () => {
    const { h, browser } = await signedIn()

    const response = await browser.post('/account/delete', { login: 'alicf' })

    expect(response.status).toBe(400)
    expect(response.body).toContain('does not match')
    expect(findAccountByGithubId(h.db, 3001)?.status).toBe('active')
    expect(h.orchestrator.installs()).toEqual(['alice'])
  })

  test('without CSRF nothing is deleted', async () => {
    const { h, browser } = await signedIn()

    const response = await browser.post('/account/delete', { login: 'alice', csrf_token: 'nope' })

    expect(response.status).toBe(403)
    expect(findAccountByGithubId(h.db, 3001)).not.toBeNull()
  })

  test('with the orchestrator unavailable it is refused and the account is intact', async () => {
    const { h, browser } = await signedIn()
    h.orchestrator.available = false

    const response = await browser.post('/account/delete', { login: 'alice' })

    expect(response.status).toBe(503)
    expect(response.body).toContain('nothing was deleted')
    expect(findAccountByGithubId(h.db, 3001)?.status).toBe('active')
  })

  test('when removing the install fails, the account is intact', async () => {
    const { h, browser } = await signedIn()
    h.orchestrator.fail('remove')

    const response = await browser.post('/account/delete', { login: 'alice' })

    expect(response.status).toBe(503)
    expect(findAccountByGithubId(h.db, 3001)).not.toBeNull()
    expect(findTombstone(h.db, 3001)).toBeNull()
  })

  test('the typed login matches case-insensitively; the install, the row and every session go', async () => {
    const { h, browser } = await signedIn()
    const secondBrowser = h.browser()
    await secondBrowser.signIn(ALICE)

    const response = await browser.post('/account/delete', { login: ' ALICE ' })

    expect(response.status).toBe(200)
    expect(response.body).toContain('Account deleted')
    expect(h.orchestrator.installs()).toEqual([])
    expect(findAccountByGithubId(h.db, 3001)).toBeNull()
    expect(findTombstone(h.db, 3001)?.reason).toBe('deleted')
    expect(browser.has('__Host-mcpcut_hub')).toBe(false)
    expect((await secondBrowser.get('/account')).status).toBe(303)
  })

  test('signing in again right after is "recently deleted"', async () => {
    const { h, browser } = await signedIn()
    await browser.post('/account/delete', { login: 'alice' })

    const response = await h.browser().signIn(ALICE)

    expect(response.status).toBe(403)
    expect(response.body).toContain('deleted recently')
  })
})

describe('sign-out and blocking', () => {
  test('sign-out ends the session and returns home', async () => {
    const { browser } = await signedIn()

    const response = await browser.post('/signout')

    expect(response.status).toBe(303)
    expect(response.headers.location).toBe('/')
    expect(browser.has('__Host-mcpcut_hub')).toBe(false)
  })

  test('sign-out without CSRF is refused', async () => {
    const { browser } = await signedIn()

    expect((await browser.post('/signout', { csrf_token: '' })).status).toBe(403)
  })

  test('sign-out with no session just goes home', async () => {
    hub = await startHub()

    const response = await hub.request('POST', '/signout', { form: {} })

    expect(response.status).toBe(303)
  })

  test('an account blocked while signed in: the next request signs out and says why', async () => {
    const { h, browser } = await signedIn()
    setStatus(h.db, 3001, 'blocked')

    const response = await browser.get('/account')

    expect(response.status).toBe(403)
    expect(response.body).toContain('blocked')
    expect(browser.has('__Host-mcpcut_hub')).toBe(false)
    expect((await browser.get('/account')).status).toBe(303)
  })
})

describe('policy pages', () => {
  test('/terms and /privacy are public', async () => {
    hub = await startHub()

    const terms = await hub.request('GET', '/terms')
    const privacy = await hub.request('GET', '/privacy')

    expect(terms.status).toBe(200)
    expect(terms.body).toContain('<h1>Terms</h1>')
    expect(privacy.status).toBe(200)
    expect(privacy.body).not.toContain('Sign out')
  })

  test('/privacy states the configured minimum account age', async () => {
    hub = await startHub({ config: { minAccountAgeDays: 7 } })

    const privacy = await hub.request('GET', '/privacy')

    expect(privacy.body).toContain('older than 7 days')
  })

  test('signed in, they carry the nav and sign-out', async () => {
    const { browser } = await signedIn()

    const privacy = await browser.get('/privacy')

    expect(privacy.body).toContain('Sign out')
  })
})

describe('restart', () => {
  test('sessions are gone, accounts are not', async () => {
    const { h, browser } = await signedIn()
    const client = createGithubClient({
      clientId: h.github.clientId,
      clientSecret: h.github.clientSecret,
      redirectUri: h.github.redirectUri,
      webBase: h.github.baseUrl,
      apiBase: h.github.baseUrl,
    })
    const restarted = createHubServer({
      config: {
        publicUrl: HUB_TEST_PUBLIC_URL,
        tenantDomain: 'mcpcut.com',
        maxAccounts: 15,
        minAccountAgeDays: 30,
        signupsPerHourPerIp: 3,
        trustCfConnectingIp: false,
      },
      db: h.db,
      github: client,
      orchestrator: h.orchestrator,
      log: () => undefined,
    })
    const { port } = await restarted.listen(0, '127.0.0.1')
    try {
      const { request } = await import('node:http')
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/account',
            headers: { host: 'mcpcut.test', cookie: browser.cookieHeader() },
            agent: false,
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })

      expect(status).toBe(303)
      expect(findAccountByGithubId(h.db, 3001)?.status).toBe('active')
    } finally {
      await restarted.close()
      client.close()
    }
  })
})
