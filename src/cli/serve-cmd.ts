import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR, SYSTEM_ENV_ALLOWLIST } from '../config.js'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import { resolvePolicySource } from '../policy/source.js'
import type { Policy } from '../policy/schema.js'
import { journalingOnlyPolicy } from './connect-policy.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import { createHttpFront, type HttpFront } from '../transport/http/server.js'
import { isRejectedOriginFlagValue } from '../net/origin-host.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import { createVaultStore, type VaultStore } from '../vault/store.js'
import { ulid } from 'ulid'
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  MAX_TCP_PORT,
  SERVE_USAGE,
  type ServeCliIo,
} from './serve-constants.js'
import { describeBindFailure } from './bind-failure.js'
import { createServeHooks } from './serve-hooks.js'
import { createServeSessionFactory } from './serve-runtime.js'

/**
 * `mcp-journal serve` (M3 Task 13): the control plane's HTTP front for HTTP
 * agents — many sessions in one process, each one a full `session/core.ts`
 * session over an upstream taken from the registry (stdio spawn per session,
 * or an HTTP upstream client).
 *
 * This module owns only the run's lifecycle: flags → policy → stores → front
 * → listen → wait → graceful shutdown. Everything per-session lives in
 * `serve-runtime.ts`, the semantic hooks in `serve-hooks.ts`, the upstream
 * plumbing in `serve-upstream.ts`.
 *
 * Two lifecycle decisions worth stating:
 *
 *  - **A broken policy stops the process before it binds.** Falling back to
 *    allow-all is never acceptable (M2 decision, `wrap` does the same). No
 *    policy file anywhere is NOT an error: the schema defaults apply (whose
 *    `defaultDecision` is `require-approval`), because a serve run without a
 *    gate would leave agent grants unenforced. That case is announced loudly
 *    on stderr — it is a working, but very restrictive, plane.
 *  - **Shutdown is a handler, not a signal.** SIGINT/SIGTERM merely call the
 *    same `shutdown()` the returned handle exposes: close the front (which
 *    tears every session down — each session's own close flushes its journal
 *    before its sinks go away), then resolve with exit code 0. That keeps the
 *    graceful path unit-testable without signalling a test runner's process.
 *
 * stdout stays silent for the whole run: `serve` is a daemon, and every
 * diagnostic line belongs on stderr.
 */

/** Live front, handed to the caller once the socket is bound. */
export interface ServeHandle {
  readonly port: number
  readonly host: string
  /** Graceful shutdown; idempotent. Resolves once the front is fully closed. */
  shutdown(): Promise<void>
}

/** Stores `serve` reads; injectable so tests never touch the real journal dir. */
export interface ServeStores {
  readonly registry?: RegistryStore
  readonly agents?: AgentsStore
  readonly vault?: Pick<VaultStore, 'readSecretValues'>
}

export interface ServeCommandOptions {
  /** Journal directory for stores, journal files, approvals and inventory. */
  readonly journalDir?: string
  readonly stores?: ServeStores
  /** Forwarded to `loadPolicy` unchanged (minus `explicitPath`, which is `--policy`). */
  readonly loadPolicy?: Omit<LoadPolicyOptions, 'explicitPath'>
  /** The plane's environment; only its allowlisted slice reaches a child. */
  readonly processEnv?: NodeJS.ProcessEnv
  /** Journal session id factory. Defaults to `ulid()`. */
  readonly newSessionId?: () => string
  readonly clock?: () => number
  /** Agent revocation poll interval per session; defaults to the ≤5 s constant. */
  readonly revocationPollIntervalMs?: number
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Signals that trigger a graceful shutdown. `[]` installs none (tests). */
  readonly signals?: readonly NodeJS.Signals[]
  /** Called once the socket is bound, with the handle that can shut it down. */
  readonly onListening?: (handle: ServeHandle) => void
  readonly killEscalationMs?: number
  /**
   * @internal test-only seam for injecting a failing journal batch commit
   * (the same seam `RunWrapOptions` exposes), so fail-closed behaviour can be
   * exercised without an unwritable disk.
   */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}

const DEFAULT_IO: ServeCliIo = { stdout: process.stdout, stderr: process.stderr }

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Exit code for a refused start (bad flags, broken policy, unusable port). */
const EXIT_STARTUP_FAILURE = 1

interface ServeFlags {
  readonly port: number
  readonly host: string
  readonly policyPath: string | undefined
  readonly failClosed: boolean
  readonly allowedOrigins: readonly string[]
  readonly allowedHosts: readonly string[]
}

type FlagResult = { readonly flags: ServeFlags } | { readonly error: string }

