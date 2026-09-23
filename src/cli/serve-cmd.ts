import { join } from 'node:path'
import { JOURNAL_DIR, SYSTEM_ENV_ALLOWLIST } from '../config.js'
import {
  MAX_CONCURRENT_SESSIONS,
  POOL_ROUTE_TARGET,
} from '../transport/http/server-constants.js'
import { createEffectiveAgentLister, createEffectiveAgentReader } from '../agents/effective-reader.js'
import { createAgentsStore } from '../agents/store.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { loadPolicy, type PolicyLoadResult } from '../policy/load.js'
import { mapPolicyProvider, type PolicyProvider } from '../policy/reload.js'
import { resolvePolicySource } from '../policy/source.js'
import type { Policy } from '../policy/schema.js'
import { journalingOnlyPolicy } from './connect-policy.js'
import { createAwaitingPolicy, createReloadingPolicy } from './policy-reload.js'
import { guardDiagnostics } from '../proxy/diagnostics.js'
import { createGroupsStore } from '../groups/store.js'
import { createRegistryStore } from '../registry/store.js'
import {
  InvalidBindEnvError,
  resolveServeDefaults,
  type ServeServiceDefaults,
} from '../setup/bind.js'
import { loadInstallConfigSync } from '../setup/load.js'
import { preflightDatabases } from '../store/preflight.js'
import { createHttpFront, type HttpFront } from '../transport/http/server.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import { createVaultStore } from '../vault/store.js'
import { ulid } from 'ulid'
import { SERVE_USAGE, type ServeCliIo } from './serve-constants.js'
import type { ServeCommandOptions } from './serve-options.js'
import { parseServeFlags, type ServeFlags } from './serve-flags.js'
import { describeBindFailure } from './bind-failure.js'
import type { ChildSessionDeps } from './serve-child.js'
import { createServeHooks } from './serve-hooks.js'
import { createPoolWiring, type ResidentsLifecycle } from './serve-pool-wiring.js'
import { createServeSessionFactory } from './serve-runtime.js'
import { AGENT_REVOCATION_POLL_INTERVAL_MS } from '../session/constants.js'
import { MAX_POOL_RESIDENTS } from '../pool/constants.js'

/**
 * `mcpcut serve` (M3 Task 13): the control plane's HTTP front for HTTP
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

export type { ServeCommandOptions, ServeHandle, ServeStores } from './serve-options.js'

const DEFAULT_IO: ServeCliIo = { stdout: process.stdout, stderr: process.stderr }

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Exit code for a refused start (bad flags, broken policy, unusable port). */
const EXIT_STARTUP_FAILURE = 1

type DefaultsResult = { readonly defaults: ServeServiceDefaults } | { readonly error: string }

/**
 * The defaults this run falls back to: the caller's, or the environment and
 * install config resolved here. An unusable `MCPCUT_SERVE_PORT` is refused in
 * the same words an unusable `--port` gets — a front listening where nobody
 * chose is worse than a start that explains itself.
 */
function resolveDefaults(opts: ServeCommandOptions): DefaultsResult {
  if (opts.bindDefaults !== undefined) return { defaults: opts.bindDefaults }
  try {
    return {
      defaults: resolveServeDefaults(process.env, loadInstallConfigSync({ env: process.env })),
    }
  } catch (error: unknown) {
    if (error instanceof InvalidBindEnvError) return { error: error.message }
    throw error
  }
}

