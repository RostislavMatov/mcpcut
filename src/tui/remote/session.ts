import type { TokenAdmin } from '../../cli/admin-token.js'
import type { RemoteClient } from './client.js'

/**
 * The remote console's session seam (ADR-0014, plan wave 2 task 3):
 * `whoami` turned into the SAME `TokenAdmin` shape a local admin store
 * lookup answers with, so `runtime-signin.ts`'s `resolveAdmin`/`signIn`/
 * `isSessionFresh` do not need to know whether they are talking to a store
 * on disk or a server across the network.
 *
 * The three answers of a `whoami` call fold down to exactly the three cases
 * `SessionDeps.resolve` is documented to give: 200 is `ok`, 401 is the same
 * `unknown` a wrong LOCAL token gives (so the sign-in screen shows one
 * sentence for "never existed" and "rotated" here too — `SIGNIN_UNKNOWN_TOKEN
 * _NOTICE` doesn't care which store answered), and everything else —
 * unreachable, a malformed answer, a refusal the client could not place — is
 * `unreadable`, with the client's own already-safe message as the detail. No
 * branch here ever sees or repeats the token itself.
 */
export function createRemoteResolve(client: RemoteClient): (token: string) => Promise<TokenAdmin> {
  return async (token) => {
    const result = await client.whoami(token)
    if (result.ok) return { kind: 'ok', name: result.value.name, role: result.value.role }
    if (result.kind === 'unauthorized') return { kind: 'unknown' }

    return { kind: 'unreadable', detail: result.message }
  }
}
