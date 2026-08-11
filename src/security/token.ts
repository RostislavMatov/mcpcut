import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Shared token machinery: mint a prefixed high-entropy token, persist only
 * its sha256 hash, verify in constant time. Extracted from
 * `src/agents/tokens.ts` (M4 Wave 0) so the admin module reuses the same
 * crypto instead of duplicating it; `agents/tokens.ts` re-exports from here,
 * binding its own prefix and length, so existing imports are untouched.
 *
 * The plaintext token exists exactly once — in the return value of
 * `generateToken()`, printed once by the CLI — and everything persisted or
 * compared afterwards is its sha256 hash, so a stolen store file yields no
 * usable credentials.
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

/**
 * Mints a new token — `prefix` followed by `randomByteCount` CSPRNG bytes as
 * base64url — and its hash. The caller owns both parameters (agent and admin
 * tokens each bind their own), so a leaked token's prefix identifies which
 * store it opens, the same way `ghp_`/`sk-` prefixes do.
 */
export function generateToken(prefix: string, randomByteCount: number): GeneratedToken {
  const token = `${prefix}${randomBytes(randomByteCount).toString('base64url')}`
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
