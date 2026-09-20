import { describe, expect, test } from 'vitest'
import type { RemoteClient } from '../../../src/tui/remote/client.js'
import { createRemoteResolve } from '../../../src/tui/remote/session.js'

/**
 * The session seam a remote console resolves through (ADR-0014, plan wave 2
 * task 3): `whoami` turned into the `TokenAdmin` shape `runtime-signin.ts`
 * already knows how to fold.
 */

function clientAnswering(whoami: RemoteClient['whoami']): RemoteClient {
  return {
    state: () => Promise.resolve({ ok: true, value: { api: 1, firstRun: false } }),
    whoami,
    setup: () => Promise.resolve({ ok: true, value: { name: 'a', token: 't', journaled: true } }),
    run: () => Promise.resolve(0),
  }
}

describe('createRemoteResolve', () => {
  test('200 resolves ok, with the name and role whoami answered', async () => {
    const resolve = createRemoteResolve(
      clientAnswering(() => Promise.resolve({ ok: true, value: { name: 'alice', role: 'owner' } })),
    )

    expect(await resolve('mcpa_whatever')).toEqual({ kind: 'ok', name: 'alice', role: 'owner' })
  })

  test('401 answers the same "unknown" shape a wrong local token gives', async () => {
    const resolve = createRemoteResolve(
      clientAnswering(() => Promise.resolve({ ok: false, kind: 'unauthorized', message: 'nope' })),
    )

    expect(await resolve('mcpa_wrong')).toEqual({ kind: 'unknown' })
  })

  test('anything else is `unreadable`, with a safe detail — never the token', async () => {
    const resolve = createRemoteResolve(
      clientAnswering(() => Promise.resolve({ ok: false, kind: 'network', message: 'could not reach the remote console' })),
    )

    const result = await resolve('mcpa_sentinel-token')
    expect(result).toEqual({ kind: 'unreadable', detail: 'could not reach the remote console' })
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
  })

  test('passes the token to whoami exactly once', async () => {
    let seen: string | undefined
    const resolve = createRemoteResolve(
      clientAnswering((token) => {
        seen = token
        return Promise.resolve({ ok: true, value: { name: 'a', role: 'viewer' } })
      }),
    )

    await resolve('mcpa_the-token')

    expect(seen).toBe('mcpa_the-token')
  })
})
