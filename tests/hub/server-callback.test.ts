import { afterEach, describe, expect, test, vi } from 'vitest'
import { findAccountByGithubId } from '../../hub/src/accounts-db.js'
import { FAKE_CLIENT_SECRET } from './fake-github.js'
import { setCookiesOf, startHub, type HubHarness } from './harness.js'

/**
 * The callback's failure paths (plan Task 5, Edge Cases Checklist): a bad or
 * replayed flow, a refusal at GitHub, GitHub failing or lying, a failed
 * revocation — none of them a 500, and none of them leaking a GitHub token or
 * the client secret into a response, the hub's log, stdout or stderr.
 */

let hub: HubHarness | undefined

async function start(): Promise<HubHarness> {
  hub = await startHub()
  return hub
}

afterEach(async () => {
  vi.restoreAllMocks()
  await hub?.close()
  hub = undefined
})

describe('flow checks', () => {
  test('a callback without the flow cookie is refused', async () => {
    const h = await start()
    const begin = await h.request('GET', '/signin')
    const { callbackUrl } = h.github.approve(String(begin.headers.location))
    const url = new URL(callbackUrl)

    const response = await h.request('GET', `${url.pathname}${url.search}`)

    expect(response.status).toBe(400)
    expect(response.body).toContain('try again')
    expect(h.github.issuedTokens()).toEqual([])
  })

  test('a replayed callback is refused: the flow is single-use', async () => {
    const h = await start()
    const browser = h.browser()
    const begin = await browser.get('/signin')
    const flowCookie = browser.cookieHeader()
    const { callbackUrl } = h.github.approve(String(begin.headers.location))
    const url = new URL(callbackUrl)
    await browser.get(`${url.pathname}${url.search}`)

    const replay = await h.request('GET', `${url.pathname}${url.search}`, { cookie: flowCookie })

    expect(replay.status).toBe(400)
    expect(h.orchestrator.calls()).toHaveLength(1)
  })

  test('a callback whose state belongs to another flow is refused (login CSRF)', async () => {
    const h = await start()
    const victim = h.browser()
    await victim.get('/signin')
    const attackerStart = await h.request('GET', '/signin')
    const { callbackUrl } = h.github.approve(String(attackerStart.headers.location))
    const url = new URL(callbackUrl)

    const response = await victim.get(`${url.pathname}${url.search}`)

    expect(response.status).toBe(400)
    expect(findAccountByGithubId(h.db, 1_000_001)).toBeNull()
    expect(victim.has('__Host-mcpcut_hub')).toBe(false)
  })

  test('a callback with the flow but no code is refused', async () => {
    const h = await start()
    const browser = h.browser()
    const begin = await browser.get('/signin')
    const state = new URL(String(begin.headers.location)).searchParams.get('state') ?? ''

    const response = await browser.get(`/auth/github/callback?state=${state}`)

    expect(response.status).toBe(400)
  })

  test('the flow cookie is cleared by every callback answer', async () => {
    const h = await start()
    const browser = h.browser()
    await browser.get('/signin')

    const response = await browser.get('/auth/github/callback?error=access_denied&state=x')

    expect(setCookiesOf(response).some((cookie) => cookie.startsWith('__Host-mcpcut_oauth=;'))).toBe(true)
  })
})

