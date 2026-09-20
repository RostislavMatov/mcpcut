import type { TokenAdmin } from './admin-token.js'
import { styleFor, type Style } from '../tui/ansi.js'
import { createCell, createReopenCell, createTokenCell } from '../tui/cells.js'
import { DEFAULT_TUI_SIGNALS, ESCAPE_CODE_TIMEOUT_MS, EXIT_OK } from '../tui/constants.js'
import { initialModel, OWN_SUPERVISOR, type InstallFacts } from '../tui/model.js'
import { createRemoteClient, type FetchLike, type RemoteClient } from '../tui/remote/client.js'
import { createRemoteDispatch } from '../tui/remote/dispatch.js'
import { createRemoteResolve } from '../tui/remote/session.js'
import { createRemoteFirstOwnerSetup } from '../tui/remote/setup.js'
import { forgetSavedRemote, savedRemotePathFor } from '../tui/remote/saved.js'
import { isPlainHttpToNonLoopback, type RemoteUrlResult } from '../tui/remote/url.js'
import type { EffectDeps } from '../tui/runtime-effects.js'
import { runConsole, type ConsoleDeps, type TuiTerminal } from '../tui/runtime.js'
import { firstOwnerModel } from '../tui/update-first-owner.js'
import type { DispatchOptions } from './dispatch-types.js'
import { defaultTerminal } from './tty.js'
import { defaultReopen, type ReopenFn } from './tui-wizard.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * `mcpcut --remote <url>` (and a bare `mcpcut`/`mcpcut tui` with
 * `MCPCUT_REMOTE` set) — ADR-0014, plan wave 2 task 4.
 *
 * The console over a remote install has NO local data directory to read at
 * all — its dispatcher is `POST run` over HTTP instead of `cli.ts`'s router,
 * and its session resolves through `POST whoami` instead of the local admin
 * store. Everything else — the pure core, the catalogue, the runtime that
 * takes the terminal over — is the SAME console `tui-cmd.ts` opens locally;
 * this module only assembles the seams that make it talk to another host
 * instead of this one.
 *
 * `runTui` calls this BEFORE it reads any local install config: a remote
 * client has no install and must not need one to open.
 */

/** A remote console that refused to open — a bad address or an unreachable server. */
const EXIT_REMOTE_REFUSED = 1

/** Seams a remote console runs on; the local counterpart of `TuiCommandOptions`. */
export interface RemoteTuiOptions {
  readonly terminal?: TuiTerminal
  readonly style?: Style
  readonly processEvents?: NodeJS.EventEmitter
  readonly signals?: readonly NodeJS.Signals[]
  readonly escapeCodeTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  readonly dispatchOptions?: DispatchOptions
  /** Test seam for the HTTP client; defaults to the global `fetch`. */
  readonly remoteFetch?: FetchLike
  /** Home directory the saved-address file's default path is resolved against. Defaults to `homedir()`. */
  readonly home?: string
  /**
   * How `disconnect` hands the terminal to `mcpcut --connect <address>`
   * (2026-09-20); the default spawns this build again, exactly as the wizard
   * and Services ▸ `setup` do locally (`tui-wizard.ts`'s `defaultReopen`).
   */
  readonly reopen?: ReopenFn
}

/**
 * The one-time, loud warning a plain-http-to-non-loopback address earns
 * (RC4/`--ui-public-url` precedent): the admin token crosses the network in
 * clear, and the operator reads this before the alternate screen hides it.
 */
function plainHttpWarning(origin: string): string {
  return (
    `warning: --remote ${origin} is plain http to a non-loopback host: the admin token ` +
    'crosses the network in clear. Use https://, or "ssh -L <port>:127.0.0.1:<port> <user>@<host>".\n'
  )
}

/**
 * The remote console's session seams (ADR-0014, security review HIGH: a
 * network blip must not sign the operator out).
 *
 * `runtime-signin.ts`'s `isSessionFresh` used to mean "ask again" — a
 * `whoami` round trip before every single `run`/`poll`/`refresh-services`.
 * Over a network that doubles every request, and turns ANY failure of the
 * PRE-CHECK itself (a timeout, a DNS hiccup, a proxy blip) into a false
 * `SESSION_LOST`, even though the token is fine and the operator's own
 * request never even ran. There is no such pre-check here: `isFresh` answers
 * from `revoked`, a flag this closure already knows the value of, and the run
 * ITSELF is what authenticates against the server.
 *
 * `revoked` is set the moment — and only the moment — a run's structured
 * refusal is `unauthorized` (`createRemoteDispatch`'s `onUnauthorized`,
 * driven by `client.run`'s own `onRefusal`): a network failure, a different
 * refusal, or an ordinary non-zero exit never touches it, so THAT run still
 * fails in the pane as an ordinary failed run, but the NEXT effect this
 * console executes is the one that finds `isFresh` false and drops to the
 * sign-in screen. `resolve` clears it again the moment a sign-in proves the
 * token good — an admin who re-types a token after `admin rotate` is
 * believed immediately, exactly as typing it the first time would be.
 */
