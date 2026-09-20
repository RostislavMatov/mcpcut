import { createAdminStore } from '../admin/store.js'
import { JOURNAL_DIR } from '../config.js'
import { styleFor, type Style } from '../tui/ansi.js'
import { DEFAULT_TUI_SIGNALS, ESCAPE_CODE_TIMEOUT_MS, EXIT_OK } from '../tui/constants.js'
import { initialModel, installFactsOf } from '../tui/model.js'
import type { FetchLike } from '../tui/remote/client.js'
import { savedRemotePathFor, writeSavedRemote } from '../tui/remote/saved.js'
import { resolveRemoteUrl } from '../tui/remote/url.js'
import { createReopenCell, createTokenCell, type ReopenCell } from '../tui/runtime-effects.js'
import { runConsole, type ConsoleDeps, type TuiTerminal } from '../tui/runtime.js'
import { firstOwnerModel } from '../tui/update-first-owner.js'
import { describeDataDirProblem, resolveDataDir } from '../setup/data-dir.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'
import type { DispatchFn, DispatchOptions } from './dispatch-types.js'
import { TUI_USAGE } from './operator-usage.js'
import type { SetupArgs } from './setup-args.js'
import { runRemoteTui } from './tui-remote.js'
import { defaultTerminal, isInteractiveTerminal } from './tty.js'
import { TUI_NOT_A_TTY, TUI_NOT_WIRED, TUI_NO_ARGUMENTS } from './tui-constants.js'
import { defaultReopen, runWizard, type ReopenFn } from './tui-wizard.js'
import { openBareWelcome, openConnectEntry, prefillOf, probeRemoteOf, remoteTuiOptionsOf } from './tui-welcome.js'
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
 * bare `mcpcut` with no config is a first run and opens the WELCOME screen
 * (2026-09-19) — set up here, or dial a service that already runs somewhere
 * else — whose "set up" choice is the very wizard screen `mcpcut setup`
 * without `--yes` opens directly, whether or not a config exists (there it is
 * an edit of the install that is already there: `mcpcut setup` never sees the
 * welcome screen at all). An explicit `mcpcut tui` is a deliberate request for
 * the console and opens over the default data directory, `~/.mcpcut/data`,
 * when no config says otherwise. Nothing looks for a store anywhere else: an
 * older one is reached by pointing `dataDir` or `MCPCUT_DATA_DIR` at it
 * (ADR-0013).
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

/**
 * `'connect'` joined 2026-09-20 (ADR-0014, owner request "fill in another
 * server"): `mcpcut --connect [url]` opens the welcome screen's "connect"
 * form directly, regardless of a local install, `MCPCUT_REMOTE` or a saved
 * address — the one entry that means "ask me for an address right now".
 */
export type TuiEntry = 'bare' | 'explicit' | 'setup' | 'connect'

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
  /**
   * The `--remote` flag's raw value (ADR-0014), when `cli.ts` parsed one off
   * argv. `MCPCUT_REMOTE` in `env` above is read the same way whether or not
   * this is set — the flag wins over the variable (`resolveRemoteUrl`).
   */
  readonly remoteFlag?: string
  /** Test seam for the remote HTTP client; defaults to the global `fetch`. */
  readonly remoteFetch?: FetchLike
  /**
   * `mcpcut --connect [url]`'s raw argument (ADR-0014, 2026-09-20): parsed
   * the same way `--remote`/`MCPCUT_REMOTE` are (`parseRemoteUrl`), but a bad
   * one is a NOTICE on the freshly-opened form rather than a refusal —
   * `--connect` exists to get an operator UNSTUCK. Only meaningful alongside
   * `entry: 'connect'`.
   */
  readonly connectArg?: string
  /**
   * "Remember the last address" (2026-09-20): where a successful "connect"
   * from the welcome form is saved. Defaults to `writeSavedRemote` at
   * `savedRemotePathFor(env, home)` — a seam so a test never touches a real
   * `~/.mcpcut/remote.json`.
   */
  readonly rememberRemote?: (url: string) => Promise<void>
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

  // ADR-0014, BEFORE any local install is read: a remote console dials
  // another host's `ui` and has no data directory of its own to check — the
  // broken-config gate below, and the wizard past it, are both about an
  // install this invocation may not even have.
  //
  // `--connect` (2026-09-20) is the ONE entry that skips this on purpose: the
  // owner's own precedence table puts `--remote`/`MCPCUT_REMOTE` ABOVE a bare
  // launch, but `--connect` is not a bare launch — it is a direct request for
  // the form, "regardless of a local install, MCPCUT_REMOTE or a saved file"
  // (point 4). An operator whose shell still exports `MCPCUT_REMOTE` from a
  // previous session must be able to type `mcpcut --connect` and reach the
  // form rather than be silently redirected to the address in that variable.
  if (opts.entry !== 'connect') {
    const remote = resolveRemoteUrl({ ...(opts.remoteFlag !== undefined ? { flag: opts.remoteFlag } : {}), env })
    if (remote !== undefined) {
      return runRemoteTui(remote, io, env, remoteTuiOptionsOf(opts))
    }
  }

  const install = opts.install ?? loadInstallConfigSync({ env })

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

  // `mcpcut --connect [url]` (ADR-0014, 2026-09-20): ahead of the
  // broken-config gate below, same reasoning as `--remote` above — the
  // connect FORM reads no data directory, and it must open even over a
  // broken local config: that is exactly the operator `--connect` exists to
  // get unstuck, by dialing somewhere else instead of fixing this machine.
  if (opts.entry === 'connect') {
    return await openConnectEntry(opts, env, install, consoleDeps, reopen, reopenCell)
  }

  // Belt and braces: the dispatcher gates a broken config ahead of this
  // command, so this is the path a caller that skipped it would take. The
  // words are the dispatcher's own, from the one function that writes them.
  const configProblem = describeDataDirProblem(resolveDataDir({ env, load: install }))
  if (configProblem !== undefined) {
    io.stderr.write(configProblem)
    return 1
  }

  if (opts.entry === 'setup') {
    return await openWizard(opts, env, install, consoleDeps, reopen)
  }
  if (opts.entry === 'bare' && install.kind === 'absent') {
    return await openBareWelcome(opts, io, env, install, consoleDeps, reopen, reopenCell)
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
  return await runWizard({ console: consoleDeps, prefill: prefillOf(opts, env, install), reopen })
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
  const isFirstRun = await hasNoAdmins(journalDir)
  const facts = installFactsOf(install)
  const code = await runConsole({
    ...consoleDeps,
    initial: (size) => (isFirstRun ? firstOwnerModel(size, facts) : initialModel(size, facts)),
  })
  const argv = reopenCell.get()
  if (code !== EXIT_OK || argv === undefined) return code

  return await reopen(argv)
}

/**
 * Whether this install has no admin at all, asked ONCE as the console opens:
 * it only picks the opening screen — the first-owner form instead of a
 * sign-in nobody holds a token for. The check that guards the creation is
 * `admin add`'s own, inside the store's update. A store that cannot be read
 * answers `false`: the sign-in screen already knows how to say `unreadable`,
 * and offering a new owner beside records nobody could parse is the one
 * thing a first run must not do (the rule `ui` applies at start).
 */
async function hasNoAdmins(journalDir: string): Promise<boolean> {
  try {
    return (await createAdminStore({ journalDir }).listAdmins()).length === 0
  } catch {
    return false
  }
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
      probeRemote: probeRemoteOf(opts.remoteFetch),
      rememberRemote: opts.rememberRemote ?? ((url) => writeSavedRemote(savedRemotePathFor(env, opts.home), url)),
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
