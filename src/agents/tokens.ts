import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AGENT_TOKEN_PREFIX, TOKEN_RANDOM_BYTES } from './constants.js'

/**
 * Agent token generation and verification. The plaintext token exists exactly
 * once — in the return value of `generateToken()`, printed once by the CLI —
 * and everything persisted or compared afterwards is its sha256 hash, so a
 * stolen `agents.json` yields no usable credentials.
 */

/** A freshly minted token plus the only thing that may be persisted: its hash. */
export interface GeneratedToken {
  /** Plaintext, shown to the operator exactly once. Never persisted. */
  readonly token: string
  /** sha256 hex digest of the full token (prefix included). */
  readonly hash: string
}

/** sha256 hex digest of a candidate token. Deterministic, fixed 64-char output. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Mints a new `mcpj_`-prefixed token (32 random bytes, base64url) and its hash. */
export function generateToken(): GeneratedToken {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`
  return { token, hash: hashToken(token) }
}

/**
 * Verifies `token` against a stored sha256 hex `hash` in constant time.
 *
 * The comparison is `timingSafeEqual` over the two DIGESTS (always 32 bytes
 * for the candidate side), never over plaintext of attacker-controlled
 * length. A stored hash that is not exactly 64 valid hex chars (corrupt or
 * hand-edited file) decodes to a buffer of a different length —
 * `Buffer.from(..., 'hex')` silently truncates at the first invalid pair —
 * and is rejected as a plain `false`, never an exception.
 */
export function verifyToken(token: string, hash: string): boolean {
  const candidateDigest = Buffer.from(hashToken(token), 'hex')
  const storedDigest = Buffer.from(hash, 'hex')
  if (storedDigest.length !== candidateDigest.length) return false
  return timingSafeEqual(candidateDigest, storedDigest)
}
