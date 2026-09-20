import { homedir } from 'node:os'
import { formatReadableField } from '../journal/format.js'
import type { InstallConfigLoad } from '../setup/load.js'
import { EXIT_OK } from '../tui/constants.js'
import type { Model, RemoteProbeOutcome, TerminalSize, WizardScreen } from '../tui/model.js'
import { createRemoteClient, type FetchLike } from '../tui/remote/client.js'
import { readSavedRemote, savedRemotePathFor } from '../tui/remote/saved.js'
import { parseRemoteUrl } from '../tui/remote/url.js'
import { createWizardOutcomeCell, type ReopenCell } from '../tui/runtime-effects.js'
import { runConsole, type ConsoleDeps } from '../tui/runtime.js'
import { welcomeConnectModel, welcomeModel, type ConnectEntry } from '../tui/update-welcome.js'
import { wizardScreenOf, type WizardPrefill } from '../tui/wizard-fields.js'
import type { TuiCommandOptions } from './tui-cmd.js'
import { runRemoteTui, type RemoteTuiOptions } from './tui-remote.js'
import { REOPEN_ARGV, wizardPrefillOf, type ReopenFn } from './tui-wizard.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * The ways INTO the console that start on the welcome screen (ADR-0014 §§12–13):
 * a bare launch with no local install (the saved address first, "choose"
 * otherwise), `mcpcut --connect [url]`, and the prefilled connect form of a
 * saved service that did not answer — plus the two option helpers every entry
 * shares. Split out of `tui-cmd.ts` on 2026-09-20, when remembering the last
 * address took that file past its budget; `runTui` still owns the precedence
 * between entries, this module owns what each welcome entry does.
 *
 * The edge back to `tui-cmd.ts` is `import type` only, so it is erased at
 * compile time and the two modules do not form a runtime cycle.
 */

/** The `RemoteTuiOptions` a `runTui` caller's own options carry, `--remote` and the saved address alike. */
export function remoteTuiOptionsOf(opts: TuiCommandOptions): RemoteTuiOptions {
  return {
    ...(opts.terminal !== undefined ? { terminal: opts.terminal } : {}),
    ...(opts.style !== undefined ? { style: opts.style } : {}),
    ...(opts.processEvents !== undefined ? { processEvents: opts.processEvents } : {}),
    ...(opts.signals !== undefined ? { signals: opts.signals } : {}),
    ...(opts.escapeCodeTimeoutMs !== undefined ? { escapeCodeTimeoutMs: opts.escapeCodeTimeoutMs } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.dispatchOptions !== undefined ? { dispatchOptions: opts.dispatchOptions } : {}),
    ...(opts.remoteFetch !== undefined ? { remoteFetch: opts.remoteFetch } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.reopen !== undefined ? { reopen: opts.reopen } : {}),
  }
}

/** The wizard's opening values, resolved the one way every command resolves them. */
export function prefillOf(opts: TuiCommandOptions, env: NodeJS.ProcessEnv, install: InstallConfigLoad): WizardPrefill {
  return wizardPrefillOf({
    install,
    env,
    home: opts.home ?? homedir(),
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.setupArgs !== undefined ? { args: opts.setupArgs } : {}),
  })
}

/**
 * The welcome screen (2026-09-19), whichever stage it opens on, and the two
 * ways it can end.
 *
 * The wizard screen it may swap to (from "choose") is built exactly as
 * `openWizard` builds it — same prefill, same `wizardScreenOf` — and the
 * console is given the wizard's own `wizard: { outcome }` seam too, so
 * choosing "set up" behaves in every way like `mcpcut setup` opening it
 * directly: `wizard-finish` still has somewhere to leave its answer. Two
 * cells are read once the console has resolved, because either path out is a
 * `reopen`: the wizard's own `outcome` cell (`sign-in` → `REOPEN_ARGV`,
 * `runWizard`'s own rule) and `reopenCell` (a successful "connect" →
 * `['--remote', url]`, or a `disconnect` → `['--connect', address]`,
 * `update-welcome.ts`/`update-step.ts`). At most one is ever set, so the
 * order between them does not matter.
 *
 * `initial` is the one thing that differs between a bare, absent-install
 * entry (opens on "choose") and `--connect`/an unreachable saved address
 * (opens straight on "connect") — both share this same tail because "the
 * wizard is reachable from here" and "either exit is a reopen" are true of
 * both.
 */
