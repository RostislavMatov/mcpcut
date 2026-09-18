import { homedir } from 'node:os'
import { bootstrapTokenPathFor, hasBootstrapTokenFile } from '../admin/bootstrap-file.js'
import { JOURNAL_DIR } from '../config.js'
import { styleFor, type Style } from '../tui/ansi.js'
import { DEFAULT_TUI_SIGNALS, ESCAPE_CODE_TIMEOUT_MS, EXIT_OK } from '../tui/constants.js'
import { initialModel, installFactsOf, type SigninHostFacts } from '../tui/model.js'
import { createReopenCell, createTokenCell, type ReopenCell } from '../tui/runtime-effects.js'
import { runConsole, type ConsoleDeps, type TuiTerminal } from '../tui/runtime.js'
import { describeDataDirProblem, resolveDataDir } from '../setup/data-dir.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'
import type { DispatchFn, DispatchOptions } from './dispatch-types.js'
import { TUI_USAGE } from './operator-usage.js'
import type { SetupArgs } from './setup-args.js'
import { defaultTerminal, isInteractiveTerminal } from './tty.js'
import { TUI_NOT_A_TTY, TUI_NOT_WIRED, TUI_NO_ARGUMENTS } from './tui-constants.js'
import { defaultReopen, runWizard, wizardPrefillOf, type ReopenFn } from './tui-wizard.js'
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
 * The three entry points differ in exactly one place: which screen opens. A
 * bare `mcpcut` with no config is a first run and opens the WIZARD, as does
 * `mcpcut setup` without `--yes` whether or not a config exists (there it is
 * an edit of the install that is already there). An explicit `mcpcut tui` is a
 * deliberate request for the console and opens over the default data
 * directory, `~/.mcpcut/data`, when no config says otherwise. Nothing looks for
 * a store anywhere else: an older one is reached by pointing `dataDir` or
 * `MCPCUT_DATA_DIR` at it (ADR-0013).
 *
 * The io shape is `UiCliIo` — declared structurally, like every other command
 * module, so nothing here imports the dispatcher that routes it. The
 * dispatcher arrives as a value instead (`opts.dispatch`), which is what the
 * console runs every action through.
 *
 * Phase 5 added the FOURTH way out of a console. Three were already here —
 * the operator quits, a signal arrives, the wizard asks for the sign-in
 * screen — and the new one is an action that leaves: Services ▸ `setup`
 * ends the console and leaves an argv in a cell (ADR-0012 §16). It reuses the
 * wizard's `ReopenFn` rather than inventing a second way to hand over a
 * terminal, so the child `mcpcut setup` opens the wizard in edit mode and, on
 * `y`, opens `tui` itself: a chain of processes on one terminal, the parent
 * waiting for the child and the child for the grandchild.
 */

export type TuiEntry = 'bare' | 'explicit' | 'setup'

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
  /** Overrides the style; the default asks the environment (`NO_COLOR`, `TERM=dumb` — F2). */
  readonly style?: Style
  /** Where signal and crash listeners go. Defaults to `process`. */
  readonly processEvents?: NodeJS.EventEmitter
  readonly signals?: readonly NodeJS.Signals[]
  readonly escapeCodeTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  /** Which invocation asked for the console; only which screen opens differs. */
  readonly entry?: TuiEntry
  /** The flags `mcpcut setup` was given, which prefill the wizard's form. */
  readonly setupArgs?: SetupArgs
  /** Home directory the default data dir is built from. Defaults to `homedir()`. */
  readonly home?: string
  /** Working directory a relative `--data-dir` is resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** How the wizard asks for the sign-in screen; the default spawns this build again. */
  readonly reopen?: ReopenFn
}

/**
 * Re-exported, not written here: the wizard asks the same question before it
 * opens, and `tty.ts` is the leaf both sides can import without importing each
 * other (`./tty.js`).
 */