/** Parses serve's flags strictly: an unknown option is a hard error. */
function parseServeFlags(argv: readonly string[]): FlagResult {
  let values: Record<string, unknown>
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        policy: { type: 'string' },
        'fail-closed': { type: 'boolean', default: false },
        'allowed-origin': { type: 'string', multiple: true },
        'allowed-host': { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    })
    values = parsed.values
  } catch {
    return { error: 'Unknown or malformed option(s) in serve command.' }
  }

  const port = parsePort(values['port'])
  if (port === null) {
    return { error: `Invalid --port "${String(values['port'])}": expected 0..${MAX_TCP_PORT}.` }
  }
  const host = typeof values['host'] === 'string' ? values['host'] : DEFAULT_SERVE_HOST
  if (host.length === 0) {
    return { error: 'Invalid --host: expected a non-empty address.' }
  }
  const allowedOrigins = Array.isArray(values['allowed-origin'])
    ? (values['allowed-origin'] as string[])
    : []
  if (allowedOrigins.some(isRejectedOriginFlagValue)) {
    return { error: `Invalid --allowed-origin "null": the opaque origin can never be allowed.` }
  }

  return {
    flags: {
      port,
      host,
      policyPath: typeof values['policy'] === 'string' ? values['policy'] : undefined,
      failClosed: values['fail-closed'] === true,
      allowedOrigins,
      allowedHosts: Array.isArray(values['allowed-host'])
        ? (values['allowed-host'] as string[])
        : [],
    },
  }
}

/** `0` (any free port) through 65535; anything else is a usage error. */
function parsePort(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_SERVE_PORT
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port <= MAX_TCP_PORT ? port : null
}

type PolicyOutcome = { readonly policy: Policy } | { readonly exitCode: number }

/** `--fail-closed` only ever turns fail-closed ON; a policy asking for it always gets it. */
function applyFailClosed(policy: Policy, failClosed: boolean): Policy {
  const effective = failClosed || policy.journal.failClosed
  if (policy.journal.failClosed === effective) return policy
  return { ...policy, journal: { ...policy.journal, failClosed: effective } }
}

/**
 * `serve` is an `operator-launched` entry point (ADR-0005): it is started from
 * an operator's shell or unit file, so its argv, `cwd` and environment are as
 * trusted as the launch itself and the full four-source order of
 * `policy/load.ts` applies unchanged. Going through `resolvePolicySource`
 * rather than calling `loadPolicy` directly is what makes that a decision on
 * record instead of an omission -- the source rule now has one home, and this
 * entry point reads it from there.
 */
async function resolvePolicy(
  flags: ServeFlags,
  io: ServeCliIo,
  opts: ServeCommandOptions,
  journalDir: string,
): Promise<PolicyOutcome> {
  const source = await resolvePolicySource({
    entryPoint: 'serve',
    journalDir: opts.loadPolicy?.journalDir ?? journalDir,
    ...(opts.loadPolicy?.env !== undefined ? { env: opts.loadPolicy.env } : {}),
    ...(opts.loadPolicy?.cwd !== undefined ? { cwd: opts.loadPolicy.cwd } : {}),
    ...(opts.loadPolicy?.readFile !== undefined ? { readFile: opts.loadPolicy.readFile } : {}),
    ...(flags.policyPath !== undefined ? { explicitPath: flags.policyPath } : {}),
  })

  if (source.status === 'refused') {
    // Unreachable for an operator-launched entry point; handled rather than
    // asserted so a future trust-class change cannot start a server on a
    // policy the rule module just refused.
    io.stderr.write(`serve: policy source refused (${source.reason})\n`)
    return { exitCode: EXIT_STARTUP_FAILURE }
  }

  const result: PolicyLoadResult = await loadPolicy(source.loadOptions)

  if (result.status === 'error') {
    for (const line of result.errors) {
      io.stderr.write(`${result.sourcePath}: ${line}\n`)
    }
    return { exitCode: EXIT_STARTUP_FAILURE }
  }
  if (result.status === 'disabled') {
    // Same behavior as connect (see connect-policy.ts): no policy file means
    // "journal everything, let agent grants decide", never a stricter implicit
    // default — turning enforcement on is an explicit operator act (M2 rule),
    // and the two entry points must not diverge on it.
    io.stderr.write('serve: no policy file found; journaling only (agent grants still apply)\n')
    return { policy: applyFailClosed(journalingOnlyPolicy(), flags.failClosed) }
  }
  io.stderr.write(`serve: policy loaded from ${result.sourcePath}\n`)
  return { policy: applyFailClosed(result.policy, flags.failClosed) }
}

