/**
 * Suppression of exactly ONE Node warning: the `ExperimentalWarning` that
 * `node:sqlite` prints the moment it is loaded.
 *
 *     (node:1390) ExperimentalWarning: SQLite is an experimental feature …
 *     (Use `node --trace-warnings ...` to show where the warning was created)
 *
 * Two lines on stderr, on every single command — and, because `ui` and `serve`
 * run as daemons whose stderr is their log, two lines at the top of
 * `run/ui.log` and `run/serve.log` as well (user-journey smoke 2026-09-18,
 * UX-7). They say nothing an operator of THIS product can act on: the storage
 * decision was made deliberately and is written down in ADR-0006, which
 * records the warning as a known property of the runtime floor, and the module
 * is loaded by us, not by them.
 *
 * WHY THE LISTENER AND NOT `process.emitWarning`. A builtin ES module is
 * compiled during the LINK phase of the entry's module graph, which is over
 * before the first line of any module body runs — so by the time any code of
 * ours executes, `emitWarning` has already been called and wrapping it is too
 * late. What is not too late is the printing: `emitWarning` defers to
 * `process.nextTick`, and the warning is printed by Node's own `'warning'`
 * listener. Replacing that listener with one that forwards everything except
 * this single message therefore catches both the warning already queued and
 * any emitted later.
 *
 * WHAT IS NOT DONE HERE. `--no-warnings` would mute every warning Node ever
 * emits, including a real deprecation in a future runtime that we would then
 * never see. Node's own printers are kept and called; only one message is
 * dropped, by name.
 */

/** Node's `name`/`type` for the warning class this one belongs to. */
const EXPERIMENTAL_WARNING_TYPE = 'ExperimentalWarning'

/**
 * The subject of the one suppressed warning. Matched on the message rather
 * than on the type alone: another experimental-feature warning (type
 * stripping, a future `node:` module) is news, and must still be printed.
 */
const SQLITE_WARNING_PATTERN = /\bSQLite is an experimental feature\b/

/** One `'warning'` listener — Node's own printer has this shape, and so does ours. */
export type WarningListener = (warning: Error) => void

/** The slice of `process` this module needs; a test double implements the same three. */
export interface WarningHost {
  listeners(event: 'warning'): readonly WarningListener[]
  removeAllListeners(event: 'warning'): unknown
  on(event: 'warning', listener: WarningListener): unknown
}

/** Marks a host whose `'warning'` listeners this module has already replaced. */
const INSTALLED = Symbol.for('mcpcut.warning-filter.installed')

/** The `type` of a warning, from either shape `process.emitWarning` accepts. */
function warningTypeOf(warning: string | Error, options: unknown): string | undefined {
  if (typeof options === 'string') return options
  if (typeof options === 'object' && options !== null && 'type' in options) {
    const type = (options as { readonly type?: unknown }).type
    return typeof type === 'string' ? type : undefined
  }
  return typeof warning === 'string' ? undefined : warning.name
}

/**
 * True only for the `node:sqlite` experimental warning, in any of the shapes
 * it can be seen in: the `Error` a `'warning'` listener receives, or the
 * `(message, type)` / `(message, options)` pair `emitWarning` is called with.
 */
export function isSqliteExperimentalWarning(warning: string | Error, options?: unknown): boolean {
  if (warningTypeOf(warning, options) !== EXPERIMENTAL_WARNING_TYPE) return false
  const message = typeof warning === 'string' ? warning : warning.message
  return SQLITE_WARNING_PATTERN.test(message)
}

/**
 * Replaces the host's `'warning'` listeners with one that drops the warning
 * above and calls every original listener for anything else. Idempotent: a
 * second call is a no-op, so a module loaded twice cannot build a stack of
 * filters (or, worse, capture its own filter as an "original" printer).
 */
export function installWarningFilter(host: WarningHost): void {
  const holder = host as WarningHost & { [INSTALLED]?: true }
  if (holder[INSTALLED] === true) return
  const printers = [...host.listeners('warning')]
  host.removeAllListeners('warning')
  host.on('warning', (warning: Error) => {
    if (isSqliteExperimentalWarning(warning)) return
    for (const printer of printers) printer(warning)
  })
  Object.defineProperty(holder, INSTALLED, { value: true, enumerable: false })
}
