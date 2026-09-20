import type { FirstOwnerRemoteOutcome } from '../model.js'
import type { RemoteClient } from './client.js'

/**
 * The remote first-owner screen's `POST setup` adapter (ADR-0014, plan wave 2
 * task 5): `client.setup(...)` turned into the three-way outcome
 * `update-first-owner.ts` already knows how to fold — `ok` (with the token
 * `mintedAdminOf` is asked to parse), `closed` (an admin exists now — a race,
 * or a shell won it — the operator belongs on the sign-in screen), or
 * `refused` (`code-refused`/`invalid-name`/`rate-limited`, or anything else
 * the call could not complete as) with the server's own message.
 */
export function createRemoteFirstOwnerSetup(
  client: RemoteClient,
): (code: string, name: string) => Promise<FirstOwnerRemoteOutcome> {
  return async (code, name) => {
    const result = await client.setup({ code, name })
    if (result.ok) {
      return { kind: 'ok', name: result.value.name, token: result.value.token, journaled: result.value.journaled }
    }
    if (result.kind === 'closed') return { kind: 'closed' }

    return { kind: 'refused', message: result.message }
  }
}