async function runWelcomeConsole(
  wizard: WizardScreen,
  initial: (size: TerminalSize) => Model,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
  reopenCell: ReopenCell,
): Promise<number> {
  const outcome = createWizardOutcomeCell()

  const code = await runConsole({
    ...consoleDeps,
    effects: { ...consoleDeps.effects, wizard: { outcome } },
    initial,
  })
  if (code !== EXIT_OK) return code

  const argv = outcome.get() === 'sign-in' ? REOPEN_ARGV : reopenCell.get()
  if (argv === undefined) return code

  return await reopen(argv)
}

/** A bare, absent-install entry: opens on "choose" (unchanged since 2026-09-19). */
export async function openWelcome(
  opts: TuiCommandOptions,
  env: NodeJS.ProcessEnv,
  install: InstallConfigLoad,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
  reopenCell: ReopenCell,
): Promise<number> {
  const wizard = wizardScreenOf(prefillOf(opts, env, install))
  return await runWelcomeConsole(wizard, (size) => welcomeModel(size, wizard), consoleDeps, reopen, reopenCell)
}

/**
 * `mcpcut --connect [url]` (ADR-0014, 2026-09-20): the welcome screen opened
 * directly on its "connect" stage, prefilled from the argument when it
 * parses and carrying it as raw text on the form when it does not — a typo
 * is worth keeping to edit, not a reason to refuse. Esc quits outright when a
 * local install already exists (`escapesToChoose: false`): "choose" would
 * then offer "set up a service" over the very install already running.
 */
export async function openConnectEntry(
  opts: TuiCommandOptions,
  env: NodeJS.ProcessEnv,
  install: InstallConfigLoad,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
  reopenCell: ReopenCell,
): Promise<number> {
  const wizard = wizardScreenOf(prefillOf(opts, env, install))
  const entry = connectEntryFromArg(opts.connectArg, install)
  return await runWelcomeConsole(
    wizard,
    (size) => welcomeConnectModel(size, wizard, entry),
    consoleDeps,
    reopen,
    reopenCell,
  )
}

/** The connect-stage entry built from `--connect`'s own (possibly absent, possibly bad) argument. */
function connectEntryFromArg(raw: string | undefined, install: InstallConfigLoad): ConnectEntry {
  const escapesToChoose = install.kind === 'absent'
  if (raw === undefined) return { escapesToChoose }

  const parsed = parseRemoteUrl(raw)
  return parsed.ok
    ? { url: parsed.url, escapesToChoose }
    : { hostText: raw, notice: parsed.message, escapesToChoose }
}

/**
 * A bare, absent-install entry — the FOURTH item of the precedence table
 * (2026-09-20, owner request "remember the last address"): `--remote` and
 * `MCPCUT_REMOTE` have already been checked (`runTui`, ahead of this), and a
 * local install would never have reached here at all (`install.kind ===
 * 'absent'` is `runTui`'s own guard). What is left is whether a PREVIOUS
 * connect was ever remembered: reachable, it is exactly `--remote <url>`;
 * unreachable, the connect form opens already filled in, so fixing a typo or
 * trying a different service needs no retyping; absent or unreadable, this
 * is an ordinary first run and opens on "choose" same as always.
 */
