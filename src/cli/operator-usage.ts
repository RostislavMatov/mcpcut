import { LOG_TAIL_DEFAULT_LINES } from '../services/constants.js'
import { CLI_NAME, SUPERVISORS } from '../setup/constants.js'

/**
 * The synopsis of the operator commands — `mcpcut setup` and
 * `mcpcut start|stop|status|logs` — written once (phase-1 follow-up).
 *
 * Each of these commands is described in two places on the surface of the
 * CLI: the global `--help` table (`./usage.ts`), and the usage a refusal from
 * the command itself prints. They used to be two hand-written texts, and they
 * had already drifted — the global table knew where the pid and log files
 * live, the local one knew the `--lines` default, and an operator who read
 * either one was missing whatever the other knew. The lines below are the one
 * source: `usage.ts` splices them into its table, the commands print them
 * under a `Usage:` header, and `tests/cli/usage.test.ts` fails the moment the
 * two stop being the same text.
 *
 * A LEAF on purpose. It imports the two constant modules that own the words it
 * quotes (the command name, the supervisor list, the log-tail default) and
 * nothing else — in particular never `./usage.ts`, which imports THIS module:
 * that cycle would leave one of the two texts `undefined` at module-evaluation
 * time, in a build where nothing else fails and no test but this one looks.
 */

/**
 * Column the description half of every row starts in.
 *
 * The block is a table, and a continuation row that misses the column shifts
 * the eye off it. Exported so the guard can check the whole of `USAGE` against
 * it rather than trusting spaces counted by hand.
 */
export const USAGE_DESCRIPTION_COLUMN = 41

/**
 * Left margin of every row of the table. Exported for the same reason as the
 * column above: a guard that reads the table back (the console's catalogue
 * parity test) has to know where a row starts without counting spaces.
 */
export const ROW_INDENT = '  '

/** Indent of a description that stands on its own line, with no command beside it. */
const DESCRIPTION_INDENT = ' '.repeat(USAGE_DESCRIPTION_COLUMN)

/**
 * Indent of a flag list that wraps onto its own line: under the first flag of
 * the row it continues, so the eye reads one flag list and not two commands.
 * Derived rather than typed out, so renaming the binary cannot leave it stale.
 */
const FLAG_CONTINUATION_INDENT = ' '.repeat(ROW_INDENT.length + `${CLI_NAME} setup `.length)

/**
 * `mcpcut setup`. Two rows, because the command is two commands: on a terminal
 * without `--yes` it is the interactive setup, and with `--yes` it is the
 * non-interactive run the wizard itself performs. The `--behind-tls` note
 * earns its line: the flag is written into the config and therefore survives a
 * rerun that does not mention it, so the flag that takes it back has to be
 * named where the flags are read.
 */
export const SETUP_SYNOPSIS_LINES: readonly string[] = [
  `${ROW_INDENT}${`${CLI_NAME} setup`.padEnd(USAGE_DESCRIPTION_COLUMN - ROW_INDENT.length)}Interactive setup on a terminal: the same questions as the flags below`,
  `${ROW_INDENT}${CLI_NAME} setup --yes [--data-dir <dir>] [--ui-host H] [--ui-port N] [--serve-host H] [--serve-port N]`,
  `${FLAG_CONTINUATION_INDENT}[--behind-tls|--no-behind-tls] [--admin <name>|--no-admin] [--supervisor ${SUPERVISORS.join('|')}]`,
  `${FLAG_CONTINUATION_INDENT}[--ui-probe-host H] [--serve-probe-host H] [--start] [--force]`,
  `${DESCRIPTION_INDENT}Write the install config, prepare the data directory, run the`,
  `${DESCRIPTION_INDENT}checks and mint the first owner`,
  `${DESCRIPTION_INDENT}--behind-tls is remembered across reruns; --no-behind-tls takes it back`,
  `${DESCRIPTION_INDENT}--*-probe-host: where status dials a service it has no pid file for`,
  `${DESCRIPTION_INDENT}--force, --no-admin and --start apply to --yes only`,
]

/**
 * `mcpcut start|stop|status|logs`. Where the two old copies disagreed, the
 * more precise wording won: the pid/log location from the global table, the
 * `--lines` default from the command's own usage.
 */
export const SERVICE_SYNOPSIS_LINES: readonly string[] = [
  `${ROW_INDENT}${CLI_NAME} start|stop [ui|serve]           Start/stop the services as detached daemons (pid + log in <data dir>/run)`,
  `${ROW_INDENT}${CLI_NAME} status [--json]                 Show whether each service runs (pid alive AND answering)`,
  `${ROW_INDENT}${CLI_NAME} logs <ui|serve> [--lines N]     Print the tail of a service log (default ${LOG_TAIL_DEFAULT_LINES} lines)`,
]

/**
 * `mcpcut tui`. The row has to say what a BARE `mcpcut` does as well: that is
 * the invocation most operators will type, it does two different things
 * depending on whether stdout is a terminal, and there is no other row in the
 * table where a reader would look for it.
 */
export const TUI_SYNOPSIS_LINES: readonly string[] = [
  `${ROW_INDENT}${`${CLI_NAME} tui`.padEnd(USAGE_DESCRIPTION_COLUMN - ROW_INDENT.length)}Open the interactive console (a bare "${CLI_NAME}" on a terminal does the same;`,
  `${DESCRIPTION_INDENT}in a pipe a bare "${CLI_NAME}" prints this help)`,
]

/** One command's own usage: its synopsis under a header, and nothing else. */
function usageOf(lines: readonly string[]): string {
  return `Usage:\n${lines.join('\n')}\n`
}

/** What `setup` prints when it refuses, and what `--help` shows for it. */
export const SETUP_USAGE = usageOf(SETUP_SYNOPSIS_LINES)

/** What `start`/`stop`/`status`/`logs` print when they refuse. */
export const SERVICE_USAGE = usageOf(SERVICE_SYNOPSIS_LINES)

/** What `tui` prints when it refuses (no terminal, or arguments it has no use for). */
export const TUI_USAGE = usageOf(TUI_SYNOPSIS_LINES)
