import http from 'node:http'
import https from 'node:https'
import { describe, expect, test, vi } from 'vitest'
import {
  GITHUB_API_BASE,
  GITHUB_MAX_RESPONSE_BYTES,
  GITHUB_TIMEOUT_MS,
  GITHUB_WEB_BASE,
  authorizeUrl,
  createGithubClient,
  type GithubClientOptions,
} from '../../hub/src/github.js'
import { DEFAULT_PROFILE, s256, type FakeGithub } from './fake-github.js'
import {
  SHORT_TIMEOUT_MS,
  VERIFIER,
  closedPortBase,
  fixedAnswerServer,
  githubErrorOf,
  streamingServer,
  useFakeGithub,
} from './github-harness.js'

const ctx = useFakeGithub()

interface PoolView {
  addRequest(...args: unknown[]): void
}

describe('authorizeUrl', () => {
  test('carries the client, the exact redirect URI, state and an S256 challenge, and no scope', () => {
    const url = new URL(
      authorizeUrl({ clientId: 'cid', redirectUri: 'https://mcpcut.com/auth/github/callback', state: 's1', codeChallenge: 'c1' }),
    )

    expect(`${url.origin}${url.pathname}`).toBe(`${GITHUB_WEB_BASE}/login/oauth/authorize`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://mcpcut.com/auth/github/callback',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
      allow_signup: 'true',
    })
  })

  test('the client builds it from its own configuration and web base', () => {
    const client = ctx.clientFor()

    const url = client.authorizeUrl({ state: 'st', codeChallenge: 'ch' })

    expect(url.startsWith(`${ctx.fake().baseUrl}/login/oauth/authorize?`)).toBe(true)
    expect(() => ctx.fake().approve(url)).not.toThrow()
  })

  test('the public bases are the real GitHub hosts', () => {
    expect(GITHUB_WEB_BASE).toBe('https://github.com')
    expect(GITHUB_API_BASE).toBe('https://api.github.com')
    expect(GITHUB_TIMEOUT_MS).toBe(10_000)
    expect(GITHUB_MAX_RESPONSE_BYTES).toBe(64 * 1024)
  })
})

describe('sign-in round trip', () => {
  test('approve → exchange → profile → revoke, against the strict fake', async () => {
    const client = ctx.clientFor()
    const { verifier, challenge } = { verifier: VERIFIER, challenge: s256(VERIFIER) }
    const { code } = ctx.fake().approve(client.authorizeUrl({ state: 'st', codeChallenge: challenge }))

    const token = await client.exchangeCode({ code, verifier })
    const profile = await client.fetchProfile(token)
    await client.revokeToken(token)

    expect(profile).toEqual({ id: DEFAULT_PROFILE.id, login: DEFAULT_PROFILE.login, createdAt: DEFAULT_PROFILE.created_at })
    expect(ctx.fake().revokedTokens()).toEqual([token])
    expect(ctx.fake().requests().map((r) => r.userAgent)).toEqual(['mcpcut-hub', 'mcpcut-hub', 'mcpcut-hub'])
    await expect(client.fetchProfile(token)).rejects.toMatchObject({ failure: 'http-status', status: 401 })
  })

  test('never borrows the process-wide agents', async () => {
    // `addRequest` is how `http.request` hands a request to its agent; it is
    // missing from the public typings, hence the narrow view.
    const httpSpy = vi.spyOn(http.globalAgent as unknown as PoolView, 'addRequest')
    const httpsSpy = vi.spyOn(https.globalAgent as unknown as PoolView, 'addRequest')
    const client = ctx.clientFor()

    const token = await ctx.tokenFor(client)
    await client.fetchProfile(token)
    await client.revokeToken(token)

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
  })
})