/** Builds the front for one run, with every semantic hook injected. */
function buildFront(
  flags: ServeFlags,
  io: ServeCliIo,
  opts: ServeCommandOptions,
  policy: Policy,
  journalDir: string,
): HttpFront {
  // Only the vault still holds a cross-process file lock (its forced-removal
  // warning belongs on THIS run's stderr); the state stores moved to SQLite
  // in M4.5 wave 2 and have nothing to warn about.
  const warn = (line: string): void => {
    io.stderr.write(`${line}\n`)
  }
  const agents = opts.stores?.agents ?? createAgentsStore({ journalDir })
  const registry = opts.stores?.registry ?? createRegistryStore(journalDir)
  const vault = opts.stores?.vault ?? createVaultStore({ journalDir, warn })
  const hooks = createServeHooks()

  const openSession = createServeSessionFactory({
    registry,
    agents,
    handoff: hooks.handoff,
    policy,
    journalDir,
    approvalsBaseDir: opts.approvalsBaseDir ?? join(journalDir, 'approvals'),
    inventoryStorePath: opts.inventoryStorePath ?? join(journalDir, INVENTORY_FILE_NAME),
    stderr: io.stderr,
    upstream: {
      processEnv: opts.processEnv ?? process.env,
      envAllowlist: SYSTEM_ENV_ALLOWLIST,
      resolveRefs: (record) => resolveVaultRefs(record, (names) => vault.readSecretValues(names)),
      ...(opts.killEscalationMs !== undefined ? { killEscalationMs: opts.killEscalationMs } : {}),
    },
    newSessionId: opts.newSessionId ?? ulid,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.revocationPollIntervalMs !== undefined
      ? { revocationPollIntervalMs: opts.revocationPollIntervalMs }
      : {}),
    failClosed: policy.journal.failClosed,
    ...(opts.journalCommitBatchImpl !== undefined
      ? { journalCommitBatchImpl: opts.journalCommitBatchImpl }
      : {}),
  })

  return createHttpFront({
    agentsStore: agents,
    openSession,
    detectInitialize: hooks.detectInitialize,
    validateStatelessHeaders: hooks.validateStatelessHeaders,
    expectsResponse: hooks.expectsResponse,
    allowedOrigins: flags.allowedOrigins,
    allowedHosts: flags.allowedHosts,
    stderr: io.stderr,
  })
}

/**
 * Runs the HTTP front until a shutdown is requested (signal or handle), then
 * resolves with the process exit code: 0 for a clean run, 1 for a refused
 * start. Never throws for an expected failure shape.
 */
export async function runServe(
  argv: readonly string[],
  io: ServeCliIo = DEFAULT_IO,
  opts: ServeCommandOptions = {},
): Promise<number> {
  const parsed = parseServeFlags(argv)
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n\n${SERVE_USAGE}`)
    return EXIT_STARTUP_FAILURE
  }
  const flags = parsed.flags
  const journalDir = opts.journalDir ?? JOURNAL_DIR

  const policyOutcome = await resolvePolicy(flags, io, opts, journalDir)
  if ('exitCode' in policyOutcome) {
    return policyOutcome.exitCode
  }

  const front = buildFront(flags, io, opts, policyOutcome.policy, journalDir)

  let bound: { port: number }
  try {
    bound = await front.listen(flags.port, flags.host)
  } catch (error: unknown) {
    io.stderr.write(describeBindFailure('serve', `${flags.host}:${flags.port}`, error))
    await front.close().catch(() => undefined)
    return EXIT_STARTUP_FAILURE
  }

  io.stderr.write(`serve: listening on http://${flags.host}:${bound.port}\n`)
  await waitForShutdown(front, io, opts, { port: bound.port, host: flags.host })
  return 0
}

interface BoundAddress {
  readonly port: number
  readonly host: string
}

/**
 * Installs the signal handlers, hands the caller its handle, and resolves
 * once the front has closed. The handlers are removed in every exit path, so
 * a `serve` run never leaves listeners on the process behind it.
 */
async function waitForShutdown(
  front: HttpFront,
  io: ServeCliIo,
  opts: ServeCommandOptions,
  address: BoundAddress,
): Promise<void> {
  let settleRun: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    settleRun = resolve
  })
  let closing: Promise<void> | null = null
  /**
   * Never rejects: a shutdown triggered by a signal has nobody to catch it,
   * and a caller awaiting the handle must not have to guard the teardown of
   * a run that already did its job. A failure is reported and swallowed.
   */
  const shutdown = (): Promise<void> => {
    closing ??= front
      .close()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        io.stderr.write(`serve: shutdown did not complete cleanly: ${message}\n`)
      })
      .finally(() => settleRun())
    return closing
  }

  const signals = opts.signals ?? DEFAULT_SIGNALS
  const installed: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = signals.map((signal) => {
    const listener: NodeJS.SignalsListener = () => {
      io.stderr.write(`serve: ${signal} received, shutting down\n`)
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

