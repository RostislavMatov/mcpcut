import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { errnoCodeOf } from '../errno.js'
import { createServiceManager, type ServiceManager, type ServiceManagerDeps } from '../services/manager.js'
import { checkBindExposure, checkPortFree } from '../setup/bind-checks.js'
import {
  checkDataDir,
  checkDatabases,
  checkPolicy,
  checkRunDir,
  describeErrno,
  formatCheck,
  type CheckResult,
} from '../setup/checks.js'
import { DATA_DIR_ENV_VAR, DEFAULT_DATA_DIR_NAME } from '../setup/constants.js'
import { defaultInstallConfig } from '../setup/defaults.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'
import { formatInstallConfigErrors, installConfigSchema, type InstallConfig } from '../setup/schema.js'
import { writeInstallConfig } from '../setup/write.js'
import { parseSetupArgs, SETUP_USAGE, type SetupArgs } from './setup-args.js'
import {
  configWritten,
  dataDirConflict,
  hostFault,
  INTERACTIVE_SETUP_PENDING,
  unusableConfigRefusal,
} from './setup-constants.js'
import { prepareAdmin, prepareSigningKey, prepareVault, startServices } from './setup-steps.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * `mcpcut setup --yes` (phase 1, Task 14): the one command that turns a host
 * into an install — an install config on disk, a prepared data directory, a
 * vault, a signing key, an owner, and optionally two running services.
 *
 * The order of the ten steps is the whole design. Every check runs and every
 * `fail` is reported BEFORE anything is written, so a refused run creates the
 * data directory (the first check has to prove it is writable) and nothing
 * else — no config, no vault, no signing key, no admin. And the owner is
 * minted BEFORE the first `ui` start (owner decision C6), so its one-time
 * token reaches a human on stdout instead of the daemon log the `ui` bootstrap
 * would have put it in.
 *
 * Interactive setup is a later wave (plan, "NOT Building"): without `--yes`
 * this command explains itself and exits 1.
 *
 * The io shape is declared structurally (`UiCliIo`) rather than imported from
 * `cli.ts`, the precedent `serve-constants.ts` set: no command module depends
 * on the dispatcher that routes it.
 */

export type { UiCliIo as SetupCliIo } from './ui-constants.js'

/** Test seams: every environment-, home- and clock-dependent input of the command. */
export interface SetupCliOptions {
  /** Environment carrying `MCPCUT_CONFIG`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Home directory the config path and the default data dir are built from. */
  readonly home?: string
  /** Overrides where the config is written; defaults to where it was looked for. */
  readonly configPath?: string
  /** Pre-read install config, so a caller reads the file exactly once. */
  readonly install?: InstallConfigLoad
  readonly managerDeps?: Partial<ServiceManagerDeps>
  readonly now?: () => Date
  /** Working directory a relative `--data-dir` is resolved against. */
  readonly cwd?: string
}

const DEFAULT_IO: UiCliIo = { stdout: process.stdout, stderr: process.stderr }