describe('exchangeCode', () => {
  test('a wrong verifier is bad_verification_code', async () => {
    const client = ctx.clientFor()
    const code = ctx.fake().issueCode(s256(VERIFIER))

    const error = await githubErrorOf(() => client.exchangeCode({ code, verifier: `${VERIFIER.slice(0, -1)}x` }))

    expect(error).toMatchObject({ failure: 'oauth-error', oauthError: 'bad_verification_code' })
  })

  test('a code is one-shot', async () => {
    const client = ctx.clientFor()
    const code = ctx.fake().issueCode(s256(VERIFIER))
    await client.exchangeCode({ code, verifier: VERIFIER })

    const error = await githubErrorOf(() => client.exchangeCode({ code, verifier: VERIFIER }))

    expect(error.oauthError).toBe('bad_verification_code')
  })

  test('a wrong client secret is refused', async () => {
    const client = ctx.clientFor({ clientSecret: 'not-the-secret' })

    const error = await githubErrorOf(() => ctx.tokenFor(client))

    expect(error.oauthError).toBe('incorrect_client_credentials')
  })

  test('a redirect URI other than the registered one is refused', async () => {
    const client = ctx.clientFor({ redirectUri: 'https://evil.test/auth/github/callback' })

    const error = await githubErrorOf(() => ctx.tokenFor(client))

    expect(error.oauthError).toBe('redirect_uri_mismatch')
  })

  test.each([
    ['error-500', { failure: 'http-status', status: 500 }],
    ['bad-shape', { failure: 'bad-response' }],
    ['oversized', { failure: 'bad-response' }],
    ['not-json', { failure: 'bad-response' }],
  ] as const)('a %s answer is a typed failure', async (behaviour, expected) => {
    ctx.fake().setBehaviour('token', behaviour)
    const client = ctx.clientFor()

    const error = await githubErrorOf(() => ctx.tokenFor(client))

    expect(error).toMatchObject(expected)
  })

  test('silence past the timeout is a timeout, not a hang', async () => {
    ctx.fake().setBehaviour('token', 'hang')
    const client = ctx.clientFor({ timeoutMs: SHORT_TIMEOUT_MS })
    const started = Date.now()

    const error = await githubErrorOf(() => ctx.tokenFor(client))

    expect(error.failure).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS * 10)
  })

  test('a closed port is unreachable', async () => {
    const closedBase = await closedPortBase()
    const client = ctx.clientFor({ webBase: closedBase })

    const error = await githubErrorOf(() => client.exchangeCode({ code: 'c', verifier: VERIFIER }))

    expect(error.failure).toBe('unreachable')
  })

  test('an https base goes through the https stack and a failed handshake is unreachable', async () => {
    const httpsSpy = vi.spyOn(https.globalAgent as unknown as PoolView, 'addRequest')
    // The fake speaks plain HTTP, so the TLS handshake against it fails.
    const tlsBase = ctx.fake().baseUrl.replace('http://', 'https://')
    const client = ctx.clientFor({ webBase: tlsBase })

    const error = await githubErrorOf(() => client.exchangeCode({ code: 'c', verifier: VERIFIER }))

    expect(error.failure).toBe('unreachable')
    expect(error.message).not.toContain(ctx.fake().clientSecret)
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(ctx.fake().requests()).toEqual([])
  })

  test('close() aborts a request in flight with a typed failure, not a hang', async () => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client)
    ctx.fake().setBehaviour('user', 'hang')

    const pending = githubErrorOf(() => client.fetchProfile(token))
    await untilHanging(ctx.fake())
    client.close()

    expect((await pending).failure).toBe('unreachable')
  })

  test('an unrecognisable OAuth error code is not echoed', async () => {
    const server = await fixedAnswerServer(200, JSON.stringify({ error: 'weird<code> gho_secretish' }))

    const error = await githubErrorOf(() =>
      ctx.clientFor({ webBase: server.base }).exchangeCode({ code: 'c', verifier: VERIFIER }),
    )

    expect(error).toMatchObject({ failure: 'oauth-error', oauthError: 'unrecognized' })
    expect(error.message).not.toContain('secretish')
    await server.close()
  })

  test('an access token with characters unfit for a header is refused', async () => {
    const server = await fixedAnswerServer(200, JSON.stringify({ access_token: 'gho_abc\r\nX-Injected: 1' }))

    const error = await githubErrorOf(() =>
      ctx.clientFor({ webBase: server.base }).exchangeCode({ code: 'c', verifier: VERIFIER }),
    )

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain('gho_abc')
    await server.close()
  })
  test('a JSON array is not an answer', async () => {
    const server = await fixedAnswerServer(200, '[]')

    const error = await githubErrorOf(() =>
      ctx.clientFor({ webBase: server.base }).exchangeCode({ code: 'c', verifier: VERIFIER }),
    )

    expect(error.failure).toBe('bad-response')
    await server.close()
  })

  test('a streamed body without a declared length is still capped', async () => {
    const server = await streamingServer(GITHUB_MAX_RESPONSE_BYTES + 1024)

    const error = await githubErrorOf(() =>
      ctx.clientFor({ webBase: server.base }).exchangeCode({ code: 'c', verifier: VERIFIER }),
    )

    expect(error.failure).toBe('bad-response')
    expect(error.message).toContain(String(GITHUB_MAX_RESPONSE_BYTES))
    await server.close()
  })
})

describe('createGithubClient', () => {
  const valid: GithubClientOptions = {
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'https://mcpcut.com/auth/github/callback',
  }

  test('defaults to the real GitHub hosts', () => {
    const client = createGithubClient(valid)

    const url = client.authorizeUrl({ state: 's', codeChallenge: 'c' })
    client.close()

    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true)
  })

  test.each([
    ['empty client id', { clientId: '' }],
    ['empty secret', { clientSecret: '' }],
    ['relative redirect URI', { redirectUri: '/auth/github/callback' }],
    ['non-http web base', { webBase: 'ftp://github.com' }],
    ['api base with a path', { apiBase: 'https://api.github.com/v3' }],
    ['base with credentials', { webBase: 'https://u:p@github.com' }],
    ['base with a query', { apiBase: 'https://api.github.com/?x=1' }],
    ['plain http off loopback', { webBase: 'http://github.com' }],
    ['unparsable base', { apiBase: 'not a url' }],
    ['zero timeout', { timeoutMs: 0 }],
    ['infinite timeout', { timeoutMs: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => createGithubClient({ ...valid, ...overrides })).toThrow(/createGithubClient/)
  })

  test('a refusal never quotes the secret', () => {
    const secret = 'super-secret-value-123'

    expect(() => createGithubClient({ ...valid, clientSecret: secret, webBase: 'nope' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    )
  })

  test('a trailing slash on a base is accepted', async () => {
    const client = ctx.clientFor({ webBase: `${ctx.fake().baseUrl}/`, apiBase: `${ctx.fake().baseUrl}/` })

    const token = await ctx.tokenFor(client)

    expect((await client.fetchProfile(token)).id).toBe(DEFAULT_PROFILE.id)
  })
})

/** Polls until the fake holds a hanging request, so `close()` hits one in flight. */
async function untilHanging(fake: FakeGithub): Promise<void> {
  const deadline = Date.now() + 2_000
  while (fake.hangingCount() === 0) {
    if (Date.now() > deadline) throw new Error('the fake never received the request')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