describe('GitHub answers', () => {
  test('a refused authorization reads as cancelled', async () => {
    const h = await start()
    const browser = h.browser()
    await browser.get('/signin')

    const response = await browser.get('/auth/github/callback?error=access_denied&state=whatever')

    expect(response.status).toBe(200)
    expect(response.body).toContain('Sign-in was cancelled')
  })

  test('any other error parameter reads as try again', async () => {
    const h = await start()

    const response = await h.request('GET', '/auth/github/callback?error=redirect_uri_mismatch')

    expect(response.status).toBe(400)
    expect(response.body).toContain('try again')
  })

  test('a code GitHub refuses (bad_verification_code) is try again, not a 500', async () => {
    const h = await start()
    const browser = h.browser()
    const begin = await browser.get('/signin')
    const state = new URL(String(begin.headers.location)).searchParams.get('state') ?? ''

    const response = await browser.get(`/auth/github/callback?code=not-a-real-code&state=${state}`)

    expect(response.status).toBe(400)
    expect(response.body).toContain('try again')
  })

  test('GitHub not answering the exchange in time is "GitHub did not answer"', async () => {
    const h = await start()
    h.github.setBehaviour('token', 'hang')

    const response = await h.browser().signIn()

    expect(response.status).toBe(502)
    expect(response.body).toContain('GitHub did not answer')
  })

  test('a profile of the wrong shape is refused, and the token is still revoked', async () => {
    const h = await start()
    h.github.setBehaviour('user', 'bad-shape')

    const response = await h.browser().signIn()

    expect(response.status).toBe(502)
    expect(h.github.revokedTokens()).toEqual(h.github.issuedTokens())
    expect(h.orchestrator.calls()).toEqual([])
  })

  test('a login that is not a GitHub login (markup) is refused and never echoed', async () => {
    const h = await start()

    const response = await h.browser().signIn({ id: 77, login: '<script>alert(1)</script>', created_at: '2019-01-01T00:00:00Z' })

    expect(response.status).toBe(502)
    expect(response.body).not.toContain('<script>alert(1)')
    expect(findAccountByGithubId(h.db, 77)).toBeNull()
  })

  test('a failed revocation is logged without the token and sign-in continues', async () => {
    const h = await start()
    h.github.setBehaviour('revoke', 'error-500')

    const response = await h.browser().signIn()
    await h.settle()

    expect(response.status).toBe(200)
    expect(findAccountByGithubId(h.db, 1_000_001)?.status).toBe('active')
    expect(h.logs.some((line) => line.includes('revocation') && line.includes('HTTP 500'))).toBe(true)
  })
})

describe('secrets never leave the process', () => {
  test('no GitHub token and no client secret in responses, logs, stdout or stderr', async () => {
    const written: string[] = []
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    const h = await start()
    h.github.setBehaviour('revoke', 'error-500')
    const browser = h.browser()
    await browser.signIn()
    await h.settle()
    await browser.get('/account')
    await browser.get('/account')
    await browser.post('/account/token')
    h.github.setBehaviour('user', 'not-json')
    await h.browser().signIn({ id: 5, login: 'other', created_at: '2019-01-01T00:00:00Z' })

    const everything = [...h.transcript, ...h.logs, ...written].join('\n')
    const tokens = h.github.issuedTokens()
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(everything).not.toContain(token)
    expect(everything).not.toContain(FAKE_CLIENT_SECRET)
    expect(everything).not.toContain('LEAKED_IN_BODY')
    // Owner tokens belong in exactly one place: the page that shows them once.
    const logged = [...h.logs, ...written].join('\n')
    expect(h.orchestrator.tokens()).toHaveLength(2)
    for (const ownerToken of h.orchestrator.tokens()) expect(logged).not.toContain(ownerToken)
  })

  test('a token quoted in an orchestrator error never reaches a response, log, stdout or stderr', async () => {
    const written: string[] = []
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    const leaked = {
      create: 'mcpo_createLeak0123456789',
      rotateOwnerToken: 'ghp_rotateLeak0123456789abcd',
      remove: 'github_pat_11REMOVE0123456789_removeLeakRemoveLeak',
    } as const
    const h = await start()
    const browser = h.browser()
    await browser.signIn()
    await h.settle()
    await browser.get('/account')
    await browser.get('/account')
    for (const [method, token] of Object.entries(leaked)) {
      h.orchestrator.fail(method as keyof typeof leaked, `upstream said: bearer ${token} rejected`)
    }

    await browser.post('/account/token')
    await browser.post('/account/delete', { login: 'alice' })
    await h.browser().signIn({ id: 6, login: 'another', created_at: '2019-01-01T00:00:00Z' })
    await h.settle()

    const failures = h.logs.filter((line) => line.includes('failed'))
    expect(failures).toHaveLength(3)
    for (const line of failures) expect(line).toContain('[redacted]')
    const everything = [...h.transcript, ...h.logs, ...written].join('\n')
    for (const token of Object.values(leaked)) expect(everything).not.toContain(token)
  })
})
