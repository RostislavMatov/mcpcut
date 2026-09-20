import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createAdminStore, type AdminStore } from '../admin/store.js'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import type { ConsoleRunner } from '../console-api/runner.js'
import { JOURNAL_DIR } from '../config.js'
import { isRejectedOriginFlagValue } from '../net/origin-host.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import {
  InvalidBindEnvError,
  resolveUiDefaults,
  type UiServiceDefaults,
} from '../setup/bind.js'
import { loadInstallConfigSync } from '../setup/load.js'
import { preflightDatabases } from '../store/preflight.js'
import { createSessionManager } from '../ui/auth.js'
import { formatReadableField } from '../journal/format.js'
import { createUiServer, type UiServer } from '../ui/server.js'
import { createSetupGate, type SetupGate } from '../ui/setup-gate.js'
import { createEventHub, type EventHub } from '../ui/events.js'
import { createQueueWatcher, type QueueWatcher } from '../ui/watch.js'
import { createVaultStore, type VaultStore } from '../vault/store.js'
import { describeBindFailure } from './bind-failure.js'
import { createConsoleRunner } from './console-runner.js'
import type { DispatchFn, DispatchOptions } from './dispatch-types.js'
import { MAX_TCP_PORT } from './serve-constants.js'
import {
  DEFAULT_UI_SIGNALS,
  EXIT_STARTUP_FAILURE,
  trustedProxyHeaderNotice,
  UI_USAGE,
  type UiCliIo,
} from './ui-constants.js'
import { prepareFirstRun, type BoundAddress } from './ui-first-run.js'
import { composeUi } from './ui-wiring.js'

/**
 * `mcpcut ui` (M4 Task 16): the admin UI's process entry point, built to
 * the same shape as `serve` — flags → stores → server → listen → wait →
 * graceful shutdown, with `onListening` as the test seam and every dependency
 * injectable so a test never touches the real `~/.mcpcut/data`.
 *
 * Three lifecycle decisions worth stating:
 *
 *  - **stdout is silent for the whole run.** `ui` is a daemon: the listening
 *    line, the bind warning and every other diagnostic go to stderr, and the
 *    one-time setup code goes to NO stream. A supervisor redirecting either
 *    stream into a log must never end up with a first-run secret in it.
 *  - **A first start with no admins creates NOBODY and serves `/setup`**
 *    (ADR-0004, amendment of 2026-09-19; until then it minted an `owner`
 *    nobody had named). A one-time setup code is written to
 *    `<journalDir>/setup-code` (0600); stderr names that path; the page takes
 *    the code plus a chosen name, creates the owner and shows its token once.
 *    The code proves its bearer can read the data directory — the proof the
 *    old token file asked for — and dies with the first admin. It is written
 *    AFTER the socket is bound, so a failed bind leaves nothing on disk; a
 *    code file that could not be written refuses the run, because a first-run
 *    page whose code nobody can read is the UI nobody can get into.
 *  - **Shutdown is a handler, not a signal.** SIGINT/SIGTERM merely call the
 *    same `shutdown()` the handle exposes: stop the watcher, end every SSE
 *    stream (the hub), then close the listener. Ordering matters — closing the
 *    server first would leave the hub's subscribers writing into dead sockets.
 */

/** Live UI server, handed to the caller once the socket is bound. */
export interface UiHandle {
  readonly port: number
  readonly host: string
  /** Graceful shutdown; idempotent. Resolves once everything is closed. */
  shutdown(): Promise<void>
}

/** Stores `ui` reads and writes; injectable so tests supply their own. */
export interface UiStores {
  readonly adminStore?: AdminStore
  readonly agents?: AgentsStore
  readonly registry?: RegistryStore
  readonly vault?: VaultStore
}

export interface UiCommandOptions {
  /** Journal directory for stores, journal browsing, approvals and inventory. */
  readonly journalDir?: string
  readonly stores?: UiStores
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Clock (ms epoch) for approval countdowns and session TTLs. */
  readonly clock?: () => number
  /** Watcher poll cadence override (tests). */
  readonly queuePollIntervalMs?: number
  /** Signals that trigger a graceful shutdown. `[]` installs none (tests). */
  readonly signals?: readonly NodeJS.Signals[]
  /** Called once the socket is bound, with the handle that can shut it down. */
  readonly onListening?: (handle: UiHandle) => void
  /**
   * What every absent flag falls back to (phase 1, task 5). Defaults to the
   * environment-plus-install-config resolution; injected by tests and by any
   * caller that already read the config.
   */
  readonly bindDefaults?: UiServiceDefaults
  /**
   * The dispatcher the remote console API (ADR-0014, wave 1) runs commands
   * through — the same value `cli.ts` hands `runTui` for the local console.
   * `ui-cmd.ts` never imports `cli.ts` itself (`tests/architecture/imports.test.ts`),
   * so this arrives as a plain function value, handed down from `cli.ts`'s
   * own `ui` command line. Absent, `/api/console/*` does not exist: the
   * prefix falls through and answers as any unlisted route does.
   */
  readonly dispatch?: DispatchFn
  /** Per-command seams every dispatched run starts from (tests). Production passes none. */
  readonly dispatchOptions?: DispatchOptions
  /** Environment the daemon's own dispatched runs start from, before a request's token joins it (tests). Defaults to `process.env`. */
  readonly dispatchEnv?: NodeJS.ProcessEnv
}

