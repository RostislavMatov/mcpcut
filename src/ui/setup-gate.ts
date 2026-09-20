import { SETUP_CODE_PREFIX, SETUP_CODE_RANDOM_BYTES } from '../admin/constants.js'
import { generateToken, verifyToken } from '../security/token.js'

/**
 * The first-run gate (ADR-0004, amendment of 2026-09-19): whether `/setup` —
 * the one page that creates an admin for a caller who holds no credential —
 * exists right now, and the only holder of the one-time setup code.
 *
 * Open means all three at once: the composition root ARMED the gate (it found
 * no admin at start and wrote the code to the host), nobody has closed it,
 * and the store still holds no active admin. The last is asked live, because
 * `mcpcut admin add` in a shell may create the first owner while the page
 * sits open in a browser; once an admin is seen the gate closes for the life
 * of the process — the store refuses to lose its last owner, so "no admins"
 * cannot come back short of a wiped database, and a wiped database is a
 * restart. A closed gate reads nothing, so an install past its first run pays
 * nothing for this module.
 *
 * Only the code's sha256 lives here, compared in constant time through the
 * shared token machinery. The plaintext leaves `arm()` once, for the file.
 */
export interface SetupGate {
  /** Mints a fresh code (replacing any earlier one) and returns the plaintext, once. */
  arm(): string
  /** True while the first-run page should be served. */
  isOpen(): Promise<boolean>
  /** Constant-time check of a submitted code; always false on a gate that is not armed. */
  verify(code: string): boolean
  /** Ends the first run for this process. Idempotent. */
  close(): void
}

export interface SetupGateDeps {
  /** True when the store holds at least one active admin. */
  readonly hasAdmins: () => Promise<boolean>
  /**
   * Told when `hasAdmins` rejects. The gate then answers "not open" for that
   * request WITHOUT closing: a store that cannot be read must not be offered
   * a new owner beside records nobody could parse (the rule `prepareFirstRun`
   * applies at start), and must not take every page down with a 500 either —
   * the sign-in screen is the answer that stays true once the store is fixed.
   */
  readonly onReadError?: (error: unknown) => void
}

export function createSetupGate(deps: SetupGateDeps): SetupGate {
  let codeHash: string | undefined
  let closed = false

  function close(): void {
    closed = true
    codeHash = undefined
  }

  return Object.freeze({
    arm(): string {
      if (closed) throw new Error('setup gate: closed gates are not re-armed')
      const { token, hash } = generateToken(SETUP_CODE_PREFIX, SETUP_CODE_RANDOM_BYTES)
      codeHash = hash
      return token
    },
    async isOpen(): Promise<boolean> {
      if (closed || codeHash === undefined) return false
      let hasAdmins: boolean
      try {
        hasAdmins = await deps.hasAdmins()
      } catch (error: unknown) {
        deps.onReadError?.(error)
        return false
      }
      if (hasAdmins) close()
      return !hasAdmins
    },
    verify(code: string): boolean {
      if (closed || codeHash === undefined) return false
      // A code copied out of a terminal arrives with its newline; the code
      // itself is base64url and never contains whitespace.
      return verifyToken(code.trim(), codeHash)
    },
    close,
  })
}
