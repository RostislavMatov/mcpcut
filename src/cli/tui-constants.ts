import { CLI_NAME } from '../setup/constants.js'

/**
 * The sentences the `tui` command and a bare `mcpcut` print when they do NOT
 * open the console (plan phase 2, task 2).
 *
 * Per the per-area convention (`setup-constants.ts` precedent) the words of a
 * command live with the command, not with the area it opens: everything here
 * reaches a shell — stderr, before the alternate screen exists — while
 * `src/tui/constants.ts` holds what only ever appears inside a frame.
 *
 * Both refusals follow the shape the rest of the CLI uses (`setup-
 * constants.ts`, `src/setup/data-dir.ts`): state the fact, name the file or
 * the condition, then the way forward.
 */

/**
 * `tui` outside a terminal. Both streams have to be a TTY — the console reads
 * keys from one and draws frames on the other — and a script that reached this
 * wanted a command, not a screen, so the refusal points back at the commands.
 */
export const TUI_NOT_A_TTY =
  `${CLI_NAME} tui needs an interactive terminal: stdin and stdout must both be a TTY. ` +
  `In a pipe or a script use the commands directly (${CLI_NAME} --help).\n`

/** `tui` takes no arguments; anything after it is a typo for a command. */
export const TUI_NO_ARGUMENTS = 'tui takes no arguments'

/**
 * A wiring fault, not an operator one: `runTui` runs every action through the
 * dispatcher that routed it, which the entry point passes in (the console must
 * not import `cli.ts`, which imports the console — `dispatch-types.ts`). It is
 * a message for whoever wired the call, so it names the option.
 */
export const TUI_NOT_WIRED =
  'runTui: the dispatcher must be injected (opts.dispatch) — the CLI entry point does this'

/** The way back into the console, appended to everything a failed reopen says. */
const REOPEN_ADVICE = `Run: ${CLI_NAME}`

/**
 * The reopen never happened: the child could not be spawned at all (a missing
 * or unreadable build, EACCES, a fork limit). The operator pressed `y` on the
 * one-time token and is back in a shell, so the reason is said out loud —
 * `reason` is the error's own message, never its stack and never a path.
 */
export function reopenFailedNotice(reason: string): string {
  return `could not reopen the console: ${reason}. ${REOPEN_ADVICE}\n`
}

/** The console opened and was then killed; a signal exit reports `code === null`. */
export const REOPEN_SIGNAL_NOTICE = `the console ended on a signal. ${REOPEN_ADVICE}\n`