const DEFAULT_IO: UiCliIo = { stdout: process.stdout, stderr: process.stderr }

interface UiFlags {
  readonly port: number
  readonly host: string
  readonly behindTls: boolean
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  /** Header the login rate limit keys on when a reverse proxy is in front. */
  readonly trustedProxyHeader?: string
}

/** RFC 9110 field-name token; anything else is not a header name. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

type FlagResult = { readonly flags: UiFlags } | { readonly error: string }

/** Parses `ui`'s flags strictly: an unknown option is a hard error. */
function parseUiFlags(argv: readonly string[], defaults: UiServiceDefaults): FlagResult {
  let values: Record<string, unknown>
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'behind-tls': { type: 'boolean', default: false },
        'allowed-host': { type: 'string', multiple: true },
        'allowed-origin': { type: 'string', multiple: true },
        'trusted-proxy-header': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }).values
  } catch {
    return { error: 'Unknown or malformed option(s) in ui command.' }
  }
  return buildUiFlags(values, defaults)
}

/**
 * Merges the parsed flags over `defaults` (phase 1, task 5): a flag the
 * operator typed always wins, and only a flag that is absent takes the
 * configured value. For the repeatable flags "absent" means "not given once" —
 * a single `--allowed-host` replaces the configured list rather than adding to
 * it, so what the command line says is what the server screens against.
 */
function buildUiFlags(values: Record<string, unknown>, defaults: UiServiceDefaults): FlagResult {
  const port = parsePort(values['port'], defaults.port)
  if (port === null) {
    return { error: `Invalid --port "${String(values['port'])}": expected 0..${MAX_TCP_PORT}.` }
  }
  const host = typeof values['host'] === 'string' ? values['host'] : defaults.host
  if (host.length === 0) {
    return { error: 'Invalid --host: expected a non-empty address.' }
  }
  // Only the flag's own values are screened here: the install config's schema
  // already refuses the opaque origin, so a config value cannot reach this.
  const flagOrigins = Array.isArray(values['allowed-origin'])
    ? (values['allowed-origin'] as string[])
    : undefined
  if (flagOrigins?.some(isRejectedOriginFlagValue) === true) {
    return { error: `Invalid --allowed-origin "null": the opaque origin can never be allowed.` }
  }
  // Checked after the merge, so a header name coming from the config is held
  // to the same grammar; the wording stays the flag's, which is the slot the
  // value fills and the only spelling a reader can act on.
  const proxyHeader =
    typeof values['trusted-proxy-header'] === 'string'
      ? values['trusted-proxy-header']
      : defaults.trustedProxyHeader
  if (proxyHeader !== undefined && !HEADER_NAME_PATTERN.test(proxyHeader)) {
    return {
      error: `Invalid --trusted-proxy-header "${proxyHeader}": expected a header name (e.g. x-forwarded-for).`,
    }
  }
  const flagHosts = Array.isArray(values['allowed-host'])
    ? (values['allowed-host'] as string[])
    : undefined

  return {
    flags: {
      port,
      host,
      behindTls: values['behind-tls'] === true ? true : (defaults.behindTls ?? false),
      allowedHosts: flagHosts ?? defaults.allowedHosts ?? [],
      allowedOrigins: flagOrigins ?? defaults.allowedOrigins ?? [],
      ...(proxyHeader !== undefined ? { trustedProxyHeader: proxyHeader } : {}),
    },
  }
}

/** `0` (any free port) through 65535; anything else is a usage error. */
function parsePort(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port <= MAX_TCP_PORT ? port : null
}

type DefaultsResult = { readonly defaults: UiServiceDefaults } | { readonly error: string }

