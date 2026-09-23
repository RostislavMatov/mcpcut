import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR, SYSTEM_ENV_ALLOWLIST } from '../config.js'
import {
  MAX_CONCURRENT_SESSIONS,
  POOL_ROUTE_TARGET,
} from '../transport/http/server-constants.js'
import { createEffectiveAgentReader } from '../agents/effective-reader.js'
import { PRODUCT_VERSION } from '../brand.js'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import { mapPolicyProvider, type PolicyProvider } from '../policy/reload.js'
import { resolvePolicySource } from '../policy/source.js'
import type { Policy } from '../policy/schema.js'
import { journalingOnlyPolicy } from './connect-policy.js'
import { createAwaitingPolicy, createReloadingPolicy } from './policy-reload.js'
import { guardDiagnostics } from '../proxy/diagnostics.js'
import { createGroupsStore, type GroupsStore } from '../groups/store.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import {
  InvalidBindEnvError,
  resolveServeDefaults,
  type ServeServiceDefaults,
} from '../setup/bind.js'
import { loadInstallConfigSync } from '../setup/load.js'
import { preflightDatabases } from '../store/preflight.js'
import { createHttpFront, type HttpFront } from '../transport/http/server.js'
import { isRejectedOriginFlagValue } from '../net/origin-host.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import { createVaultStore, type VaultStore } from '../vault/store.js'
import { ulid } from 'ulid'
import { MAX_TCP_PORT, SERVE_USAGE, type ServeCliIo } from './serve-constants.js'
import { describeBindFailure } from './bind-failure.js'
import { createChildSessionOpener, type ChildSessionDeps } from './serve-child.js'
import { createServeHooks, poolResponseCorrelation } from './serve-hooks.js'
import { createPoolSessionFactory } from './serve-pool.js'
import { MAX_POOL_CHILD_SESSIONS } from '../pool/constants.js'
import { createServeSessionFactory } from './serve-runtime.js'
import { AGENT_REVOCATION_POLL_INTERVAL_MS } from '../session/constants.js'

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
  readonly agents?: Pick<AgentsStore, 'getAgent' | 'findAgentByToken'>
  /** Group source for effective grants (M5.5 п.2); defaults to `<journalDir>/state.db`. */
  readonly groups?: Pick<GroupsStore, 'groupsOf'>
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
  /**
   * How long ONE upstream may take to answer a pool catalog fan-out before it
   * is detached. Tests shorten it; nothing else should — `POOL_FANOUT_TIMEOUT_MS`
   * is the value the product ships with.
   */
  readonly poolFanoutTimeoutMs?: number
  /**
   * Concurrently open sessions this front allows, counting a pool's children
   * (plan decision P5). A test seam like the two above: driving the real
   * ceiling would need 64 upstreams, and the point under test is that the
   * children are COUNTED, not what the number is.
   */
  readonly maxSessions?: number
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Signals that trigger a graceful shutdown. `[]` installs none (tests). */
  readonly signals?: readonly NodeJS.Signals[]
  /** Called once the socket is bound, with the handle that can shut it down. */
  readonly onListening?: (handle: ServeHandle) => void
  /**
   * What every absent flag falls back to (phase 1, task 5). Defaults to the
   * environment-plus-install-config resolution; injected by tests and by any
   * caller that already read the config.
   */
  readonly bindDefaults?: ServeServiceDefaults
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
function parseServeFlags(argv: readonly string[], defaults: ServeServiceDefaults): FlagResult {
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
  return buildServeFlags(values, defaults)
}

/**
 * Merges the parsed flags over `defaults` (phase 1, task 5): a flag the
 * operator typed always wins, and only a flag that is absent takes the
 * configured value. For the repeatable flags "absent" means "not given once" —
 * a single `--allowed-host` replaces the configured list rather than adding to
 * it, so what the command line says is what the front screens against.
 */
