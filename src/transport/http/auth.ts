import type { AgentRecord } from '../../agents/schema.js'

/**
 * Bearer authentication for the downstream HTTP front.
 *
 * The ONLY credential is `Authorization: Bearer <token>`, resolved through
 * `AgentsStore.findAgentByToken` — which already hashes the candidate,
 * compares digests with `timingSafeEqual`, scans every record without an
 * early return, and resolves a revoked agent to `undefined` exactly like a
 * token that never existed. This module adds header parsing and NOTHING
 * else observable: a missing header, a malformed header, an unknown token
 * and a revoked agent all collapse into the same `{ ok: false }` (the
 * server turns that into one byte-identical 401 body), so responses carry
 * no oracle about which agents exist.
 *
 * The token value is never logged, never echoed, and never appears in any
 * error — this module constructs no error messages at all.
 */

/** The store capability auth needs; the full store interface stays out of scope. */
export interface TokenResolver {
  findAgentByToken(token: string): Promise<AgentRecord | undefined>
}

/** Uniform result: either the resolved agent or an undifferentiated refusal. */
export type AuthOutcome = { readonly ok: true; readonly agent: AgentRecord } | { readonly ok: false }

const REFUSED: AuthOutcome = Object.freeze({ ok: false })

/**
 * Extracts the token from an `Authorization` header value. RFC 9110 makes
 * the auth scheme case-insensitive, so `bearer`/`BEARER` are accepted;
 * the shape must be exactly `<scheme> <token>` (one space, non-empty
 * token). Anything else is a refusal, indistinguishable from a bad token.
 */
function tokenOf(headerValue: string): string | null {
  const separator = headerValue.indexOf(' ')
  if (separator === -1) {
    return null
  }
  const scheme = headerValue.slice(0, separator)
  const token = headerValue.slice(separator + 1)
  if (scheme.toLowerCase() !== 'bearer' || token === '' || token.includes(' ')) {
    return null
  }
  return token
}

/**
 * Resolves the request's `Authorization` header to an agent. Every failure
 * mode returns the same frozen `{ ok: false }` value.
 */
export async function authenticate(
  authorizationHeader: string | undefined,
  agentsStore: TokenResolver,
): Promise<AuthOutcome> {
  if (authorizationHeader === undefined) {
    return REFUSED
  }
  const token = tokenOf(authorizationHeader)
  if (token === null) {
    return REFUSED
  }
  const agent = await agentsStore.findAgentByToken(token)
  if (agent === undefined) {
    return REFUSED
  }
  return { ok: true, agent }
}