export async function runSetupCommand(
  args: readonly string[],
  io: UiCliIo = DEFAULT_IO,
  opts: SetupCliOptions = {},
): Promise<number> {
  const parsed = parseSetupArgs(args)
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n\n${SETUP_USAGE}`)
    return 1
  }
  if (!parsed.args.yes) {
    io.stderr.write(`${INTERACTIVE_SETUP_PENDING}\n${SETUP_USAGE}`)
    return 1
  }

  try {
    return await runPreparedSetup(parsed.args, io, opts)
  } catch (error: unknown) {
    // An errno is the host refusing and gets a line. Anything else is this
    // plane being wrong about itself and keeps its stack trace
    // (`keygen-cmd.ts` / `service-cmd.ts` form).
    if (errnoCodeOf(error) === undefined) throw error
    io.stderr.write(hostFault(describeErrno(error)))
    return 1
  }
}

/** The ten steps, once the invocation itself is known to be well formed. */
async function runPreparedSetup(
  args: SetupArgs,
  io: UiCliIo,
  opts: SetupCliOptions,
): Promise<number> {
  const context = resolveContext(opts)
  const config = prepareConfig(io, context, args)
  if (config === undefined) return 1

  // Who owns the processes comes from the config alone — the file this run is
  // about to write. There is no runtime override to reconcile it with (owner
  // decision 2026-09-05, ADR-0012 §9), so the manager `--start` uses and the
  // one a later `mcpcut start` builds cannot disagree.
  const manager = createServiceManager({
    dataDir: config.dataDir,
    config,
    env: context.env,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...opts.managerDeps,
  })
  if (!(await reportChecks(io, config, manager))) return 1

  await writeInstallConfig(context.configPath, config)
  io.stdout.write(configWritten(context.configPath))

  if (!(await prepareVault(io, config.dataDir))) return 1
  await prepareSigningKey(io, config.dataDir)
  if (!(await prepareAdmin(io, config.dataDir, args, opts.now))) return 1

  return await startServices(io, config, args, manager)
}

/**
 * The config this run would write: the existing one, the flags laid over it,
 * the environment checked against it, and the schema applied to the result.
 * `undefined` means the refusal has been printed and the run is over — before
 * anything on the host has been touched.
 */
function prepareConfig(
  io: UiCliIo,
  context: SetupContext,
  args: SetupArgs,
): InstallConfig | undefined {
  const base = baseConfigOf(context, args)
  if (!base.ok) {
    io.stderr.write(base.refusal)
    return undefined
  }

  const candidate = withFlags(base.config, args, context.cwd)
  const exported = context.env[DATA_DIR_ENV_VAR]
  if (exported !== undefined && exported !== '' && exported !== candidate.dataDir) {
    io.stderr.write(dataDirConflict(exported, candidate.dataDir))
    return undefined
  }
  return validate(io, candidate)
}

/** Everything the command needs to know about its surroundings, resolved once. */
interface SetupContext {
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly cwd: string
  readonly configPath: string
  readonly load: InstallConfigLoad
}

function resolveContext(opts: SetupCliOptions): SetupContext {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const load = opts.install ?? loadInstallConfigSync({ env, home })
  return {
    env,
    home,
    cwd: opts.cwd ?? process.cwd(),
    configPath: opts.configPath ?? load.path,
    load,
  }
}

type BaseConfig =
  | { readonly ok: true; readonly config: InstallConfig }
  | { readonly ok: false; readonly refusal: string }

/**
 * The config the flags are overlaid onto: the existing one when it is
 * readable, a fresh default otherwise.
 *
 * A config this build cannot read stops the run unless `--force` was given.
 * Silently replacing it would discard settings an operator deliberately
 * wrote — the exact opposite of what someone rerunning `setup` to add one
 * flag is asking for — and the file is the only copy of them.
 */
function baseConfigOf(context: SetupContext, args: SetupArgs): BaseConfig {
  if (context.load.kind === 'ok') return { ok: true, config: context.load.config }
  if (context.load.kind === 'invalid' && !args.force) {
    return { ok: false, refusal: unusableConfigRefusal(context.load.path, context.load.problems) }
  }
  return { ok: true, config: defaultInstallConfig(join(context.home, DEFAULT_DATA_DIR_NAME)) }
}

/**
 * The base config with the flags the operator actually typed laid over it.
 * Immutable throughout: a rerun that passes `--ui-port` alone must keep the
 * `behindTls`, `allowedHosts` and `trustedProxyHeader` an earlier run wrote,
 * so every field that was not asked about is carried across untouched.
 */
function withFlags(base: InstallConfig, args: SetupArgs, cwd: string): InstallConfig {
  return {
    ...base,
    // `resolve` returns an absolute path unchanged, so this is the one branch
    // that handles both spellings of `--data-dir`.
    ...(args.dataDir !== undefined ? { dataDir: resolve(cwd, args.dataDir) } : {}),
    ui: {
      ...base.ui,
      ...(args.uiHost !== undefined ? { host: args.uiHost } : {}),
      ...(args.uiPort !== undefined ? { port: args.uiPort } : {}),
      // Written whenever the operator said either word: `--behind-tls` is
      // remembered in the file, so `--no-behind-tls` has to be able to write
      // the `false` that takes it back.
      ...(args.behindTls !== undefined ? { behindTls: args.behindTls } : {}),
    },
    serve: {
      ...base.serve,
      ...(args.serveHost !== undefined ? { host: args.serveHost } : {}),
      ...(args.servePort !== undefined ? { port: args.servePort } : {}),
    },
    ...(args.supervisor !== undefined ? { supervisor: args.supervisor } : {}),
  }
}

/**
 * The last gate before anything is written: the same schema every reader
 * applies, so `setup` can never produce a config the next command refuses.
 * `undefined` means the problems have been printed and the run is over.
 */
function validate(io: UiCliIo, candidate: InstallConfig): InstallConfig | undefined {
  const validated = installConfigSchema.safeParse(candidate)
  if (validated.success) return validated.data
  for (const problem of formatInstallConfigErrors(validated.error)) {
    io.stderr.write(`${problem}\n`)
  }
  return undefined
}

/**
 * Runs the preflight, printing each row as it completes, and stops at the
 * first `fail`.
 *
 * Stopping early is deliberate. The checks are ordered outward from the most
 * fundamental one, and a later answer is only meaningful once the earlier
 * ones hold: "no databases yet" says nothing useful about a data directory
 * this uid cannot write. A `warn` never stops anything — the non-interactive
 * path has no dialog to confirm through, and a warning that refused would
 * leave `--yes` unable to complete a deliberate public bind at all.
 */
async function reportChecks(
  io: UiCliIo,
  config: InstallConfig,
  manager: ServiceManager,
): Promise<boolean> {
  for (const check of checksOf(config, manager)) {
    const result = await check()
    io.stdout.write(`${formatCheck(result)}\n`)
    if (result.level === 'fail') return false
  }
  return true
}

/** The preflight, in the order the transcript shows it. Lazy, so a refusal skips the rest. */
function checksOf(
  config: InstallConfig,
  manager: ServiceManager,
): ReadonlyArray<() => Promise<CheckResult>> {
  return [
    () => checkDataDir(config.dataDir),
    // Right after the directory it lives in, and before anything is written:
    // the manager refuses to start a service whose `run/` is not owner-only,
    // so `setup` says it first (SEC-H1).
    () => checkRunDir(config.dataDir),
    () => bindCheck(manager, 'ui', config.ui.host, config.ui.port),
    () => bindCheck(manager, 'serve', config.serve.host, config.serve.port),
    () => checkDatabases(config.dataDir),
    () => checkPolicy(config.dataDir),
    async () => checkBindExposure('ui', config.ui.host, config.ui.behindTls === true),
    // `serve` has no TLS-termination flag of its own: agent bearer tokens
    // travel in clear on that front whatever sits in front of it.
    async () => checkBindExposure('serve', config.serve.host, false),
  ]
}

/**
 * "Can this service bind its address?" — with one exception: a service the
 * manager already reports as `running` holds that port itself, and rerunning
 * `setup` while the services are up is a normal thing to do (adding an
 * allowed host, say). Reporting the install's own daemon as a conflict would
 * make every such rerun fail.
 */
async function bindCheck(
  manager: ServiceManager,
  service: 'ui' | 'serve',
  host: string,
  port: number,
): Promise<CheckResult> {
  const status = await manager.status(service)
  if (status.state === 'running') {
    return { name: `${service} bind`, level: 'ok', detail: `${host}:${port} (already running)` }
  }
  return await checkPortFree(service, host, port)
}
