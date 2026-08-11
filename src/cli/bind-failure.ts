/**
 * Shared bind-failure formatting for the plane's two listening entry points
 * (`serve-cmd.ts`, `ui-cmd.ts`). A refused bind is an operator's problem, not
 * a stack trace: name the target and the reason. The two entry points must
 * fail the same way for the same reason, so the message is built here once.
 */

/**
 * Describes a failed `listen()` call as a single stderr line ending in `\n`.
 *
 * @param prefix command name the message is attributed to (e.g. `serve`, `ui`)
 * @param target the `host:port` the process tried to bind
 * @param error the value `listen()`'s `error` event (or a thrown rejection) carried
 */
export function describeBindFailure(prefix: string, target: string, error: unknown): string {
  // Honest narrowing rather than a cast: a thrown value is `unknown`, and an
  // `errno` code is only trustworthy when it is really there and really a string.
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (code === 'EADDRINUSE') {
    return `${prefix}: cannot bind ${target}: address already in use\n`
  }
  if (code === 'EACCES') {
    return `${prefix}: cannot bind ${target}: permission denied (ports below 1024 need privileges)\n`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `${prefix}: cannot bind ${target}: ${message}\n`
}
