import { SESSION_ID_PATTERN } from '../config.js'

/**
 * Session ids are attacker-influenced input (they can be injected by the
 * caller) and they are turned into file names, so every entry point that
 * builds a journal path validates them here first. The allowed alphabet has
 * no path separators, no dots and no whitespace, which makes traversal
 * (`../`), absolute paths and device names impossible to express.
 */

/** Max characters echoed back in an error message. */
const MAX_ECHOED_CHARS = 64

/** True when `sessionId` is safe to use as a journal file name. */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId)
}

/** Throws a descriptive Error when `sessionId` cannot be used as a file name. */
export function assertValidSessionId(sessionId: string): void {
  if (isValidSessionId(sessionId)) {
    return
  }
  throw new Error(
    `Invalid session id ${describeRejected(sessionId)}: expected 1-128 characters matching [A-Za-z0-9_-]`,
  )
}

/** JSON-escapes and shortens the rejected value so logs cannot be forged. */
function describeRejected(sessionId: string): string {
  const escaped = JSON.stringify(sessionId)
  return escaped.length > MAX_ECHOED_CHARS ? `${escaped.slice(0, MAX_ECHOED_CHARS)}…"` : escaped
}
