import { generateToken as mintToken, type GeneratedToken } from '../security/token.js'
import { AGENT_TOKEN_PREFIX, TOKEN_RANDOM_BYTES } from './constants.js'

/**
 * Agent token generation and verification: the shared machinery of
 * `src/security/token.ts` bound to the agent prefix and length. Kept as a
 * module (re-exports plus one binding) so existing imports — `agents/store.ts`
 * and the tests — were untouched by the M4 extraction.
 */

export { hashToken, verifyToken } from '../security/token.js'
export type { GeneratedToken } from '../security/token.js'

/** Mints a new `mcpj_`-prefixed token (32 random bytes, base64url) and its hash. */
export function generateToken(): GeneratedToken {
  return mintToken(AGENT_TOKEN_PREFIX, TOKEN_RANDOM_BYTES)
}
