import { afterEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, findTombstone } from '../../hub/src/accounts-db.js'
import { markStopped } from '../../hub/src/accounts-idle.js'
import type { FakeProfile } from './fake-github.js'
import { HUB_TEST_START_MS, startHub, type Browser, type HubHarness } from './harness.js'

/**
 * Idle installs through the hub's pages (plan `hosted-path-and-ops`, Task C,
 * P5/P6): `/account` says when an unused install stops and is removed; a
 * person who comes back to a stopped install — by signing in or opening
 * `/account` — has it started in the background while the page says
 * "stopped — starting…"; a removed one's account is gone and the next sign-in
 * starts afresh; a missing install is said so, not hidden.
 */

const ALICE_ID = 4001
const ALICE: FakeProfile = { id: ALICE_ID, login: 'alice', created_at: '2019-03-04T05:06:07Z' }
const DAY = 24 * 60 * 60 * 1000
/** Less than the session's idle limit, so the browser stays signed in. */
const HOUR = 60 * 60 * 1000
const REFRESH_TO_ACCOUNT = /<meta http-equiv="refresh" content="\d+; url=\/account">/

let hub: HubHarness | undefined

afterEach(async () => {
  await hub?.close()
  hub = undefined
})

/** Alice signed in, her install made, her first owner token taken. */
async function activeAlice(): Promise<{ h: HubHarness; browser: Browser }> {
  hub = await startHub()
  const browser = hub.browser()
  await browser.signIn(ALICE)
  await hub.settle()
  await browser.get('/account')
  return { h: hub, browser }
}

function stopAlice(h: HubHarness, at: string): void {
  const account = findAccountByGithubId(h.db, ALICE_ID)
  if (account === null) throw new Error('no alice')
  markStopped(h.db, { githubId: ALICE_ID, createdAt: account.createdAt }, at)
  h.orchestrator.addInstall('alice', { running: false })
}

describe('/account and the idle dates', () => {
  test('a running install: stops on day 60 and is removed on day 90 if unused', async () => {
    const { browser } = await activeAlice()

    const page = await browser.get('/account')

    expect(page.status).toBe(200)
    expect(page.body).toContain('stops on 2026-11-26 if unused')
    expect(page.body).toContain('is removed on 2026-12-26 if unused')
    expect(page.body).not.toMatch(REFRESH_TO_ACCOUNT)
  })
})

describe('coming back to a stopped install', () => {
  test('/account starts it in the background and says "stopped — starting…" meanwhile', async () => {
    const { h, browser } = await activeAlice()
    stopAlice(h, new Date(HUB_TEST_START_MS).toISOString())
    h.orchestrator.hold('start')
    h.advance(HOUR)

    const page = await browser.get('/account')

    expect(page.status).toBe(200)
    expect(page.body).toContain('stopped — starting…')
    expect(page.body).toMatch(REFRESH_TO_ACCOUNT)
    expect(h.orchestrator.calls().filter((call) => call.method === 'start')).toEqual([{ method: 'start', subdomain: 'alice' }])
    h.orchestrator.release('start')
    await h.settle()

    const after = await browser.get('/account')
    expect(after.body).not.toContain('stopped — starting…')
    expect(findAccountByGithubId(h.db, ALICE_ID)).toMatchObject({ stoppedAt: null, lastSeenAt: new Date(HUB_TEST_START_MS + HOUR).toISOString() })
    expect(h.orchestrator.install('alice')?.running).toBe(true)
  })

  test('signing in starts it too, and the callback does not wait for the start', async () => {
    const { h } = await activeAlice()
    stopAlice(h, new Date(HUB_TEST_START_MS).toISOString())
    h.orchestrator.hold('start')

    const callback = await h.browser().signIn(ALICE)

    expect(callback.status).toBe(200)
    expect(h.orchestrator.calls().filter((call) => call.method === 'start')).toHaveLength(1)
    h.orchestrator.release('start')
    await h.settle()
    expect(findAccountByGithubId(h.db, ALICE_ID)?.stoppedAt).toBeNull()
  })

  test('a start that fails leaves it stopped and the next visit tries again', async () => {
    const { h, browser } = await activeAlice()
    stopAlice(h, new Date(HUB_TEST_START_MS).toISOString())
    h.orchestrator.fail('start')

    expect((await browser.get('/account')).body).toContain('stopped — starting…')
    await h.settle()
    h.orchestrator.succeed('start')
    await browser.get('/account')
    await h.settle()

    expect(h.orchestrator.calls().filter((call) => call.method === 'start')).toHaveLength(2)
    expect(findAccountByGithubId(h.db, ALICE_ID)?.stoppedAt).toBeNull()
  })
})

describe('the sweep through the running hub', () => {
  test('90 idle days: install and account removed, no tombstone, a new sign-in starts afresh', async () => {
    const { h } = await activeAlice()
    h.advance(91 * DAY)

    const summary = await h.server.sweep()

    expect(summary.entries.map((entry) => entry.outcome)).toEqual(['remove'])
    expect(findAccountByGithubId(h.db, ALICE_ID)).toBeNull()
    expect(findTombstone(h.db, ALICE_ID)).toBeNull()

    const again = await h.browser().signIn(ALICE)
    expect(again.body).toContain('Preparing your install')
    await h.settle()
    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('active')
    expect(h.orchestrator.installs()).toContain('alice')
  })

  test('60 idle days: stopped; signing in again and opening /account starts it', async () => {
    const { h } = await activeAlice()
    h.advance(61 * DAY)

    await h.server.sweep()
    expect(h.orchestrator.install('alice')?.running).toBe(false)
    expect(findAccountByGithubId(h.db, ALICE_ID)?.stoppedAt).toBe(new Date(HUB_TEST_START_MS + 61 * DAY).toISOString())

    h.orchestrator.hold('start')
    const browser = h.browser()
    await browser.signIn(ALICE)
    expect((await browser.get('/account')).body).toContain('stopped — starting…')
    h.orchestrator.release('start')
    await h.settle()
    expect(h.orchestrator.install('alice')?.running).toBe(true)
    expect(h.orchestrator.calls().filter((call) => call.method === 'start')).toHaveLength(1)
  })

  test('an install gone missing is said so on /account, and the account is kept', async () => {
    const { h, browser } = await activeAlice()
    await h.orchestrator.remove('alice')

    await h.server.sweep()
    const page = await browser.get('/account')

    expect(page.status).toBe(200)
    expect(page.body).toContain('Your install is missing')
    expect(page.body).toContain('contact the operator')
    expect(page.body).not.toContain('if unused')
    expect(findAccountByGithubId(h.db, ALICE_ID)?.status).toBe('active')
    expect(h.logs.join('\n')).toContain('install missing, account kept for the operator')
  })
})
