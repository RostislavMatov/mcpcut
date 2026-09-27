import { afterEach, describe, expect, test, vi } from 'vitest'
import { findAccountByGithubId, findTombstone, insertAccount } from '../../hub/src/accounts-db.js'
import type { FakeProfile } from './fake-github.js'
import { setCookiesOf, startHub, type Browser, type HubHarness } from './harness.js'

/**
 * A new person's first sign-in with the install made in the background (plan
 * `hosted-path-and-ops`, Task A, P1–P4): the callback answers at once with
 * "preparing", `/account` keeps saying so until the install is ready, then
 * shows the owner token exactly once; a failed creation says so once and
 * signs the person out; a restarted hub settles `pending` rows against the
 * provisioner.
 */

const ALICE_ID = 4001
const ALICE: FakeProfile = { id: ALICE_ID, login: 'alice', created_at: '2019-03-04T05:06:07Z' }
const REFRESH_TO_ACCOUNT = '<meta http-equiv="refresh" content="3; url=/account">'

let hub: HubHarness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await hub?.close()
  hub = undefined
})

async function start(): Promise<HubHarness> {
  hub = await startHub()
  return hub
}

async function signInHeld(h: HubHarness, browser: Browser): Promise<void> {
  h.orchestrator.hold('create')
  const callback = await browser.signIn(ALICE)
  expect(callback.status).toBe(200)
  expect(callback.body).toContain(REFRESH_TO_ACCOUNT)
}

describe('the callback does not wait for the install', () => {
  test('a create that hangs still gets an immediate "preparing" page and a session', async () => {
    const h = await start()
    const browser = h.browser()

    await signInHeld(h, browser)

    expect(h.orchestrator.calls()).toEqual([{ method: 'create', subdomain: 'alice' }])
    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('pending')
    expect(browser.has('__Host-mcpcut_hub')).toBe(true)
    expect(browser.has('__Host-mcpcut_oauth')).toBe(false)
    h.orchestrator.release('create')
    await h.settle()
  })

  test('/account says "preparing" and refreshes itself while the install is made', async () => {
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)

    const account = await browser.get('/account')

    expect(account.status).toBe(200)
    expect(account.body).toContain('Preparing your install')
    expect(account.body).toContain(REFRESH_TO_ACCOUNT)
    h.orchestrator.release('create')
    await h.settle()
  })

  test('a second sign-in while the install is made starts no second create', async () => {
    const h = await start()
    await signInHeld(h, h.browser())

    const again = await h.browser().signIn(ALICE)

    expect(again.status).toBe(200)
    expect(h.orchestrator.calls().filter((call) => call.method === 'create')).toHaveLength(1)
    h.orchestrator.release('create')
    await h.settle()
    expect(h.orchestrator.calls().filter((call) => call.method === 'create')).toHaveLength(1)
  })

  test('the account cannot be deleted while its install is still being made', async () => {
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)
    await browser.get('/account')

    const response = await browser.post('/account/delete', { login: 'alice' })

    expect(response.status).toBe(409)
    expect(h.orchestrator.calls().filter((call) => call.method === 'remove')).toEqual([])
    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('pending')
    h.orchestrator.release('create')
    await h.settle()
  })
})

describe('once the install is ready', () => {
  test('/account shows the owner token exactly once, then the ordinary account page', async () => {
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)

    h.orchestrator.release('create')
    await h.settle()
    const first = await browser.get('/account')
    const second = await browser.get('/account')

    const [token] = h.orchestrator.tokens()
    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('active')
    expect(first.status).toBe(200)
    expect(first.body).toContain(String(token))
    expect(first.body).toContain('shown once')
    expect(second.status).toBe(200)
    expect(second.body).not.toContain(String(token))
    expect(second.body).toContain('https://alice.mcpcut.com/mcp')
  })

  test('another browser of the same person never sees a token the first one took', async () => {
    const h = await start()
    const first = h.browser()
    await signInHeld(h, first)
    const second = h.browser()
    await second.signIn(ALICE)
    h.orchestrator.release('create')
    await h.settle()

    const seen = [(await first.get('/account')).body, (await second.get('/account')).body]

    const [token] = h.orchestrator.tokens()
    expect(seen.filter((body) => body.includes(String(token)))).toHaveLength(1)
  })

  test('a token not taken within 15 minutes is gone; issuing a new one still works', async () => {
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)
    h.orchestrator.release('create')
    await h.settle()

    h.advance(15 * 60 * 1000)
    const account = await browser.get('/account')

    expect(account.body).not.toContain(String(h.orchestrator.tokens()[0]))
    expect(account.body).toContain('Issue a new owner token')
  })

  test('the owner token reaches the page and nothing else: no log, stdout or stderr', async () => {
    const written: string[] = []
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)
    h.orchestrator.release('create')
    await h.settle()
    await browser.get('/account')

    const [token] = h.orchestrator.tokens()
    expect(token).toBeDefined()
    expect([...h.logs, ...written].join('\n')).not.toContain(String(token))
    expect(h.transcript.filter((entry) => entry.includes(String(token)))).toHaveLength(1)
  })
})

describe('when the install cannot be made', () => {
  test('/account says so once, signs the person out, and nothing is kept', async () => {
    const h = await start()
    const browser = h.browser()
    await signInHeld(h, browser)
    h.orchestrator.fail('create')

    h.orchestrator.release('create')
    await h.settle()
    const failed = await browser.get('/account')
    const after = await browser.get('/account')

    expect(failed.status).toBe(503)
    expect(failed.body).toContain('We could not create your install — sign in again.')
    expect(setCookiesOf(failed).some((cookie) => cookie.startsWith('__Host-mcpcut_hub=;'))).toBe(true)
    expect(findAccountByGithubId(h.db, ALICE_ID)).toBeNull()
    expect(findTombstone(h.db, ALICE_ID)).toBeNull()
    expect(after.status).toBe(303)
    expect(after.headers.location).toBe('/signin')
  })

  test('signing in again after a failure starts afresh', async () => {
    const h = await start()
    h.orchestrator.fail('create')
    await h.browser().signIn(ALICE)
    await h.settle()
    h.orchestrator.succeed('create')

    const browser = h.browser()
    await browser.signIn(ALICE)
    await h.settle()
    const account = await browser.get('/account')

    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('active')
    expect(account.body).toContain(String(h.orchestrator.tokens()[0]))
  })
})

describe('a restarted hub settles pending accounts (P4)', () => {
  function seedPending(h: HubHarness, githubId: number, login: string): void {
    const now = new Date(h.nowMs()).toISOString()
    const inserted = insertAccount(h.db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now }, 100)
    expect(inserted.ok).toBe(true)
  }

  test('present → active (a new token by rotation), absent → removed, unreachable → still pending', async () => {
    const h = await start()
    seedPending(h, 1, 'here')
    seedPending(h, 2, 'gone')
    h.orchestrator.addInstall('here')

    expect(await h.server.reconcilePending()).toEqual({ activated: 1, discarded: 1, leftPending: 0 })
    expect(findAccountByGithubId(h.db, 1)?.status).toBe('active')
    expect(findAccountByGithubId(h.db, 2)).toBeNull()

    seedPending(h, 3, 'unknown')
    h.orchestrator.fail('inspect', 'provisioner could not be reached (ECONNREFUSED)')
    expect(await h.server.reconcilePending()).toEqual({ activated: 0, discarded: 0, leftPending: 1 })
    expect(findAccountByGithubId(h.db, 3)?.status).toBe('pending')
    expect(h.logs.join('\n')).toContain('install status for unknown unknown, left pending')
  })
})
