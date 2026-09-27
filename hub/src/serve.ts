import { openAccountsDb } from './accounts-db.js'
import { loadHubConfig, type HubConfig } from './config.js'
import { createGithubClient } from './github.js'
import type { Orchestrator } from './orchestrator.js'
import { openOrchestrator } from './orchestrator-http.js'
import { createHubServer } from './server.js'

/**
 * `hub serve` (plan Task 5): load and validate the config (fail fast, every
 * problem on its own line), open `hub.db`, build the GitHub client, listen,
 * and hold until `shutdown` resolves.
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
  try {
    const { port } = await server.listen(config.port, config.host)
    announce(io, config, port, opened.orchestrator, io.orchestrator === undefined)
    await io.shutdown
    return EXIT_OK
  } finally {
    await server.close()
    opened.close()
    github.close()
    db.handle.close()
  }
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