export interface RemoteSessionSeams {
  readonly resolve: (token: string) => Promise<TokenAdmin>
  readonly isFresh: () => boolean
  readonly onUnauthorized: () => void
}

export function createRemoteSessionSeams(client: RemoteClient): RemoteSessionSeams {
  // `true` is the only value ever stored — the flag's ABSENCE (`undefined`)
  // is "not revoked", so clearing it is just as cheap as setting it.
  const revoked = createCell<true>()
  const resolve = createRemoteResolve(client)
  return {
    isFresh: () => revoked.get() !== true,
    onUnauthorized: () => revoked.set(true),
    resolve: async (token) => {
      const result = await resolve(token)
      if (result.kind === 'ok') revoked.set(undefined)
      return result
    },
  }
}

/**
 * Opens a console over `remote`, or refuses with a stderr line and exit 1 —
 * NEVER a frame — when the address is malformed or the server cannot be
 * reached. `remote` carries the whole outcome of parsing `--remote`/
 * `MCPCUT_REMOTE` (`url.ts`) so this function has exactly one refusal to
 * print for a bad address and one for an unreachable server.
 */
export async function runRemoteTui(
  remote: RemoteUrlResult,
  io: UiCliIo,
  env: NodeJS.ProcessEnv,
  opts: RemoteTuiOptions = {},
): Promise<number> {
  if (!remote.ok) {
    io.stderr.write(`${remote.message}\n`)
    return EXIT_REMOTE_REFUSED
  }

  const { url } = remote
  const insecure = isPlainHttpToNonLoopback(url)
  if (insecure) io.stderr.write(plainHttpWarning(url.origin))

  const client = createRemoteClient({
    baseUrl: url.origin,
    ...(opts.remoteFetch !== undefined ? { fetchImpl: opts.remoteFetch } : {}),
  })
  const state = await client.state()
  if (!state.ok) {
    io.stderr.write(`could not open the console: ${state.message}\n`)
    return EXIT_REMOTE_REFUSED
  }

  const facts: InstallFacts = {
    supervisor: OWN_SUPERVISOR,
    remote: true,
    remoteAddress: url.origin,
    ...(insecure ? { remoteInsecure: true as const } : {}),
  }
  const session = createRemoteSessionSeams(client)
  // "A way to disconnect" (2026-09-20): the only effect a remote console can
  // ever leave the terminal on today (`Services ▸ setup`, the only other
  // `leavesConsole`/reopening action, is withdrawn over `--remote` —
  // `requires: 'local'`). Read strictly AFTER `runConsole` resolves, exactly
  // as `tui-cmd.ts`'s own local reopen is (the runtime has already restored
  // the terminal by then).
  const reopenCell = createReopenCell()
  const effects: EffectDeps = {
    reopen: reopenCell,
    dispatch: createRemoteDispatch(client, { onUnauthorized: session.onUnauthorized }),
    dispatchOptions: opts.dispatchOptions ?? {},
    env,
    // Where a `disconnect` (`forgetRemote`) or setup-code-file warning lands —
    // the same discipline `tui-cmd.ts`'s local wiring follows.
    stderr: io.stderr,
    token: createTokenCell(),
    resolve: session.resolve,
    isFresh: session.isFresh,
    remoteSetup: createRemoteFirstOwnerSetup(client),
    // "A way to disconnect" (2026-09-20): forgets the saved address, if any —
    // idempotent, so a console opened by `--remote`/`MCPCUT_REMOTE` (which
    // never wrote one) simply finds nothing to forget.
    forgetRemote: () => forgetSavedRemote(savedRemotePathFor(env, opts.home)),
  }
  const consoleDeps: ConsoleDeps = {
    terminal: opts.terminal ?? defaultTerminal(),
    style: opts.style ?? styleFor(env),
    stderr: io.stderr,
    effects,
    processEvents: opts.processEvents ?? process,
    signals: opts.signals ?? DEFAULT_TUI_SIGNALS,
    escapeCodeTimeoutMs: opts.escapeCodeTimeoutMs ?? ESCAPE_CODE_TIMEOUT_MS,
    platform: opts.platform ?? process.platform,
    initial: (size) => (state.value.firstRun ? firstOwnerModel(size, facts) : initialModel(size, facts)),
  }

  const code = await runConsole(consoleDeps)
  const argv = reopenCell.get()
  if (code !== EXIT_OK || argv === undefined) return code

  const reopen = opts.reopen ?? ((next: readonly string[]) => defaultReopen(next, io.stderr))
  return reopen(argv)
}
