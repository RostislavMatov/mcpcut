import { describe, expect, test } from 'vitest'
import type { RemoteClient } from '../../../src/tui/remote/client.js'
import { createRemoteFirstOwnerSetup } from '../../../src/tui/remote/setup.js'

/**
 * The first-owner screen's remote `POST setup` adapter (ADR-0014, plan wave 2
 * task 5): `client.setup(...)` turned into `FirstOwnerRemoteOutcome`.
 */

function clientAnswering(setup: RemoteClient['setup']): RemoteClient {
  return {
    state: () => Promise.resolve({ ok: true, value: { api: 1, firstRun: true } }),
    whoami: () => Promise.resolve({ ok: true, value: { name: 'a', role: 'owner' } }),
    setup,
    run: () => Promise.resolve(0),
  }
}

describe('createRemoteFirstOwnerSetup', () => {
  test('sends the code and name, and answers ok with the minted token', async () => {
    let seen: { code: string; name: string } | undefined
    const run = createRemoteFirstOwnerSetup(
      clientAnswering((request) => {
        seen = request
        return Promise.resolve({ ok: true, value: { name: 'alice', token: 'mcpa_new', journaled: true } })
      }),
    )

    const result = await run('mcps_abc', 'alice')

    expect(result).toEqual({ kind: 'ok', name: 'alice', token: 'mcpa_new', journaled: true })
    expect(seen).toEqual({ code: 'mcps_abc', name: 'alice' })
  })

  test('journaled: false rides through unchanged, for the screen to warn about', async () => {
    const run = createRemoteFirstOwnerSetup(
      clientAnswering(() => Promise.resolve({ ok: true, value: { name: 'alice', token: 't', journaled: false } })),
    )

    expect(await run('mcps_abc', 'alice')).toEqual({ kind: 'ok', name: 'alice', token: 't', journaled: false })
  })

  test('"closed" is its own outcome — the operator belongs on the sign-in screen', async () => {
    const run = createRemoteFirstOwnerSetup(
      clientAnswering(() => Promise.resolve({ ok: false, kind: 'closed', message: 'an admin exists now' })),
    )

    expect(await run('mcps_abc', 'alice')).toEqual({ kind: 'closed' })
  })

  test.each(['code-refused', 'invalid-name', 'rate-limited', 'bad-request', 'network'] as const)(
    '%s keeps the server message for the form',
    async (kind) => {
      const run = createRemoteFirstOwnerSetup(
        clientAnswering(() => Promise.resolve({ ok: false, kind, message: `${kind}: try again` })),
      )

      expect(await run('mcps_abc', 'alice')).toEqual({ kind: 'refused', message: `${kind}: try again` })
    },
  )
})