export async function openBareWelcome(
  opts: TuiCommandOptions,
  io: UiCliIo,
  env: NodeJS.ProcessEnv,
  install: InstallConfigLoad,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
  reopenCell: ReopenCell,
): Promise<number> {
  const savedPath = savedRemotePathFor(env, opts.home)
  const saved = await readSavedRemote(savedPath)
  if (saved.kind === 'invalid') {
    io.stderr.write(savedRemoteInvalidWarning(savedPath, saved.message))
  }
  if (saved.kind !== 'ok') {
    return await openWelcome(opts, env, install, consoleDeps, reopen, reopenCell)
  }

  // Said before the dial, on the stream the operator is still looking at: the
  // probe may take the whole connect timeout, the terminal is not the
  // console's yet, and silence for that long reads as a hang.
  io.stderr.write(savedRemoteConnectingLine(saved.url))
  const probe = await probeRemoteOf(opts.remoteFetch)(saved.url)
  if (probe.ok) {
    const parsed = parseRemoteUrl(saved.url)
    // Belt and braces: `readSavedRemote` already re-validated this url with
    // this SAME parser, so `parsed.ok` here is not really in question.
    if (parsed.ok) return await runRemoteTui(parsed, io, env, remoteTuiOptionsOf(opts))
  }

  // `probe.ok` is false in every path that reaches here (the `if (probe.ok)`
  // above already returned on the one case it is true), so its message is
  // always the structured refusal `probeRemoteOf` built from `GET state`.
  const message = probe.ok ? '' : probe.message
  return await openUnreachableSavedWelcome(opts, env, install, consoleDeps, reopen, reopenCell, saved.url, message)
}

/** The one line a bare launch prints while it dials the remembered service. */
function savedRemoteConnectingLine(url: string): string {
  return `connecting to ${formatReadableField(url)} …\n`
}

/** One stderr line, naming the file and why it was ignored — never a crash, never silent. */
function savedRemoteInvalidWarning(path: string, message: string): string {
  return `warning: saved remote address at "${path}" is invalid (${message}) — ignoring it\n`
}

/**
 * The saved address answered nothing: the welcome screen opens on "connect",
 * prefilled from the address that failed, with a notice naming why. The file
 * itself is left alone — a service being down right now is not a reason to
 * forget where it lives (2026-09-20).
 */
async function openUnreachableSavedWelcome(
  opts: TuiCommandOptions,
  env: NodeJS.ProcessEnv,
  install: InstallConfigLoad,
  consoleDeps: Omit<ConsoleDeps, 'initial'>,
  reopen: ReopenFn,
  reopenCell: ReopenCell,
  savedUrl: string,
  message: string,
): Promise<number> {
  const wizard = wizardScreenOf(prefillOf(opts, env, install))
  const parsed = parseRemoteUrl(savedUrl)
  const notice = `the saved service did not answer: ${message}`
  const entry: ConnectEntry = {
    ...(parsed.ok ? { url: parsed.url } : { hostText: savedUrl }),
    notice,
    // Only ever reached from a bare, ABSENT-install entry (`openBareWelcome`'s
    // one caller): "choose" is always the honest fallback here.
    escapesToChoose: true,
  }

  return await runWelcomeConsole(
    wizard,
    (size) => welcomeConnectModel(size, wizard, entry),
    consoleDeps,
    reopen,
    reopenCell,
  )
}

/**
 * The welcome screen's "connect" probe, wired to the real network: the same
 * `state()` call `--remote` itself makes before opening a frame
 * (`tui-remote.ts`), reduced to the one bit and one message the screen needs.
 * `remoteFetch` is the same test seam `--remote` takes, reused rather than
 * forked so a test can hold both paths to one fake `fetch`.
 */
export function probeRemoteOf(remoteFetch: FetchLike | undefined): (url: string) => Promise<RemoteProbeOutcome> {
  return async (url) => {
    const client = createRemoteClient({
      baseUrl: url,
      ...(remoteFetch !== undefined ? { fetchImpl: remoteFetch } : {}),
    })
    const state = await client.state()
    return state.ok ? { ok: true } : { ok: false, message: state.message }
  }
}
