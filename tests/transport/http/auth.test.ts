import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgentsStore, type AgentsStore } from '../../../src/agents/store.js'
import { authenticate } from '../../../src/transport/http/auth.js'

/**
 * Unit + hardening tests for Bearer authentication (M3 Task 10). Runs
 * against a REAL agents store in a temp dir so revocation and token-hash
 * behavior are the production code paths, not mocks.
 */

let journalDir: string
let store: AgentsStore
let validToken: string

beforeEach(async () => {
  journalDir = mkdtempSync(join(tmpdir(), 'http-auth-test-'))
  store = createAgentsStore({ journalDir })
  const created = await store.createAgent('bot')
  validToken = created.token
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

describe('authenticate: success paths', () => {
  test('resolves a valid Bearer token to its agent', async () => {
    const outcome = await authenticate(`Bearer ${validToken}`, store)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.agent.name).toBe('bot')
    }
  })

  test.each(['bearer', 'BEARER', 'BeArEr'])(
    'accepts the auth scheme case-insensitively (%s)',
    async (scheme) => {
      const outcome = await authenticate(`${scheme} ${validToken}`, store)

      expect(outcome.ok).toBe(true)
    },
  )

  test('resolves the right agent when several exist', async () => {
    const other = await store.createAgent('other-bot')

    const outcome = await authenticate(`Bearer ${other.token}`, store)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.agent.name).toBe('other-bot')
    }
  })
})

describe('authenticate: every failure is the same undifferentiated refusal', () => {
  test('missing header refuses', async () => {
    expect(await authenticate(undefined, store)).toEqual({ ok: false })
  })

  test.each([
    ['no scheme separator', 'garbage'],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['empty token', 'Bearer '],
    ['token with a space', 'Bearer abc def'],
    ['scheme only with trailing spaces', 'Bearer   '],
    ['empty header value', ''],
  ])('malformed header (%s) refuses', async (_name, header) => {
    expect(await authenticate(header, store)).toEqual({ ok: false })
  })

  test('an unknown token refuses', async () => {
    expect(await authenticate('Bearer mcpj_definitely-not-a-real-token', store)).toEqual({
      ok: false,
    })
  })

  test('a revoked agent token refuses exactly like an unknown one', async () => {
    await store.revokeAgent('bot')

    const revoked = await authenticate(`Bearer ${validToken}`, store)
    const unknown = await authenticate('Bearer mcpj_never-existed', store)

    expect(revoked).toEqual(unknown)
    expect(revoked).toEqual({ ok: false })
  })

  test('all refusal shapes are indistinguishable from each other', async () => {
    const outcomes = await Promise.all([
      authenticate(undefined, store),
      authenticate('garbage', store),
      authenticate('Bearer mcpj_wrong', store),
    ])

    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false })
      expect(Object.keys(outcome)).toEqual(['ok'])
    }
  })

  test('the refusal never carries the token or an error message', async () => {
    const outcome = await authenticate('Bearer super-secret-token-value', store)

    expect(JSON.stringify(outcome)).not.toContain('super-secret-token-value')
    expect(JSON.stringify(outcome)).toBe('{"ok":false}')
  })
})
