import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'

/**
 * Defaults, limits and vocabulary for the named-admin store (`src/admin/*`,
 * M4 Task 9). Kept out of `src/config.ts` per the per-area convention
 * (`src/agents/constants.ts` precedent): admins are a distinct trust domain
 * (a human with a cookie session) from agents (a machine with a Bearer token),
 * so their constants live apart even though the crypto is shared
 * (`src/security/token.ts`).
 */

/** File name of the admins store inside the journal directory. */
export const ADMINS_FILE_NAME = 'admins.json'

/** Default absolute path of the admins store (tests inject their own dir). */
export const ADMINS_FILE_PATH = join(JOURNAL_DIR, ADMINS_FILE_NAME)

/**
 * Prefix of every admin token. Deliberately DIFFERENT from the agent prefix
 * (`mcpj_`): a leaked admin token is a human's session credential, not an
 * agent's Bearer key, and a scanner (or our own redaction) should be able to
 * tell the two domains apart by shape.
 */
export const ADMIN_TOKEN_PREFIX = 'mcpa_'

/** Random entropy per admin token: 32 bytes ≈ 256 bits, base64url-encoded. */
export const ADMIN_TOKEN_RANDOM_BYTES = 32

/** Shape of a stored token hash: the full sha256 hex digest, nothing shorter. */
export const ADMIN_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * Admin names become CLI arguments, journal `adminName` attribution fields and
 * (in the UI) form values, so the format is the same narrow lowercase
 * DNS-label style used for agents and registry servers.
 */
export const ADMIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The three fixed roles (ADR-0004, Decision 3). Ordered here from most to
 * least privileged only for readability; the privilege ordering that matters
 * lives in `src/ui/authz.ts` (`ROLE_RANK`).
 */
export const ADMIN_ROLES = ['owner', 'operator', 'viewer'] as const

/** One of the three fixed admin roles. */
export type AdminRole = (typeof ADMIN_ROLES)[number]

/** True when `value` is exactly one of the three fixed roles. */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}

/** Max admins in one store file (same DoS-bounding rationale as MAX_AGENTS). */
export const MAX_ADMINS = 200