/**
 * The defaults this run falls back to: the caller's, or the environment and
 * install config resolved here. An unusable `MCPCUT_UI_PORT` is refused in the
 * same words an unusable `--port` gets — a bind address nobody chose is worse
 * than a start that explains itself.
 */
function resolveDefaults(opts: UiCommandOptions): DefaultsResult {
  if (opts.bindDefaults !== undefined) return { defaults: opts.bindDefaults }
  try {
    return {
      defaults: resolveUiDefaults(process.env, loadInstallConfigSync({ env: process.env })),
    }
  } catch (error: unknown) {
    if (error instanceof InvalidBindEnvError) return { error: error.message }
    throw error
  }
}

/**
 * Builds the remote console's runner (ADR-0014, wave 1) when a dispatcher was
 * handed in; `undefined` otherwise, which leaves `/api/console/*` unbuilt —
 * `createUiServer` then answers the whole prefix as any unlisted route.
 */
function buildConsoleRunner(opts: UiCommandOptions): ConsoleRunner | undefined {
  if (opts.dispatch === undefined) return undefined
  return createConsoleRunner({
    dispatch: opts.dispatch,
    ...(opts.dispatchOptions !== undefined ? { baseOptions: opts.dispatchOptions } : {}),
    ...(opts.dispatchEnv !== undefined ? { env: opts.dispatchEnv } : {}),
  })
}

/** Everything one run owns, built once and torn down together. */
interface UiRuntime {
  readonly server: UiServer
  readonly hub: EventHub
  readonly watcher: QueueWatcher
  readonly adminStore: AdminStore
  /** The first-run gate `prepareFirstRun` arms or closes once the socket is bound. */
  readonly setupGate: SetupGate
  /** Waits for in-flight server probes (M5.5 п.1); starts nothing new. */
  readonly closeProbes: () => Promise<void>
}

function buildRuntime(flags: UiFlags, io: UiCliIo, opts: UiCommandOptions): UiRuntime {
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  // Only the vault still holds a cross-process file lock (its forced-removal
  // warning belongs on THIS run's stderr); the state stores moved to SQLite
  // in M4.5 wave 2 and have nothing to warn about.
  const warn = (line: string): void => {
    io.stderr.write(`${line}\n`)
  }
  const adminStore = opts.stores?.adminStore ?? createAdminStore({ journalDir })
  const agents = opts.stores?.agents ?? createAgentsStore({ journalDir })
  const registry = opts.stores?.registry ?? createRegistryStore(journalDir)
  const vault = opts.stores?.vault ?? createVaultStore({ journalDir, warn })

  // Sessions are built here, ahead of the hub and the server, because BOTH need
  // them: the server to authenticate each request, the hub to re-check the
  // sessions behind its never-ending SSE streams. Without that second link a
  // revoked admin keeps receiving events until they close the tab.
  const sessions = createSessionManager(opts.clock !== undefined ? { clock: opts.clock } : {})
  const hub = createEventHub({
    isSessionLive: (identity) => sessions.isLive(identity.sessionId, adminStore),
  })
  sessions.onDropped((dropped) => {
    hub.closeSession(dropped.sessionId)
  })

  const composed = composeUi({
    journalDir,
    approvalsBaseDir: opts.approvalsBaseDir ?? join(journalDir, 'approvals'),
    inventoryStorePath: opts.inventoryStorePath ?? join(journalDir, INVENTORY_FILE_NAME),
    adminStore,
    agents,
    registry,
    vault,
    hub,
    stderr: io.stderr,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  })

  const watcher = createQueueWatcher({
    queue: composed.queue,
    quarantineSignature: composed.quarantineSignature,
    publish: (event) => hub.publish(event),
    stderr: io.stderr,
    ...(opts.queuePollIntervalMs !== undefined ? { pollIntervalMs: opts.queuePollIntervalMs } : {}),
  })

  // Built closed-until-armed: `prepareFirstRun` arms it only after the socket
  // is bound and only over a store with no admin.
  const setupGate = createSetupGate({
    hasAdmins: async () => (await adminStore.listAdmins()).length > 0,
    onReadError: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      io.stderr.write(`[ui] first run: cannot read the admin store: ${formatReadableField(message)}\n`)
    },
  })
  const consoleRunner = buildConsoleRunner(opts)
  const server = createUiServer({
    adminStore,
    handlers: composed.handlers,
    sessions,
    behindTls: flags.behindTls,
    allowedHosts: flags.allowedHosts,
    allowedOrigins: flags.allowedOrigins,
    ...(flags.trustedProxyHeader !== undefined
      ? { trustedProxyHeader: flags.trustedProxyHeader }
      : {}),
    stderr: io.stderr,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    afterSignIn: composed.afterSignIn,
    firstRun: {
      gate: setupGate,
      createFirstOwner: (name) => adminStore.createFirstOwner(name),
      afterOwnerCreated: composed.afterOwnerCreated,
    },
    ...(consoleRunner !== undefined ? { consoleRunner } : {}),
  })

  return { server, hub, watcher, adminStore, setupGate, closeProbes: composed.closeProbes }
}

