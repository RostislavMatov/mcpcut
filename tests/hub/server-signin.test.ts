import { afterEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, findTombstone, insertAccount, setStatus, deleteAccount } from '../../hub/src/accounts-db.js'
import { unavailableOrchestrator } from '../../hub/src/orchestrator.js'
import type { FakeProfile } from './fake-github.js'
import { HUB_TEST_START_MS, setCookiesOf, startHub, type HubHarness, type StartHubOptions } from './harness.js'

/**
 * `GET /signin` and `GET /auth/github/callback` end to end (plan Task 5):
 * the sign-in dance against the strict fake GitHub, and every branch of
 * `decide` as a visitor sees it.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const OLD_ENOUGH = '2019-03-04T05:06:07Z'

let hub: HubHarness | undefined

async function start(options: StartHubOptions = {}): Promise<HubHarness> {
  hub = await startHub(options)
  return hub
}

afterEach(async () => {
  await hub?.close()
  hub = undefined
})

function profile(id: number, login: string, createdAt = OLD_ENOUGH): FakeProfile {
  return { id, login, created_at: createdAt }
}

function seedAccount(h: HubHarness, githubId: number, login: string): void {
  const now = new Date(h.nowMs()).toISOString()
  const inserted = insertAccount(
    h.db,
    { githubId, login, subdomain: login.toLowerCase(), githubCreatedAt: OLD_ENOUGH, now },
    1000,
  )
  expect(inserted.ok).toBe(true)
  setStatus(h.db, githubId, 'active')
}

describe('GET /signin', () => {
  test('sets the Lax flow cookie and redirects to GitHub with PKCE and state', async () => {
    const h = await start()

    const response = await h.request('GET', '/signin')

    expect(response.status).toBe(302)
    const location = new URL(String(response.headers.location))
    expect(location.origin).toBe(h.github.baseUrl)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('redirect_uri')).toBe('https://mcpcut.test/auth/github/callback')
    expect(setCookiesOf(response).join('\n')).toMatch(/__Host-mcpcut_oauth=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax/)
  })

  test('an already signed-in visitor goes straight to the account', async () => {
    const h = await start()
    const browser = h.browser()
    await browser.signIn()

    const response = await browser.get('/signin')

    expect(response.status).toBe(303)
    expect(response.headers.location).toBe('/account')
  })

  test('is rate limited per IP before any flow is minted', async () => {
    const h = await start()
    let last = await h.request('GET', '/signin')
    for (let attempt = 0; attempt < 40 && last.status === 302; attempt += 1) last = await h.request('GET', '/signin')

    expect(last.status).toBe(429)
    expect(last.body).toContain('Too many sign-ins')
    expect(setCookiesOf(last)).toEqual([])
  })
})

describe('first sign-in', () => {
  test('creates the account and shows the owner token once, signed in', async () => {
    const h = await start()
    const browser = h.browser()

    const response = await browser.signIn(profile(501, 'Alice'))

    expect(response.status).toBe(200)
    const [token] = h.orchestrator.tokens()
    expect(token).toBeDefined()
    expect(response.body).toContain(token)
    expect(findAccountByGithubId(h.db, 501)).toMatchObject({ login: 'Alice', subdomain: 'alice', status: 'active' })
    expect(h.orchestrator.calls()).toEqual([{ method: 'create', subdomain: 'alice' }])
    expect(browser.has('__Host-mcpcut_hub')).toBe(true)
    expect(browser.has('__Host-mcpcut_oauth')).toBe(false)

    const account = await browser.get('/account')
    expect(account.status).toBe(200)
    expect(account.body).toContain('alice.mcpcut.com')
    expect(account.body).not.toContain(token)
  })

  test('the session cookie is __Host-, Strict, Secure and HttpOnly', async () => {
    const h = await start()
    const browser = h.browser()

    const response = await browser.signIn()

    const cookie = setCookiesOf(response).find((value) => value.startsWith('__Host-mcpcut_hub='))
    expect(cookie).toMatch(/; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/)
  })

  test('the GitHub token is revoked before the answer', async () => {
    const h = await start()

    await h.browser().signIn()

    expect(h.github.revokedTokens()).toEqual(h.github.issuedTokens())
    expect(h.github.revokedTokens()).toHaveLength(1)
  })

  test('an orchestrator failure removes the pending account and says try again', async () => {
    const h = await start()
    h.orchestrator.fail('create')
    const browser = h.browser()

    const response = await browser.signIn(profile(502, 'bob'))

    expect(response.status).toBe(503)
    expect(response.body).toContain('Nothing was created')
    expect(findAccountByGithubId(h.db, 502)).toBeNull()
    expect(findTombstone(h.db, 502)).toBeNull()
    expect(browser.has('__Host-mcpcut_hub')).toBe(false)
  })
})

describe('returning sign-in', () => {
  test('the same GitHub id is the same account, even under a new login', async () => {
    const h = await start()
    await h.browser().signIn(profile(601, 'carol'))
    h.advance(1000)
    const browser = h.browser()

    const response = await browser.signIn(profile(601, 'carol-renamed'))

    expect(response.status).toBe(200)
    expect(response.body).toContain('<meta http-equiv="refresh" content="0; url=/account">')
    expect(h.orchestrator.calls().filter((call) => call.method === 'create')).toHaveLength(1)
    expect(findAccountByGithubId(h.db, 601)).toMatchObject({ login: 'carol-renamed', subdomain: 'carol' })
    expect((await browser.get('/account')).status).toBe(200)
  })

  test('a new GitHub id with a taken login gets a suffixed subdomain', async () => {
    const h = await start()
    seedAccount(h, 700, 'dave')

    await h.browser().signIn(profile(701, 'dave'))

    expect(findAccountByGithubId(h.db, 701)?.subdomain).toBe('dave-2')
  })
})

describe('refusals', () => {
  test('a GitHub account younger than 30 days is refused with the date', async () => {
    const h = await start()
    const createdAt = new Date(HUB_TEST_START_MS - 29 * DAY_MS).toISOString()

    const response = await h.browser().signIn(profile(801, 'young', createdAt))

    expect(response.status).toBe(403)
    expect(response.body).toContain('younger than 30 days')
    expect(response.body).toContain(new Date(HUB_TEST_START_MS + DAY_MS).toISOString().slice(0, 10))
    expect(findAccountByGithubId(h.db, 801)).toBeNull()
  })

  test('the refusal names the configured minimum age', async () => {
    const h = await start({ config: { minAccountAgeDays: 7 } })
    const createdAt = new Date(HUB_TEST_START_MS - 6 * DAY_MS).toISOString()

    const response = await h.browser().signIn(profile(803, 'fresh', createdAt))

    expect(response.status).toBe(403)
    expect(response.body).toContain('younger than 7 days')
    expect(response.body).not.toContain('30 days')
  })

  test('a blocked account is refused', async () => {
    const h = await start()
    seedAccount(h, 802, 'mallory')
    setStatus(h.db, 802, 'blocked')

    const response = await h.browser().signIn(profile(802, 'mallory'))

    expect(response.status).toBe(403)
    expect(response.body).toContain('blocked')
  })

  test('a recently deleted account is refused until the cooldown ends', async () => {
    const h = await start()
    seedAccount(h, 803, 'erin')
    deleteAccount(h.db, 803, 'deleted', new Date(HUB_TEST_START_MS).toISOString())

    const response = await h.browser().signIn(profile(803, 'erin'))

    expect(response.status).toBe(403)
    expect(response.body).toContain('deleted recently')
  })

  test('signups per IP per hour are limited', async () => {
    const h = await start({ config: { signupsPerHourPerIp: 1 } })
    await h.browser().signIn(profile(901, 'first'))

    const response = await h.browser().signIn(profile(902, 'second'))

    expect(response.status).toBe(429)
    expect(findAccountByGithubId(h.db, 902)).toBeNull()
  })

  test('the per-IP limit follows CF-Connecting-IP only when trusted', async () => {
    const h = await start({ config: { signupsPerHourPerIp: 1, trustCfConnectingIp: true } })
    const first = h.browser()
    const second = h.browser()
    await first.signIn(profile(911, 'one'))

    const start2 = await second.get('/signin', { headers: { 'cf-connecting-ip': '203.0.113.7' } })
    const { callbackUrl } = h.github.approve(String(start2.headers.location), profile(912, 'two'))
    const url = new URL(callbackUrl)
    const response = await second.get(`${url.pathname}${url.search}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } })

    expect(response.status).toBe(200)
    expect(findAccountByGithubId(h.db, 912)?.status).toBe('active')
  })

  test('an untrusted CF-Connecting-IP does not open a fresh window', async () => {
    const h = await start({ config: { signupsPerHourPerIp: 1 } })
    const spoofing = h.browser()
    await h.browser().signIn(profile(921, 'one'))

    const begin = await spoofing.get('/signin', { headers: { 'cf-connecting-ip': '203.0.113.8' } })
    const { callbackUrl } = h.github.approve(String(begin.headers.location), profile(922, 'two'))
    const url = new URL(callbackUrl)
    const response = await spoofing.get(`${url.pathname}${url.search}`, { headers: { 'cf-connecting-ip': '203.0.113.8' } })

    expect(response.status).toBe(429)
    expect(findAccountByGithubId(h.db, 922)).toBeNull()
  })
})

describe('waitlist', () => {
  test('at the account ceiling a new visitor joins the waitlist with a number', async () => {
    const h = await start({ config: { maxAccounts: 1 } })
    seedAccount(h, 1000, 'first')

    const response = await h.browser().signIn(profile(1001, 'late'))

    expect(response.status).toBe(200)
    expect(response.body).toContain('Position #1')
    expect(findAccountByGithubId(h.db, 1001)).toBeNull()
  })

  test('with the phase-2 unavailable orchestrator everyone is waitlisted', async () => {
    const h = await start({ orchestrator: unavailableOrchestrator })

    const first = await h.browser().signIn(profile(1101, 'one'))
    const second = await h.browser().signIn(profile(1102, 'two'))

    expect(first.body).toContain('Position #1')
    expect(second.body).toContain('Position #2')
    expect(findAccountByGithubId(h.db, 1101)).toBeNull()
  })

  test('two sign-ins racing for the last seat create exactly one account', async () => {
    const h = await start({ config: { maxAccounts: 2 } })
    seedAccount(h, 1200, 'seated')
    const a = h.browser()
    const b = h.browser()
    const startA = await a.get('/signin')
    const startB = await b.get('/signin')
    const callbackA = new URL(h.github.approve(String(startA.headers.location), profile(1201, 'racer-a')).callbackUrl)
    const callbackB = new URL(h.github.approve(String(startB.headers.location), profile(1202, 'racer-b')).callbackUrl)

    const [responseA, responseB] = await Promise.all([
      a.get(`${callbackA.pathname}${callbackA.search}`),
      b.get(`${callbackB.pathname}${callbackB.search}`),
    ])

    const created = [1201, 1202].filter((id) => findAccountByGithubId(h.db, id) !== null)
    expect(created).toHaveLength(1)
    expect([responseA.body, responseB.body].filter((body) => body.includes('Position #1'))).toHaveLength(1)
  })
})
