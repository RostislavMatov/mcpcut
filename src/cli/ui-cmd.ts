import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createAdminStore, type AdminStore } from '../admin/store.js'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import { isRejectedOriginFlagValue } from '../net/origin-host.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import { preflightDatabases } from '../store/preflight.js'
import { createSessionManager } from '../ui/auth.js'
import { createUiServer, type UiServer } from '../ui/server.js'
import { createEventHub, type EventHub } from '../ui/events.js'
import { createQueueWatcher, type QueueWatcher } from '../ui/watch.js'
import { createVaultStore, type VaultStore } from '../vault/store.js'
import { describeBindFailure } from './bind-failure.js'
import { MAX_TCP_PORT } from './serve-constants.js'
import {
  BOOTSTRAP_ADMIN_NAME,
  bootstrapNotice,
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  DEFAULT_UI_SIGNALS,
  EXIT_STARTUP_FAILURE,
  trustedProxyHeaderNotice,
  UI_USAGE,
  type UiCliIo,
} from './ui-constants.js'
import { composeUi } from './ui-wiring.js'

/**
 * `mcp-journal ui` (M4 Task 16): the admin UI's process entry point, built to
 * the same shape as `serve` — flags → stores → server → listen → wait →
 * graceful shutdown, with `onListening` as the test seam and every dependency
 * injectable so a test never touches the real `~/.mcp-journal`.
 *
 * Three lifecycle decisions worth stating:
 *
 *  - **stdout is silent for the whole run.** `ui` is a daemon: the listening
 *    line, the bind warning and the one-time bootstrap credential all go to
 *    stderr. A supervisor redirecting stdout into a log must never end up with
 *    an admin token in it.
 *  - **A first start with no admins bootstraps ONE owner.** Shipping a UI
 *    nobody can log into is a worse failure than printing a credential once,
 *    and the alternative (a blank admin surface plus a second CLI step) is the
 *    kind of friction that ends in a shared token. The token is printed exactly
 *    once, to stderr only, and only its hash reaches disk. Bootstrap runs AFTER
 *    the socket is bound, so a failed bind never mints a credential.
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
function parseUiFlags(argv: readonly string[]): FlagResult {
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

  const port = parsePort(values['port'])
  if (port === null) {
    return { error: `Invalid --port "${String(values['port'])}": expected 0..${MAX_TCP_PORT}.` }
  }
  const host = typeof values['host'] === 'string' ? values['host'] : DEFAULT_UI_HOST
  if (host.length === 0) {
    return { error: 'Invalid --host: expected a non-empty address.' }
  }
  const allowedOrigins = Array.isArray(values['allowed-origin'])
    ? (values['allowed-origin'] as string[])
    : []
  if (allowedOrigins.some(isRejectedOriginFlagValue)) {
    return { error: `Invalid --allowed-origin "null": the opaque origin can never be allowed.` }
  }
  const rawProxyHeader = values['trusted-proxy-header']
  if (rawProxyHeader !== undefined && !HEADER_NAME_PATTERN.test(String(rawProxyHeader))) {
    return {
      error: `Invalid --trusted-proxy-header "${String(rawProxyHeader)}": expected a header name (e.g. x-forwarded-for).`,
    }
  }

  return {
    flags: {
      port,
      host,
      behindTls: values['behind-tls'] === true,
      allowedHosts: Array.isArray(values['allowed-host']) ? (values['allowed-host'] as string[]) : [],
      allowedOrigins,
      ...(typeof rawProxyHeader === 'string' ? { trustedProxyHeader: rawProxyHeader } : {}),
    },
  }
}

/** `0` (any free port) through 65535; anything else is a usage error. */
function parsePort(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_UI_PORT
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port <= MAX_TCP_PORT ? port : null
}

/** Everything one run owns, built once and torn down together. */
interface UiRuntime {
  readonly server: UiServer
  readonly hub: EventHub
  readonly watcher: QueueWatcher
  readonly adminStore: AdminStore
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
  })

  return { server, hub, watcher, adminStore }
}

/**
 * Mints the first `owner` when the store holds no active admin, and prints its
 * one-time credential to stderr. Returns `false` when the store could not be
 * read at all — a plane whose admin file is corrupt must refuse to run, not
 * silently bootstrap a second owner beside records it failed to parse.
 */
async function bootstrapAdmin(
  store: AdminStore,
  io: UiCliIo,
  host: string,
  port: number,
): Promise<boolean> {
  try {
    if ((await store.listAdmins()).length > 0) return true
    const { admin, token } = await store.createAdmin(BOOTSTRAP_ADMIN_NAME, 'owner')
    io.stderr.write(bootstrapNotice(host, port, admin.name, token))
    return true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`ui: cannot read the admin store: ${formatReadableField(message)}\n`)
    return false
  }
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
  const parsed = parseUiFlags(argv)
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

  if (!(await bootstrapAdmin(runtime.adminStore, io, flags.host, bound.port))) {
    await closeRuntime(runtime).catch(() => undefined)
    return EXIT_STARTUP_FAILURE
  }

  runtime.watcher.start()
  if (flags.trustedProxyHeader !== undefined) {
    io.stderr.write(`${trustedProxyHeaderNotice(flags.trustedProxyHeader)}\n`)
  }
  io.stderr.write(`ui: listening on http://${flags.host}:${bound.port}\n`)
  await waitForShutdown(runtime, io, opts, { port: bound.port, host: flags.host })
  return 0
}

/** Teardown order: stop polling, end every SSE stream, then close the listener. */
async function closeRuntime(runtime: UiRuntime): Promise<void> {
  runtime.watcher.stop()
  runtime.hub.close()
  await runtime.server.close()
}

interface BoundAddress {
  readonly port: number
  readonly host: string
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