/**
 * Runs the admin UI until a shutdown is requested (signal or handle), then
 * resolves with the process exit code: 0 for a clean run, 1 for a refused
 * start. Never throws for an expected failure shape.
 */
export async function runUi(
  argv: readonly string[],
  io: UiCliIo = DEFAULT_IO,
  opts: UiCommandOptions = {},
): Promise<number> {
  const resolved = resolveDefaults(opts)
  if ('error' in resolved) {
    io.stderr.write(`${resolved.error}\n\n${UI_USAGE}`)
    return EXIT_STARTUP_FAILURE
  }
  const parsed = parseUiFlags(argv, resolved.defaults)
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n\n${UI_USAGE}`)
    return EXIT_STARTUP_FAILURE
  }
  const flags = parsed.flags

  // Before the stores are built: an admin console served off a damaged
  // database would show — and act on — state it cannot vouch for.
  if (!(await preflightDatabases(opts.journalDir ?? JOURNAL_DIR, io.stderr))) {
    return EXIT_STARTUP_FAILURE
  }

  const runtime = buildRuntime(flags, io, opts)

  let bound: { port: number }
  try {
    // The non-localhost bind warning is written by the server core itself,
    // into this run's stderr sink, before the socket is bound.
    bound = await runtime.server.listen(flags.port, flags.host)
  } catch (error: unknown) {
    io.stderr.write(describeBindFailure('ui', `${flags.host}:${flags.port}`, error))
    await closeRuntime(runtime).catch(() => undefined)
    return EXIT_STARTUP_FAILURE
  }

  const address: BoundAddress = { port: bound.port, host: flags.host }
  const isPrepared = await prepareFirstRun(
    runtime.adminStore,
    runtime.setupGate,
    io,
    address,
    opts.journalDir ?? JOURNAL_DIR,
  )
  if (!isPrepared) {
    await closeRuntime(runtime).catch(() => undefined)
    return EXIT_STARTUP_FAILURE
  }

  runtime.watcher.start()
  if (flags.trustedProxyHeader !== undefined) {
    io.stderr.write(`${trustedProxyHeaderNotice(flags.trustedProxyHeader)}\n`)
  }
  io.stderr.write(`ui: listening on http://${flags.host}:${bound.port}\n`)
  await waitForShutdown(runtime, io, opts, address)
  return 0
}

/**
 * Teardown order: stop polling, end every SSE stream, wait out in-flight
 * probes (their children must not outlive the run; a probe settling after
 * `hub.close()` publishes into a closed hub, which is a no-op), then close
 * the listener.
 */
async function closeRuntime(runtime: UiRuntime): Promise<void> {
  runtime.watcher.stop()
  runtime.hub.close()
  await runtime.closeProbes()
  await runtime.server.close()
}

/**
 * Installs the signal handlers, hands the caller its handle, and resolves once
 * the server has closed. The handlers are removed in every exit path, so a
 * `ui` run never leaves listeners on the process behind it.
 */
async function waitForShutdown(
  runtime: UiRuntime,
  io: UiCliIo,
  opts: UiCommandOptions,
  address: BoundAddress,
): Promise<void> {
  let settleRun: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    settleRun = resolve
  })
  let closing: Promise<void> | null = null
  /**
   * Never rejects: a shutdown triggered by a signal has nobody to catch it,
   * and a caller awaiting the handle must not have to guard the teardown of a
   * run that already did its job.
   */
  const shutdown = (): Promise<void> => {
    closing ??= closeRuntime(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        io.stderr.write(`ui: shutdown did not complete cleanly: ${message}\n`)
      })
      .finally(() => settleRun())
    return closing
  }

  const signals = opts.signals ?? DEFAULT_UI_SIGNALS
  const installed: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = signals.map((signal) => {
    const listener: NodeJS.SignalsListener = () => {
      io.stderr.write(`ui: ${signal} received, shutting down\n`)
      void shutdown()
    }
    process.on(signal, listener)
    return [signal, listener]
  })

  try {
    opts.onListening?.({ port: address.port, host: address.host, shutdown })
    await finished
  } finally {
    for (const [signal, listener] of installed) {
      process.removeListener(signal, listener)
    }
  }
}