type PolicyOutcome = { readonly policy: PolicyProvider } | { readonly exitCode: number }

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
    //
    // The fallback WAITS for a file (smoke 2026-09-18, M1): `setup` starts this
    // front before the operator has written any policy, and the first valid
    // one to appear where `serve` looks is adopted without a restart.
    io.stderr.write(
      'serve: no policy file found; journaling only (agent grants still apply) — ' +
        'a policy.json that appears later is adopted without a restart\n',
    )
    const awaiting = createAwaitingPolicy({
      fallback: journalingOnlyPolicy(),
      loadOptions: source.loadOptions,
      candidates: source.candidates,
      stderr: io.stderr,
    })
    return { policy: mapPolicyProvider(awaiting, (policy) => applyFailClosed(policy, flags.failClosed)) }
  }
  io.stderr.write(`serve: policy loaded from ${result.sourcePath}\n`)
  // The override is a mapping over the provider, so it survives a hot reload
  // (wave 2 of the policy-tool-rules-ui plan): every session opened by this
  // front reads the rules in force at its next decision, not at start-up.
  const reloading = createReloadingPolicy({
    initial: result.policy,
    sourcePath: result.sourcePath,
    loadOptions: source.loadOptions,
    candidates: source.candidates,
    stderr: io.stderr,
  })
  return { policy: mapPolicyProvider(reloading, (policy) => applyFailClosed(policy, flags.failClosed)) }
}

/** Builds the front for one run, with every semantic hook injected. */
function buildFront(
  flags: ServeFlags,
  io: ServeCliIo,
  opts: ServeCommandOptions,
  policy: PolicyProvider,
  journalDir: string,
): ServeRuntime {
  // Only the vault still holds a cross-process file lock (its forced-removal
  // warning belongs on THIS run's stderr); the state stores moved to SQLite
  // in M4.5 wave 2 and have nothing to warn about.
  const warn = (line: string): void => {
    io.stderr.write(`${line}\n`)
  }
  const agents = opts.stores?.agents ?? createAgentsStore({ journalDir })
  const groups = opts.stores?.groups ?? createGroupsStore({ journalDir })
  // One reader for both the front's token check and the session factory's
  // re-read: an agent granted through a group authenticates and opens a
  // session exactly like one granted personally (G2/G5).
  const agentReader = createEffectiveAgentReader({ agents, groups })
  const registry = opts.stores?.registry ?? createRegistryStore(journalDir)
  const vault = opts.stores?.vault ?? createVaultStore({ journalDir, warn })
  const hooks = createServeHooks()

  /** Everything both serve modes hand a session, per-server and pooled alike. */
  const shared: ChildSessionDeps = {
    agents: agentReader,
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
    // Wiring-time configuration: read once, does not hot-reload.
    failClosed: policy.current().journal.failClosed,
    ...(opts.journalCommitBatchImpl !== undefined
      ? { journalCommitBatchImpl: opts.journalCommitBatchImpl }
      : {}),
  }

  const openPerServer = createServeSessionFactory({
    ...shared,
    registry,
    handoff: hooks.handoff,
  })

  let front: HttpFront | null = null
  const maxSessions = opts.maxSessions ?? MAX_CONCURRENT_SESSIONS
  const pool = createPoolWiring({
    shared,
    registry,
    handoff: hooks.handoff,
    maxSessions,
    revocationPollIntervalMs: opts.revocationPollIntervalMs ?? AGENT_REVOCATION_POLL_INTERVAL_MS,
    ...(opts.poolFanoutTimeoutMs !== undefined
      ? { poolFanoutTimeoutMs: opts.poolFanoutTimeoutMs }
      : {}),
    ...(opts.poolWatchPollIntervalMs !== undefined
      ? { poolWatchPollIntervalMs: opts.poolWatchPollIntervalMs }
      : {}),
    ...(opts.poolStartTimeoutMs !== undefined ? { poolStartTimeoutMs: opts.poolStartTimeoutMs } : {}),
    ...(opts.poolWarmIdleMs !== undefined ? { poolWarmIdleMs: opts.poolWarmIdleMs } : {}),
    ...(opts.poolResidentRestartBaseMs !== undefined
      ? { poolResidentRestartBaseMs: opts.poolResidentRestartBaseMs }
      : {}),
    lister: createEffectiveAgentLister({ agents, groups }),
    residentReconcileMs:
      opts.poolResidentReconcileMs ?? opts.revocationPollIntervalMs ?? AGENT_REVOCATION_POLL_INTERVAL_MS,
    maxPoolResidents: opts.maxPoolResidents ?? MAX_POOL_RESIDENTS,
    // The front is built after the factory, and takes it as an argument.
    frontRef: () => front,
  })

  front = createHttpFront({
    agentsStore: agentReader,
    maxSessions,
    // The pool address arrives with a reserved `serverName` no registry name
    // could ever be (`POOL_ROUTE_TARGET` starts with `_`), so one comparison
    // separates the two modes with no second parse of the route.
    openSession: (ctx) =>
      ctx.serverName === POOL_ROUTE_TARGET ? pool.openPool(ctx) : openPerServer(ctx),
    extraSessions: pool.extraSessions,
    // An idle warm server yields its slot to a new session (RS7).
    reclaimSessions: pool.reclaim,
    detectInitialize: hooks.detectInitialize,
    validateStatelessHeaders: hooks.validateStatelessHeaders,
    expectsResponse: hooks.expectsResponse,
    allowedOrigins: flags.allowedOrigins,
    allowedHosts: flags.allowedHosts,
    stderr: io.stderr,
  })
  return { front, residents: pool.residents }
}

