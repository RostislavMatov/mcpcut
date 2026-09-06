import { ansiStyle, type Style } from '../tui/ansi.js'
import { DEFAULT_TUI_SIGNALS, ESCAPE_CODE_TIMEOUT_MS } from '../tui/constants.js'
import { createTokenCell } from '../tui/runtime-effects.js'
import { runConsole, type TuiTerminal } from '../tui/runtime.js'
import { describeDataDirProblem, resolveDataDir } from '../setup/data-dir.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'
import type { DispatchFn, DispatchOptions } from './dispatch-types.js'
import { TUI_USAGE } from './operator-usage.js'
import { bareNoConfigHint, TUI_NOT_A_TTY, TUI_NOT_WIRED, TUI_NO_ARGUMENTS } from './tui-constants.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * `mcpcut tui`, and the bare `mcpcut` that opens the same console (phase 2,
 * task 14).
 *
 * Everything here happens BEFORE a frame exists: this module decides whether
 * a console opens at all, and assembles what it runs on. The console itself
 * (`src/tui/**`) never asks about argv, a TTY or an install config — it is
 * handed a terminal and a dispatcher and draws.
 *
 * The gates run in the order an operator meets them. `--help` answers before
 * anything else, because a question about the command is not a request to
 * open it. Arguments are refused next: `tui` takes none, so `mcpcut tui add`
 * is a typo for a command and deserves the usage rather than a screen that
 * ignored half of what was typed. Then the terminal, then the install config
 * — a console over a directory the operator did not configure is worse than a
 * refusal that names the file.
 *
 * The two entry points differ in exactly one place. A bare `mcpcut` with no
 * config is a first run, and until the wizard exists (a later phase) it is
 * sent to `setup`; an explicit `mcpcut tui` is a deliberate request and opens
 * over the default data directory, which is what an install that inherited a
 * journal without ever running `setup` has always used.
 *
 * The io shape is `UiCliIo` — declared structurally, like every other command
 * module, so nothing here imports the dispatcher that routes it. The
 * dispatcher arrives as a value instead (`opts.dispatch`), which is what the
 * console runs every action through.
 */

export type TuiEntry = 'bare' | 'explicit'

/** Test seams: every process-, environment- and terminal-dependent input. */
export interface TuiCommandOptions {
  /**
   * The dispatcher the console runs its actions through. Injected by the CLI
   * entry point; the console must not import it (`dispatch-types.ts`).
   */
  readonly dispatch?: DispatchFn
  /** Per-command seams handed to each dispatched command. Defaults to none. */
  readonly dispatchOptions?: DispatchOptions
  /** Environment commands inherit, before the session token joins it. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Journal directory holding the admin store; defaults to the process-wide one. */
  readonly journalDir?: string
  /** Install config to judge; without it the file is read here, after the dispatcher's own gate already read it. */
  readonly install?: InstallConfigLoad
  /** Overrides the TTY judgement; the default asks the terminal itself. */
  readonly isTty?: boolean
  /** Streams the console reads keys from and draws on. Defaults to the process ones. */
  readonly terminal?: TuiTerminal
  readonly style?: Style
  /** Where signal and crash listeners go. Defaults to `process`. */
  readonly processEvents?: NodeJS.EventEmitter
  readonly signals?: readonly NodeJS.Signals[]
  readonly escapeCodeTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  /** Which invocation asked for the console; only the missing-config path differs. */
  readonly entry?: TuiEntry
}

/** The terminal a console opens on when the caller names none. */
function defaultTerminal(): TuiTerminal {
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
  opts: Pick<TuiCommandOptions, 'isTty' | 'terminal'> = {},
): boolean {
  if (opts.isTty !== undefined) return opts.isTty
  const terminal = opts.terminal ?? defaultTerminal()
  return terminal.input.isTTY === true && terminal.output.isTTY === true
}

export async function runTui(
  args: readonly string[],
  io: UiCliIo,
  opts: TuiCommandOptions = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(TUI_USAGE)
    return 0
  }
  if (args.length > 0) {
    io.stderr.write(`${TUI_NO_ARGUMENTS}\n\n${TUI_USAGE}`)
    return 1
  }
  if (!isInteractiveTerminal(opts)) {
    io.stderr.write(TUI_NOT_A_TTY)
    return 1
  }

  const env = opts.env ?? process.env
  const install = opts.install ?? loadInstallConfigSync({ env })

  // Belt and braces: the dispatcher gates a broken config ahead of this
  // command, so this is the path a caller that skipped it would take. The
  // words are the dispatcher's own, from the one function that writes them.
  const configProblem = describeDataDirProblem(resolveDataDir({ env, load: install }))
  if (configProblem !== undefined) {
    io.stderr.write(configProblem)
    return 1
  }

  if (opts.entry === 'bare' && install.kind === 'absent') {
    io.stderr.write(bareNoConfigHint(install.path))
    return 1
  }

  const dispatch = opts.dispatch
  // A wiring fault, not an operator one, so it throws rather than printing:
  // there is no exit code that would make an un-wired console meaningful.
  if (dispatch === undefined) throw new Error(TUI_NOT_WIRED)

  return await runConsole({
    terminal: opts.terminal ?? defaultTerminal(),
    style: opts.style ?? ansiStyle,
    stderr: io.stderr,
    effects: {
      dispatch,
      dispatchOptions: dispatchOptionsFor(opts),
      env,
      ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
      token: createTokenCell(),
    },
    processEvents: opts.processEvents ?? process,
    signals: opts.signals ?? DEFAULT_TUI_SIGNALS,
    escapeCodeTimeoutMs: opts.escapeCodeTimeoutMs ?? ESCAPE_CODE_TIMEOUT_MS,
    platform: opts.platform ?? process.platform,
  })
}

/**
 * The session's freshness check and the `admin` commands must read ONE store:
 * a `journalDir` given to the console is handed to the `admin` seam too,
 * unless the caller already pointed that seam somewhere on purpose.
 */
export function dispatchOptionsFor(opts: TuiCommandOptions): DispatchOptions {
  const base = opts.dispatchOptions ?? {}
  if (opts.journalDir === undefined || base.admin?.journalDir !== undefined) return base
  return { ...base, admin: { ...base.admin, journalDir: opts.journalDir } }
}
