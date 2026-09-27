import { openAccountsDb } from './accounts-db.js'
import { loadHubConfig, type HubConfig } from './config.js'
import { createGithubClient } from './github.js'
import { DEFAULT_SWEEP_SCHEDULE, scheduleSweeps, type SweepSchedule, type SweepScheduler } from './idle-sweeper.js'
import type { Orchestrator } from './orchestrator.js'
import { openOrchestrator } from './orchestrator-http.js'
import { createHubServer, type HubServer } from './server.js'

/**
 * `hub serve` (plan Task 5): load and validate the config (fail fast, every
 * problem on its own line), open `hub.db`, build the GitHub client, listen,
 * and hold until `shutdown` resolves.
 *
 * Once listening, and only with an available orchestrator, the `pending`
 * accounts an earlier run left are settled against the provisioner in the
 * background (plan `hosted-path-and-ops`, P4 — `provisioning.ts`), and the
 * idle sweeper runs a minute later and every six hours after (P5/P6 —
 * `idle-sweeper.ts`; each sweep settles `pending` rows again too). Its timer
 * never keeps the process alive and stops before the server closes.
 *
 * The orchestrator (plan `tenant-orchestrator`, Task 5): the provisioner's
 * HTTP API when `HUB_PROVISIONER_URL` and `HUB_PROVISIONER_TOKEN_FILE` are
 * set, `unavailableOrchestrator` (waitlist mode) when they are not — and a
 * caller-supplied one, when given, over both (the tests' seam). Nothing here
 * knows what an install is.
 */

export interface ServeIo {
  readonly env: NodeJS.ProcessEnv
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Overrides the configured orchestrator (tests); omitted, the config decides. */
  readonly orchestrator?: Orchestrator
  /** Resolves when the process should stop (SIGINT/SIGTERM in production). */
  readonly shutdown: Promise<void>
  readonly clock?: () => number
  /** Overrides when the idle sweeper runs (tests); omitted, `DEFAULT_SWEEP_SCHEDULE`. */
  readonly sweepSchedule?: SweepSchedule
  /** Overrides what runs the idle sweeper on that schedule (tests drive sweeps by hand); omitted, `scheduleSweeps`. */
  readonly sweepScheduler?: SweepScheduler
}

const CALLBACK_PATH = '/auth/github/callback'
const EXIT_OK = 0
const EXIT_CONFIG = 1

export async function runServe(io: ServeIo): Promise<number> {
  const loaded = loadHubConfig({ env: io.env })
  if (loaded.kind === 'invalid') {
    for (const problem of loaded.problems) io.stderr(`hub: ${problem}\n`)
    return EXIT_CONFIG
  }
  const { config } = loaded
  const db = await openAccountsDb(config.dataDir)
  const github = createGithubClient({
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
    // The registered callback, built from configuration — never from a request.
    redirectUri: `${config.publicUrl}${CALLBACK_PATH}`,
  })
  const log = (line: string): void => io.stderr(`${line}\n`)
  const opened = io.orchestrator === undefined ? openOrchestrator(config.provisioner) : { orchestrator: io.orchestrator, close: () => undefined }
  const server = createHubServer({
    config,
    db,
    github,
    orchestrator: opened.orchestrator,
    log,
    ...(io.clock === undefined ? {} : { clock: io.clock }),
  })
  let sweeps: { stop(): void } | undefined
  try {
    const { port } = await server.listen(config.port, config.host)
    announce(io, config, port, opened.orchestrator, io.orchestrator === undefined)
    if (opened.orchestrator.available) sweeps = startBackgroundWork(io, server)
    await io.shutdown
    return EXIT_OK
  } finally {
    sweeps?.stop()
    await server.close()
    // Closing the orchestrator cuts its sockets, so background tasks settle
    // at once; the bound only guards a caller-supplied one that never does.
    opened.close()
    await settledWithin(server.settled(), SHUTDOWN_SETTLE_MS)
    github.close()
    db.handle.close()
  }
}

/** P4 at once and the idle sweeper on its schedule (P5/P6), both in the background: the hub answers meanwhile. */
function startBackgroundWork(io: ServeIo, server: HubServer): { stop(): void } {
  void server.reconcilePending()
  const schedule = io.sweepSchedule ?? DEFAULT_SWEEP_SCHEDULE
  const sweeps = (io.sweepScheduler ?? scheduleSweeps)(() => server.sweep(), schedule)
  io.stdout(`[hub] idle sweep: first in ${durationOf(schedule.firstDelayMs)}, then every ${durationOf(schedule.intervalMs)}\n`)
  return sweeps
}

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** `6 h`, `1 min`, `20 ms` — whichever unit divides the duration. */
function durationOf(ms: number): string {
  if (ms % MS_PER_HOUR === 0) return `${ms / MS_PER_HOUR} h`
  if (ms % MS_PER_MINUTE === 0) return `${ms / MS_PER_MINUTE} min`
  return `${ms} ms`
}

/** How long shutdown waits for background install tasks before closing `hub.db` under them. */
const SHUTDOWN_SETTLE_MS = 5_000

async function settledWithin(settled: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref()
  })
  await Promise.race([settled, bound])
  clearTimeout(timer)
}

/**
 * Trusting `CF-Connecting-IP` is only safe while the origin answers nothing
 * but Cloudflare; the flag cannot check that, so the operator hears it on
 * every start (security review: a direct hit on the origin forges the header).
 */
const TRUST_CF_WARNING =
  'warning: HUB_TRUST_CF_CONNECTING_IP=1 trusts the CF-Connecting-IP header — turn on Cloudflare Authenticated Origin Pulls (docs/deploy/site/Caddyfile), or anyone reaching the origin directly can forge it and bypass the per-IP sign-up limit'

function announce(io: ServeIo, config: HubConfig, port: number, orchestrator: Orchestrator, fromConfig: boolean): void {
  io.stdout(`[hub] listening on http://${config.host}:${port} for ${config.publicUrl}\n`)
  if (!orchestrator.available) {
    io.stdout('[hub] orchestrator not available: every new sign-in joins the waitlist (set HUB_PROVISIONER_URL and HUB_PROVISIONER_TOKEN_FILE to create installs)\n')
  } else if (fromConfig && config.provisioner !== undefined) {
    io.stdout(`[hub] orchestrator: the provisioner at ${config.provisioner.url}\n`)
  }
  if (config.trustCfConnectingIp) io.stderr(`${TRUST_CF_WARNING}\n`)
}