/** What one run starts, listens with, and tears down. */
interface ServeRuntime {
  readonly front: HttpFront
  readonly residents: ResidentsLifecycle
}

/**
 * Runs the HTTP front until a shutdown is requested (signal or handle), then
 * resolves with the process exit code: 0 for a clean run, 1 for a refused
 * start. Never throws for an expected failure shape.
 */
export async function runServe(
  argv: readonly string[],
  rawIo: ServeCliIo = DEFAULT_IO,
  opts: ServeCommandOptions = {},
): Promise<number> {
  // Guarded so a stderr failure reported as a diagnostic cannot re-enter
  // stderr (see `proxy/diagnostics.ts`: the orphaned-proxy 100% CPU loop).
  const io: ServeCliIo = { ...rawIo, stderr: guardDiagnostics(rawIo.stderr) }
  const resolved = resolveDefaults(opts)
  if ('error' in resolved) {
    io.stderr.write(`${resolved.error}\n\n${SERVE_USAGE}`)
    return EXIT_STARTUP_FAILURE
  }
  const parsed = parseServeFlags(argv, resolved.defaults)
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n\n${SERVE_USAGE}`)
    return EXIT_STARTUP_FAILURE
  }
  const flags = parsed.flags
  const journalDir = opts.journalDir ?? JOURNAL_DIR

  // Before the policy and the stores touch disk: a front that kept serving on
  // a damaged database would authorize agents out of state it cannot vouch
  // for, and journal into a file nobody can later prove anything about.
  if (!(await preflightDatabases(journalDir, io.stderr))) {
    return EXIT_STARTUP_FAILURE
  }

  const policyOutcome = await resolvePolicy(flags, io, opts, journalDir)
  if ('exitCode' in policyOutcome) {
    return policyOutcome.exitCode
  }

  const runtime = buildFront(flags, io, opts, policyOutcome.policy, journalDir)
  const { front } = runtime

  let bound: { port: number }
  try {
    bound = await front.listen(flags.port, flags.host)
  } catch (error: unknown) {
    io.stderr.write(describeBindFailure('serve', `${flags.host}:${flags.port}`, error))
    await front.close().catch(() => undefined)
    await runtime.residents.close().catch(() => undefined)
    return EXIT_STARTUP_FAILURE
  }

  io.stderr.write(`serve: listening on http://${flags.host}:${bound.port}\n`)
  // Only once the port is ours: residents are processes, and a run that could
  // not bind must not leave any behind.
  runtime.residents.start()
  await waitForShutdown(runtime, io, opts, { port: bound.port, host: flags.host })
  return 0
}

/**
 * RS10, in this order: seal the supervisor (a pool session closing from here
 * on closes its held sessions instead of handing them back), close the front
 * (every pool session goes), then stop reconciling and close every held
 * session. Without the seal, a pool closed by the front would return its
 * children to a supervisor that was about to stop looking.
 */
async function closeRuntime(runtime: ServeRuntime): Promise<void> {
  runtime.residents.seal()
  try {
    await runtime.front.close()
  } finally {
    await runtime.residents.close()
  }
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
  runtime: ServeRuntime,
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
    closing ??= closeRuntime(runtime)
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

