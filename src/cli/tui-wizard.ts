import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_CLI_PATH } from '../services/manager-types.js'
import { DEFAULT_DATA_DIR_NAME } from '../setup/constants.js'
import { resolveDataDir } from '../setup/data-dir.js'
import { defaultInstallConfig } from '../setup/defaults.js'
import type { InstallConfigLoad } from '../setup/load.js'
import { EXIT_INTERRUPTED, EXIT_OK } from '../tui/constants.js'
import { createWizardOutcomeCell } from '../tui/runtime-effects.js'
import { messageOf } from '../tui/runtime-terminal.js'
import { runConsole, type ConsoleDeps } from '../tui/runtime.js'
import { wizardScreenOf, type WizardPrefill } from '../tui/wizard-fields.js'
import { NO_SETUP_ARGS, overlaySetupArgs, type SetupArgs } from './setup-args.js'
import { REOPEN_SIGNAL_NOTICE, reopenFailedNotice } from './tui-constants.js'
import type { UiCliWritable } from './ui-constants.js'

/**
 * What opens the first-run wizard, and what happens once it is done (mcpcut
 * phase 3, task 9).
 *
 * Two answers live here, and neither belongs in the console. The first is what
 * the form says before an operator touches it: the config that exists (or the
 * defaults for an install that has none), with the data directory resolved the
 * way EVERY command resolves it — `MCP_JOURNAL_DIR` above the config above
 * `~/.mcp-journal` — and the `setup` flags laid over the result through the
 * same overlay `setup --yes` uses. One ranking, one overlay, so the wizard can
 * never open on a directory some other command would disagree about.
 *
 * The second is the restart. `runWizard` is deliberately the only thing that
 * knows the sign-in screen arrives in a NEW process.
 */

/** Everything the prefill is computed from; no disk, no clock, no process. */
export interface WizardPrefillInput {
  readonly install: InstallConfigLoad
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  /** Working directory a relative `--data-dir` is resolved against. */
  readonly cwd: string
  /** The flags `mcpcut setup` was given, when the wizard was opened from that command. */
  readonly args?: SetupArgs
}

/** The form's opening values: the config as it stands, plus where it will go. */
export function wizardPrefillOf(input: WizardPrefillInput): WizardPrefill {
  const base =
    input.install.kind === 'ok'
      ? input.install.config
      : defaultInstallConfig(join(input.home, DEFAULT_DATA_DIR_NAME))

  // env > config > default for the data directory — the same answer every
  // command gives, so the wizard opens on the directory the install uses.
  const resolved = resolveDataDir({ env: input.env, home: input.home, load: input.install })
  const config = overlaySetupArgs(
    { ...base, dataDir: resolved.dataDir },
    input.args ?? NO_SETUP_ARGS,
    input.cwd,
  )

  return {
    mode: input.install.kind === 'ok' ? 'edit' : 'first-run',
    configPath: input.install.path,
    config,
    ...(input.args?.admin !== undefined ? { admin: input.args.admin } : {}),
  }
}

/** How the wizard asks for the sign-in screen; a seam, because the default spawns. */
export type ReopenFn = (argv: readonly string[]) => Promise<number>

/** What the reopened process is asked to be: the console, signed out. */
export const REOPEN_ARGV: readonly string[] = ['tui']

/** The whole of the spawned child `defaultReopen` uses: two events, no more. */
export interface ReopenChild {
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * How the child is started; a seam so the two failures below can be tested
 * without a real process. `stdio: 'inherit'` is NOT a parameter — it is the
 * whole point of the default and belongs with it.
 */
export type ReopenSpawnFn = (command: string, args: readonly string[]) => ReopenChild

function spawnInherited(command: string, args: readonly string[]): ReopenChild {
  return spawn(command, [...args], { stdio: 'inherit' })
}

/**
 * Reopens this build as a child process on the same terminal.
 *
 * `stdio: 'inherit'` hands the child our own fd 0/1/2, so it sets its own raw
 * mode and draws where we drew — which is only safe because `runConsole` has
 * already restored the terminal by the time this runs (`runtime.ts`, the
 * `finally`). The child inherits `process.env` with it, which is how
 * `MCPCUT_CONFIG` reaches it; nothing is added to argv or the environment
 * here, least of all the owner token the wizard just showed.
 *
 * Both ways it can go wrong end on `EXIT_INTERRUPTED` AND on one line of
 * stderr. A spawn that never started (no build at `DEFAULT_CLI_PATH`, EACCES,
 * a fork limit) used to leave the operator who had just pressed `y` on the
 * one-time token in a silent shell with a bare exit 1; a signal exit reports
 * `code === null` and did the same. The line carries the error's message and
 * nothing else — no stack, and not the path, which is ours and not the
 * operator's problem.
 */
export function defaultReopen(
  argv: readonly string[],
  stderr: UiCliWritable = process.stderr,
  spawnFn: ReopenSpawnFn = spawnInherited,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawnFn(process.execPath, [DEFAULT_CLI_PATH, ...argv])
    child.on('exit', (code) => {
      if (code === null) stderr.write(REOPEN_SIGNAL_NOTICE)
      resolve(code ?? EXIT_INTERRUPTED)
    })
    child.on('error', (error) => {
      stderr.write(reopenFailedNotice(messageOf(error)))
      resolve(EXIT_INTERRUPTED)
    })
  })
}

/** The console the wizard runs on, what it opens with, and what follows it. */
export interface RunWizardDeps {
  /** Everything a console needs except its first screen, which is the wizard's. */
  readonly console: Omit<ConsoleDeps, 'initial'>
  readonly prefill: WizardPrefill
  readonly reopen: ReopenFn
}

/**
 * Runs the wizard, and — only if it ended by asking for the sign-in screen —
 * reopens this build as a child process.
 *
 * The restart is not a flourish. A data directory is resolved ONCE, when the
 * process starts (ADR-0012 §4), so a console opened in THIS process would keep
 * serving the old `~/.mcp-journal` in every command whose seams do not carry a
 * `journalDir` — the install the wizard just wrote would be invisible to the
 * screen that was supposed to show it. A new process resolves the config the
 * wizard wrote and has no stale answer to carry.
 *
 * `reopen` runs strictly AFTER `runConsole` has resolved, which is the only
 * moment the terminal is ours to give away: the runtime leaves the alternate
 * screen, turns raw mode off and pauses stdin in its `finally`.
 */
export async function runWizard(deps: RunWizardDeps): Promise<number> {
  const outcome = createWizardOutcomeCell()
  const code = await runConsole({
    ...deps.console,
    effects: { ...deps.console.effects, wizard: { outcome } },
    initial: (size) => ({ screen: wizardScreenOf(deps.prefill), size }),
  })
  if (code !== EXIT_OK || outcome.get() !== 'sign-in') return code

  return await deps.reopen(REOPEN_ARGV)
}
