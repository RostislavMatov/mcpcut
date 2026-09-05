import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SIGKILL_ESCALATION_MS } from '../config.js'
import type { InstallConfig } from '../setup/schema.js'
import { START_READY_TIMEOUT_MS, type ServiceName } from './constants.js'
import { probeService } from './probe.js'

/**
 * The vocabulary of the service manager (mcpcut phase 1, Task 11; ADR-0012):
 * what a caller passes in, what it gets back, and the fully-resolved context
 * the individual steps (`manager-start.ts`, `manager-stop.ts`,
 * `manager-status.ts`) run on.
 *
 * Every result is a discriminated union, the shape `PidFileRead` and
 * `InitVaultResult` already use here: `start` has five honest outcomes and
 * `stop` has five, and a boolean or a thrown error would have to lie about
 * four of them. The CLI renders each of them (`format.ts`) without asking a
 * second question.
 */

/** Everything the manager needs, with a seam for every side effect. */
export interface ServiceManagerDeps {
  /** Data directory of this install: `run/` and both databases live under it. */
  readonly dataDir: string
  /** The install config — the single source of each service's bind and surface. */
  readonly config: InstallConfig
  /** The CLI a service is started from. Defaults to this build's `cli.js`. */
  readonly cliPath?: string
  /** The node binary that runs it. Defaults to the one running us. */
  readonly execPath?: string
  /** Environment handed to daemons, minus the owner token. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  readonly spawn?: typeof spawn
  readonly probe?: typeof probeService
  /**
   * Clock for stamping a pid record and for judging how old one is. It does
   * NOT drive the poll loops — a frozen test clock must not be able to wedge
   * one, and elapsed wall time is not a thing a caller gets to redefine.
   */
  readonly now?: () => Date
  readonly readyTimeoutMs?: number
  readonly killEscalationMs?: number
  readonly platform?: NodeJS.Platform
}

/**
 * What the manager can honestly say about a service.
 *
 * `running` requires BOTH a live pid and an answer on the port (see
 * `manager-status.ts`); `starting` is the same pid still inside its readiness
 * window; `stale` is a pid file that no longer describes a service we may
 * signal; `external` is an answer on the port that mcpcut did not start.
 */
export type ServiceState = 'running' | 'stopped' | 'stale' | 'starting' | 'external'

/** One service as `mcpcut status` shows it. */
export interface ServiceStatus {
  readonly service: ServiceName
  readonly state: ServiceState
  readonly host: string
  readonly port: number
  readonly pid?: number
  readonly startedAt?: string
  readonly logPath: string
  /** Why the state is what it is, whenever that is not obvious from the state. */
  readonly detail?: string
}

/** The outcome of `mcpcut start <service>`. */
export type StartResult =
  | { readonly kind: 'started'; readonly status: ServiceStatus }
  | { readonly kind: 'already-running'; readonly status: ServiceStatus }
  | { readonly kind: 'external'; readonly status: ServiceStatus }
  | { readonly kind: 'failed'; readonly reason: string; readonly logTail: readonly string[] }
  | { readonly kind: 'unsupported'; readonly reason: string }

/**
 * The outcome of `mcpcut stop <service>`.
 *
 * `stale-cleared` carries no pid when the pid file was unreadable — there was
 * no number in it to report, and inventing one (0, -1) would be a lie about a
 * process identifier.
 */
export type StopResult =
  | { readonly kind: 'stopped'; readonly pid: number; readonly forced: boolean }
  | { readonly kind: 'not-running' }
  | { readonly kind: 'stale-cleared'; readonly pid?: number; readonly detail?: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** The four verbs `mcpcut start|stop|status|logs` are built on. */
export interface ServiceManager {
  start(service: ServiceName): Promise<StartResult>
  stop(service: ServiceName): Promise<StopResult>
  status(service: ServiceName): Promise<ServiceStatus>
  logs(service: ServiceName, lines?: number): Promise<readonly string[]>
}

/** `ServiceManagerDeps` with every default filled in — what the steps receive. */
export interface ManagerContext {
  readonly dataDir: string
  readonly config: InstallConfig
  readonly cliPath: string
  readonly execPath: string
  readonly env: NodeJS.ProcessEnv
  readonly spawn: typeof spawn
  readonly probe: typeof probeService
  readonly now: () => Date
  readonly readyTimeoutMs: number
  readonly killEscalationMs: number
  readonly platform: NodeJS.Platform
}

/**
 * The CLI a service is spawned from: this build's own entry point, resolved
 * from the module URL rather than from `process.argv` or the cwd, so a
 * service started by `mcpcut` runs the same code as the `mcpcut` that started
 * it even when the shell's PATH says otherwise.
 */
const DEFAULT_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url))

/** Fills in every default once, so no step has to know what a default is. */
export function managerContextOf(deps: ServiceManagerDeps): ManagerContext {
  return {
    dataDir: deps.dataDir,
    config: deps.config,
    cliPath: deps.cliPath ?? DEFAULT_CLI_PATH,
    execPath: deps.execPath ?? process.execPath,
    env: deps.env ?? process.env,
    spawn: deps.spawn ?? spawn,
    probe: deps.probe ?? probeService,
    now: deps.now ?? (() => new Date()),
    readyTimeoutMs: deps.readyTimeoutMs ?? START_READY_TIMEOUT_MS,
    killEscalationMs: deps.killEscalationMs ?? SIGKILL_ESCALATION_MS,
    platform: deps.platform ?? process.platform,
  }
}

/** The address one service is configured to listen on. */
export function bindOf(config: InstallConfig, service: ServiceName): { readonly host: string; readonly port: number } {
  return service === 'ui' ? config.ui : config.serve
}
