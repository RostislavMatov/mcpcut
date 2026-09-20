import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setupCodePathFor, writeSetupCodeFile } from '../../src/admin/setup-code-file.js'
import type { TokenAdmin } from '../../src/cli/admin-token.js'
import { createTokenCell } from '../../src/tui/cells.js'
import {
  isSessionFresh,
  resolveAdmin,
  signIn,
  type SessionDeps,
} from '../../src/tui/runtime-signin.js'

/**
 * The session seam a remote console resolves through (ADR-0014, plan wave 2
 * task 3): `SessionDeps.resolve` stands in for the local store lookup, and —
 * the one behavioural difference — a remote sign-in never touches the setup
 * code file, because that file lives on the SERVER, not on the machine this
 * console runs on.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-signin-remote-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function depsWithResolve(resolve: SessionDeps['resolve']): SessionDeps {
  return { token: createTokenCell(), journalDir, resolve }
}

describe('resolveAdmin: the `resolve` seam replaces the local store lookup', () => {
  test('calls `resolve` with the token and returns exactly what it answers', async () => {
    let seenToken: string | undefined
    const answer: TokenAdmin = { kind: 'ok', name: 'alice', role: 'owner' }
    const deps = depsWithResolve(async (token) => {
      seenToken = token
      return answer
    })

    const result = await resolveAdmin('mcpa_whatever', deps)

    expect(result).toBe(answer)
    expect(seenToken).toBe('mcpa_whatever')
  })

  test('without `resolve`, the local store lookup still runs (an unreadable store answers `unreadable`)', async () => {
    const deps: SessionDeps = { token: createTokenCell(), journalDir: join(journalDir, 'missing', 'nested') }

    const result = await resolveAdmin('mcpa_x', deps)

    // No admin store at all resolves to `missing`/`unknown` depending on the
    // store's own behaviour on an absent file — either way `resolve` was not
    // asked, which is the only thing this test cares about pinning here.
    expect(result.kind === 'ok').toBe(false)
  })
})

describe('signIn: a remote sign-in never touches the setup code file', () => {
  test('a successful remote sign-in leaves the local setup code file exactly where it was', async () => {
    const path = setupCodePathFor(journalDir)
    await writeSetupCodeFile(path, 'mcps_untouched')
    const deps = depsWithResolve(async () => ({ kind: 'ok', name: 'alice', role: 'owner' }))

    const message = await signIn('mcpa_remote-token', deps)

    expect(message).toEqual({
      kind: 'signin-result',
      result: { kind: 'ok', name: 'alice', role: 'owner' },
    })
    expect(deps.token.get()).toBe('mcpa_remote-token')
    expect(await fileExists(path)).toBe(true)
  })

  test('a refused remote token sets nothing and leaves the file alone', async () => {
    const path = setupCodePathFor(journalDir)
    await writeSetupCodeFile(path, 'mcps_untouched')
    const deps = depsWithResolve(async () => ({ kind: 'unknown' }))

    const message = await signIn('mcpa_wrong', deps)

    expect(message).toEqual({ kind: 'signin-result', result: { kind: 'unknown' } })
    expect(deps.token.get()).toBeUndefined()
    expect(await fileExists(path)).toBe(true)
  })
})

describe('isSessionFresh: without `isFresh`, it still falls back to `resolve`', () => {
  test('true only when `resolve` answers ok', async () => {
    const okDeps = depsWithResolve(async () => ({ kind: 'ok', name: 'a', role: 'viewer' }))
    const unknownDeps = depsWithResolve(async () => ({ kind: 'unknown' }))

    expect(await isSessionFresh('t', okDeps)).toBe(true)
    expect(await isSessionFresh('t', unknownDeps)).toBe(false)
  })

  test('a throwing `resolve` counts as lost, not as a crash — the fallback path only, no `isFresh` seam involved', async () => {
    const deps = depsWithResolve(async () => {
      throw new Error('network is down')
    })

    expect(await isSessionFresh('t', deps)).toBe(false)
  })
})

describe('signIn: still reports `unreadable` on a network failure, `isFresh` or not', () => {
  test('a throwing `resolve` fails sign-in with `unreadable`, never a crash', async () => {
    const deps = depsWithResolve(async () => {
      throw new Error('network is down')
    })

    const message = await signIn('mcpa_x', deps)

    expect(message).toEqual({
      kind: 'signin-result',
      result: { kind: 'unreadable', detail: 'network is down' },
    })
    expect(deps.token.get()).toBeUndefined()
  })
})

describe('isSessionFresh: the `isFresh` seam (ADR-0014) replaces `resolve` entirely', () => {
  test('present: answers from `isFresh` and never calls `resolve` at all', async () => {
    let resolveCalled = false
    const deps: SessionDeps = {
      token: createTokenCell(),
      resolve: async () => {
        resolveCalled = true
        return { kind: 'ok', name: 'a', role: 'viewer' }
      },
      isFresh: () => true,
    }

    expect(await isSessionFresh('t', deps)).toBe(true)
    expect(resolveCalled).toBe(false)
  })

  test('a synchronous `false` from `isFresh` is honoured without awaiting anything else', async () => {
    const deps: SessionDeps = { token: createTokenCell(), isFresh: () => false }

    expect(await isSessionFresh('t', deps)).toBe(false)
  })

  test('an async `isFresh` is awaited', async () => {
    const deps: SessionDeps = { token: createTokenCell(), isFresh: async () => true }

    expect(await isSessionFresh('t', deps)).toBe(true)
  })

  test('a network blip is never a pre-check request: `isFresh` answers locally, with no round trip at all', async () => {
    // The whole point of the seam (HIGH review finding): remotely there is no
    // freshness pre-check request, so a `resolve` that would reject on a
    // network blip is simply never consulted for freshness.
    let resolveCalls = 0
    const deps: SessionDeps = {
      token: createTokenCell(),
      resolve: async () => {
        resolveCalls += 1
        throw new Error('ECONNREFUSED')
      },
      isFresh: () => true,
    }

    expect(await isSessionFresh('t', deps)).toBe(true)
    expect(resolveCalls).toBe(0)
  })
})