export { isInteractiveTerminal } from './tty.js'

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

  const dispatch = opts.dispatch
  // A wiring fault, not an operator one, so it throws rather than printing:
  // there is no exit code that would make an un-wired console meaningful.
  if (dispatch === undefined) throw new Error(TUI_NOT_WIRED)

  const reopenCell = createReopenCell()
  const consoleDeps = consoleDepsOf(opts, io, env, dispatch, reopenCell)
  // The default reopen says what went wrong on the command's own stderr, which
  // is the stream the operator is looking at once the console is gone. Both
  // ways out share it: one terminal, one way of handing it over.
  const reopen = opts.reopen ?? ((argv: readonly string[]) => defaultReopen(argv, io.stderr))

  if (opts.entry === 'setup' || (opts.entry === 'bare' && install.kind === 'absent')) {
    return await openWizard(opts, env, install, consoleDeps, reopen)
  }

  return await openConsole(consoleDeps, install, reopenCell, reopen, opts.journalDir ?? JOURNAL_DIR)
}

/** The wizard over this install's config, and the sign-in screen after it. */
async function openWizard(
  opts: TuiCommandOptions,
  env: NodeJS.ProcessEnv,
  install: InstallConfigLoad,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
): Promise<number> {
  const prefill = wizardPrefillOf({
    install,
    env,
    home: opts.home ?? homedir(),
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.setupArgs !== undefined ? { args: opts.setupArgs } : {}),
  })

  return await runWizard({ console: consoleDeps, prefill, reopen })
}

/**
 * The console, and the command it may leave behind: Services ▸ `setup` ends
 * the console with an argv in the cell instead of dispatching anything.
 *
 * The reopen runs strictly AFTER `runConsole` has resolved — that is the only
 * moment the terminal is ours to give away, because the runtime leaves the
 * alternate screen, turns raw mode off and pauses stdin in its `finally`.
 */
async function openConsole(
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  install: InstallConfigLoad,
  reopenCell: ReopenCell,
  reopen: ReopenFn,
  journalDir: string,
): Promise<number> {
  const signin = signinHostFactsOf(journalDir)
  const code = await runConsole({
    ...consoleDeps,
    initial: (size) => initialModel(size, installFactsOf(install), signin),
  })
  const argv = reopenCell.get()
  if (code !== EXIT_OK || argv === undefined) return code

  return await reopen(argv)
}

/**
 * Whether the first owner's one-time token file is still there, read ONCE as
 * the console opens (phase 6, F6b): a host fact like the install config, not
 * something the reducer could learn later. `journalDir` is the directory the
 * console's own stores read — the seam when a caller gave one, the
 * process-wide default otherwise, exactly as `createAdminStore` resolves it —
 * so the screen never points at a file another install owns.
 */
function signinHostFactsOf(journalDir: string): SigninHostFacts {
  const path = bootstrapTokenPathFor(journalDir)
  return hasBootstrapTokenFile(path) ? { bootstrapTokenPath: path } : {}
}

/**
 * Everything a console runs on except the screen it opens with — the wizard
 * brings its own, the sign-in screen is the runtime's default — so both paths
 * are handed the same terminal, the same seams and the same session cell.
 */
function consoleDepsOf(
  opts: TuiCommandOptions,
  io: UiCliIo,
  env: NodeJS.ProcessEnv,
  dispatch: DispatchFn,
  reopen: ReopenCell,
): Omit<ConsoleDeps, 'initial'> {
  return {
    terminal: opts.terminal ?? defaultTerminal(),
    // The seam wins over the environment, so a test that asked for plain
    // frames gets them whatever shell runs the suite.
    style: opts.style ?? styleFor(env),
    stderr: io.stderr,
    effects: {
      dispatch,
      stderr: io.stderr,
      dispatchOptions: dispatchOptionsFor(opts),
      env,
      ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
      token: createTokenCell(),
      reopen,
    },
    processEvents: opts.processEvents ?? process,
    signals: opts.signals ?? DEFAULT_TUI_SIGNALS,
    escapeCodeTimeoutMs: opts.escapeCodeTimeoutMs ?? ESCAPE_CODE_TIMEOUT_MS,
    platform: opts.platform ?? process.platform,
  }
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
