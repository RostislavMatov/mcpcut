import { describe, expect, test, vi } from 'vitest'
import type { GithubError } from '../../hub/src/github.js'
import { DEFAULT_PROFILE, type FakeProfile } from './fake-github.js'
import { SHORT_TIMEOUT_MS, VERIFIER, githubErrorOf, useFakeGithub } from './github-harness.js'

const ctx = useFakeGithub()

describe('fetchProfile', () => {
  test('ignores the extra fields GitHub sends', async () => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client, { id: 42, login: 'Bob-the-builder', created_at: '2020-01-02T03:04:05Z' })

    expect(await client.fetchProfile(token)).toEqual({ id: 42, login: 'Bob-the-builder', createdAt: '2020-01-02T03:04:05Z' })
  })

  test('a 39-character login is accepted', async () => {
    const client = ctx.clientFor()
    const login = 'a'.repeat(39)
    const token = await ctx.tokenFor(client, { ...DEFAULT_PROFILE, login })

    expect((await client.fetchProfile(token)).login).toBe(login)
  })

  test.each([
    ['id missing', { login: 'alice', created_at: '2019-03-04T05:06:07Z' }, 'id'],
    ['id as string', { id: '1', login: 'alice', created_at: '2019-03-04T05:06:07Z' }, 'id'],
    ['id fractional', { id: 1.5, login: 'alice', created_at: '2019-03-04T05:06:07Z' }, 'id'],
    ['id zero', { id: 0, login: 'alice', created_at: '2019-03-04T05:06:07Z' }, 'id'],
    ['id unsafe', { id: 2 ** 53, login: 'alice', created_at: '2019-03-04T05:06:07Z' }, 'id'],
    ['login markup', { id: 1, login: '<script>', created_at: '2019-03-04T05:06:07Z' }, 'login'],
    ['login too long', { id: 1, login: 'a'.repeat(40), created_at: '2019-03-04T05:06:07Z' }, 'login'],
    ['login empty', { id: 1, login: '', created_at: '2019-03-04T05:06:07Z' }, 'login'],
    ['created_at not ISO', { id: 1, login: 'alice', created_at: 'yesterday' }, 'created_at'],
    ['created_at missing', { id: 1, login: 'alice' }, 'created_at'],
  ])('%s is a bad response naming the field', async (_label, profile, field) => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client, profile as unknown as FakeProfile)

    const error = await githubErrorOf(() => client.fetchProfile(token))

    expect(error.failure).toBe('bad-response')
    expect(error.message).toContain(field)
  })

  test.each([
    ['error-500', { failure: 'http-status', status: 500 }],
    ['bad-shape', { failure: 'bad-response' }],
    ['oversized', { failure: 'bad-response' }],
    ['not-json', { failure: 'bad-response' }],
  ] as const)('a %s answer is a typed failure', async (behaviour, expected) => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client)
    ctx.fake().setBehaviour('user', behaviour)

    const error = await githubErrorOf(() => client.fetchProfile(token))

    expect(error).toMatchObject(expected)
  })

  test('silence past the timeout is a timeout', async () => {
    const client = ctx.clientFor({ timeoutMs: SHORT_TIMEOUT_MS })
    const token = await ctx.tokenFor(client)
    ctx.fake().setBehaviour('user', 'hang')

    expect((await githubErrorOf(() => client.fetchProfile(token))).failure).toBe('timeout')
  })

  test('a token unfit for a header is refused before any request', async () => {
    const client = ctx.clientFor()

    const error = await githubErrorOf(() => client.fetchProfile('gho_x\r\nHost: evil.test'))

    expect(error.failure).toBe('invalid-token')
    expect(ctx.fake().requests()).toEqual([])
  })
})

describe('revokeToken', () => {
  test('a 500 is a typed failure the caller can log and move past', async () => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client)
    ctx.fake().setBehaviour('revoke', 'error-500')

    expect(await githubErrorOf(() => client.revokeToken(token))).toMatchObject({ failure: 'http-status', status: 500 })
  })

  test('wrong Basic credentials are refused by the fake', async () => {
    const client = ctx.clientFor()
    const token = await ctx.tokenFor(client)
    const other = ctx.clientFor({ clientSecret: 'wrong' })

    expect(await githubErrorOf(() => other.revokeToken(token))).toMatchObject({ failure: 'http-status', status: 401 })
    expect(ctx.fake().revokedTokens()).toEqual([])
  })

  test('silence past the timeout is a timeout', async () => {
    const client = ctx.clientFor({ timeoutMs: SHORT_TIMEOUT_MS })
    const token = await ctx.tokenFor(client)
    ctx.fake().setBehaviour('revoke', 'hang')

    expect((await githubErrorOf(() => client.revokeToken(token))).failure).toBe('timeout')
  })

  test('a token unfit for the body is refused before any request', async () => {
    const client = ctx.clientFor()

    expect((await githubErrorOf(() => client.revokeToken(''))).failure).toBe('invalid-token')
    expect(ctx.fake().requests()).toEqual([])
  })
})

describe('secret hygiene', () => {
  test('neither the token nor the client secret reaches an error, stdout, stderr or the console', async () => {
    const written: string[] = []
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '))
      })
    }
    const client = ctx.clientFor({ timeoutMs: SHORT_TIMEOUT_MS })
    const token = await ctx.tokenFor(client)
    const errors: GithubError[] = []
    const behaviours = ['error-500', 'hang', 'bad-shape', 'oversized', 'not-json'] as const

    for (const behaviour of behaviours) {
      ctx.fake().setBehaviour('user', behaviour)
      ctx.fake().setBehaviour('revoke', behaviour)
      ctx.fake().setBehaviour('token', behaviour)
      errors.push(await githubErrorOf(() => client.fetchProfile(token)))
      errors.push(await githubErrorOf(() => client.revokeToken(token)))
      errors.push(await githubErrorOf(() => client.exchangeCode({ code: 'c', verifier: VERIFIER })))
    }

    const surfaces = [...written, ...errors.flatMap((e) => [e.message, String(e.stack), JSON.stringify(e)])]
    for (const surface of surfaces) {
      expect(surface).not.toContain(token)
      expect(surface).not.toContain(ctx.fake().clientSecret)
      expect(surface).not.toContain('LEAKED_IN_BODY')
      expect(surface).not.toContain(VERIFIER)
    }
    expect(written).toEqual([])
  })
})
