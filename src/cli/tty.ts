import type { TuiTerminal } from '../tui/runtime.js'

/**
 * The terminal question, and nothing else (mcpcut phase 3, task 8).
 *
 * A leaf on purpose: `tui-cmd.ts`, the dispatcher and the first-run wizard all
 * have to ask whether there is a terminal to draw on, and they must be able to
 * ask without importing each other. So this module imports one type and holds
 * one answer.
 */

/** The terminal a console opens on when the caller names none. */
export function defaultTerminal(): TuiTerminal {
  return { input: process.stdin, output: process.stdout }
}

/**
 * Whether a console can be drawn at all: both halves have to be a terminal,
 * since the console reads keys from one and paints frames on the other.
 *
 * Exported because the dispatcher asks the same question about a bare
 * invocation — in a pipe or a script that is a request for the usage, not for
 * a screen — and both answers must come from one place.
 */
export function isInteractiveTerminal(
  opts: { readonly isTty?: boolean; readonly terminal?: TuiTerminal } = {},
): boolean {
  if (opts.isTty !== undefined) return opts.isTty
  const terminal = opts.terminal ?? defaultTerminal()
  return terminal.input.isTTY === true && terminal.output.isTTY === true
}