function buildServeFlags(
  values: Record<string, unknown>,
  defaults: ServeServiceDefaults,
): FlagResult {
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
  const flagHosts = Array.isArray(values['allowed-host'])
    ? (values['allowed-host'] as string[])
    : undefined
  const policyPath = typeof values['policy'] === 'string' ? values['policy'] : defaults.policy

  return {
    flags: {
      port,
      host,
      policyPath,
      // `--fail-closed` only ever turns fail-closed ON (see `applyFailClosed`),
      // so a config that asks for it cannot be softened by omitting the flag.
      failClosed: values['fail-closed'] === true ? true : (defaults.failClosed ?? false),
      allowedOrigins: flagOrigins ?? defaults.allowedOrigins ?? [],
      allowedHosts: flagHosts ?? defaults.allowedHosts ?? [],
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
): HttpFront {
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

  /**
   * Child sessions of every live pool. They cost an upstream each, so the
   * front's own ceiling has to see them (plan decision P5) — without this one
   * agent with broad grants would walk straight past `MAX_CONCURRENT_SESSIONS`.
   *
   * Counting them is only half of it: the front reserves a slot when a
   * top-level session OPENS, and a pool grows later, so the pool must also
   * CLAIM before opening each child. `reserveChildSlot` below is that claim,
   * and it is why the front is held in a variable — the factory is built
   * before it.
   */
  let poolChildCount = 0
  /**
   * Child opens decided but not yet counted in `poolChildCount` — across EVERY
   * pool, which is the point. `activeSessionCount()` sees a child only once its
   * transport is up, so without a shared claim two pools growing at once each
   * saw room and both took it. This is `createSlotCounter`'s discipline applied
   * to the one budget that lives outside the session manager.
   */
  let poolChildrenOpening = 0
  let front: HttpFront | null = null
  const maxSessions = opts.maxSessions ?? MAX_CONCURRENT_SESSIONS

  /**
   * Claims one child slot against both ceilings, or refuses. Synchronous and
   * cheap by contract: it runs inside the children registry's loop, before any
   * await, exactly as the front's own `reserve()` does.
   *
   * No front yet means no. A pool can only be opened by a request the front
   * accepted, so that is unreachable — but a ceiling whose unknown state reads
   * as "room available" fails open, and this one bounds spawned processes.
   */
  function reserveChildSlot(held: number): { release(): void } | null {
    if (front === null || held >= MAX_POOL_CHILD_SESSIONS) {
      return null
    }
    if (front.activeSessionCount() + poolChildrenOpening >= maxSessions) {
      return null
    }
    poolChildrenOpening += 1
    let isReleased = false
    return {
      release: () => {
        if (isReleased) return
        isReleased = true
        poolChildrenOpening -= 1
      },
    }
  }
  const openPool = createPoolSessionFactory({
    ...shared,
    registry,
    handoff: hooks.handoff,
    // One opener per pool session, each reporting the exact vault values its
    // children were handed so that pool's own journal can redact by value.
    childSessionOpenerFor: (onSecrets) =>
      createChildSessionOpener({
        ...shared,
        upstream: {
          ...shared.upstream,
          resolveRefs: async (record) => {
            const result = await shared.upstream.resolveRefs(record)
            if (result.status === 'resolved') {
              onSecrets(Object.values(result.values))
            }
            return result
          },
        },
      }),
    correlate: poolResponseCorrelation,
    planeVersion: PRODUCT_VERSION,
    revocationPollIntervalMs: opts.revocationPollIntervalMs ?? AGENT_REVOCATION_POLL_INTERVAL_MS,
    onChildCountChange: (delta) => {
      poolChildCount += delta
    },
    reserveChild: (held) => reserveChildSlot(held),
    ...(opts.poolFanoutTimeoutMs !== undefined
      ? { fanoutTimeoutMs: opts.poolFanoutTimeoutMs }
      : {}),
  })

  front = createHttpFront({
    agentsStore: agentReader,
    maxSessions,
    // The pool address arrives with a reserved `serverName` no registry name
    // could ever be (`POOL_ROUTE_TARGET` starts with `_`), so one comparison
    // separates the two modes with no second parse of the route.
    openSession: (ctx) =>
      ctx.serverName === POOL_ROUTE_TARGET ? openPool(ctx) : openPerServer(ctx),
    extraSessions: () => poolChildCount,
    detectInitialize: hooks.detectInitialize,
    validateStatelessHeaders: hooks.validateStatelessHeaders,
    expectsResponse: hooks.expectsResponse,
    allowedOrigins: flags.allowedOrigins,
    allowedHosts: flags.allowedHosts,
    stderr: io.stderr,
  })
  return front
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

