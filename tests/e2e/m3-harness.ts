import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { dispatch, type CliIo, type DispatchOptions } from '../../src/cli.js'
import type { ConnectDeps } from '../../src/cli/connect-cmd.js'
import type { ServeCommandOptions, ServeHandle } from '../../src/cli/serve-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import { INVENTORY_FILE_NAME } from '../../src/policy/inventory.js'
import { createConnectStdio, type ConnectStdio } from '../cli/connect-harness.js'
import { waitUntil } from '../proxy/harness.js'

/**
 * Plumbing for `tests/e2e/m3-integration.test.ts`.
 *
 * The one rule this harness exists to enforce: **every command goes through
 * `dispatch()`**, exactly as the `mcpcut` binary routes it, with each
 * store redirected into one temp directory through the `DispatchOptions`
 * seams. Nothing here reaches into a store module directly — an e2e that
 * seeded `agents.json` itself would stop proving that the documented CLI
 * scenario works.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

export const POLICY_SERVER_FIXTURE = join(__dirname, '../fixtures/policy-server.mjs')
/**
 * The stdio fixture that answers a SESSIONFUL revision. A pool opens a
 * handshake of its own to every upstream (ADR-0015 §4), which the older
 * fixtures — all of which answer with the revision that REMOVED the handshake
 * — cannot complete. Its tool names come from argv.
 */
export const POOL_SERVER_FIXTURE = join(__dirname, '../fixtures/pool-server.mjs')
export const ENV_ECHO_FIXTURE = join(__dirname, '../fixtures/env-echo-server.mjs')
export const HTTP_STATELESS_FIXTURE = join(__dirname, '../fixtures/http-server-stateless.mjs')

/** Revocation/approval polling in tests: short enough to be quick, long enough not to spin. */
export const POLL_INTERVAL_MS = 25

export interface CliRun {
  readonly code: number
  readonly out: string
  readonly err: string
}

export interface Plane {
  readonly journalDir: string
  /** Runs one CLI command through `dispatch()` with this plane's isolation seams. */
  run(argv: readonly string[], extra?: DispatchOptions): Promise<CliRun>
  /** Everything every command run in this plane has written to stdout / stderr. */
  allOut(): string
  allErr(): string
  /** The seams themselves, for a caller that has to extend one (extra deps). */
  readonly seams: DispatchOptions
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Per-key shallow merge of `extra` over `base`; neither input is mutated. */
function mergeOptions(base: DispatchOptions, extra: DispatchOptions): DispatchOptions {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value
  }
  return merged as DispatchOptions
}

/**
 * Builds the dispatch seams that point every store, queue and policy lookup
 * at `journalDir`. `loadPolicy` is pinned to the temp dir on purpose: without
 * it a run would discover the repository's own `./.mcpcut-project/policy.json`
 * and the test would depend on a file it does not own.
 */
function seamsFor(journalDir: string): DispatchOptions {
  const loadPolicy = { cwd: journalDir, journalDir, env: {} }
  return {
    journalDir,
    // `server add|remove` are owner-only since 2026-09-18, so this seam needs
    // the same isolation from the developer's shell as the ones below.
    server: { journalDir, env: {} },
    // `env: {}` keeps a token exported in the developer's own shell out of the
    // command under test; `asOwner()` puts this plane's own token back in.
    vault: { journalDir, env: {} },
    agent: { journalDir, env: {} },
    // `env: {}` for the same reason as the seams above: since the owner
    // decision of 2026-09-06 `admin *` resolves `MCP_ADMIN_TOKEN` too, and a
    // token exported in the developer's shell must not reach it.
    admin: { journalDir, env: {} },
    // `journalDir` here is where `approvals approve|deny` looks up the admin
    // behind `MCP_ADMIN_TOKEN`; `env: {}` keeps a token exported in the
    // developer's own shell from reaching the command under test.
    approvals: { baseDir: join(journalDir, 'approvals'), journalDir, env: {} },
    quarantine: { storePath: join(journalDir, INVENTORY_FILE_NAME) },
    connect: { journalDir, env: {}, loadPolicy },
    serve: { journalDir, signals: [], loadPolicy, revocationPollIntervalMs: POLL_INTERVAL_MS },
  }
}

/** A control plane whose whole state lives in `journalDir`, driven only through `dispatch()`. */
export function createPlane(journalDir: string): Plane {
  const seams = seamsFor(journalDir)
  const outChunks: string[] = []
  const errChunks: string[] = []

  const run = async (argv: readonly string[], extra: DispatchOptions = {}): Promise<CliRun> => {
    const out: string[] = []
    const err: string[] = []
    const io: CliIo = {
      stdout: {
        write: (chunk: string) => {
          out.push(chunk)
          return outChunks.push(chunk)
        },
      },
      stderr: {
        write: (chunk: string) => {
          err.push(chunk)
          return errChunks.push(chunk)
        },
      },
    }
    const code = await dispatch([...argv], io, mergeOptions(seams, extra))
    return { code, out: out.join(''), err: err.join('') }
  }

  return {
    journalDir,
    run,
    allOut: () => outChunks.join(''),
    allErr: () => errChunks.join(''),
    seams,
  }
}

/** Fails loudly with the command's own diagnostics rather than a bare exit code. */
function expectOk(argv: readonly string[], result: CliRun): CliRun {
  if (result.code !== 0) {
    throw new Error(`"mcpcut ${argv.join(' ')}" exited ${result.code}: ${result.err}`)
  }
  return result
}

/** Writes a policy document into the plane's directory and returns its path. */
export async function writePolicyFile(
  plane: Plane,
  document: Record<string, unknown>,
): Promise<string> {
  const path = join(plane.journalDir, 'policy.json')
  await writeFile(path, JSON.stringify({ version: 1, ...document }), 'utf8')
  return path
}

export function decisionsOf(records: readonly JournalRecord[]): JournalRecord[] {
  return records.filter((record) => record.kind === 'decision')
}

/** The token a `create`/`add` command printed, or a loud failure if it printed none. */
function tokenFrom(result: CliRun, command = 'agent create'): string {
  const token = /^token: (\S+)$/m.exec(result.out)?.[1]
  if (token === undefined) {
    throw new Error(`"${command}" printed no token: ${result.out}`)
  }
  return token
}

/**
 * Onboards a named admin through `admin add` and returns the seam that makes a
 * later `approvals approve|deny` run AS that admin.
 *
 * Since M5 wave 2 (owner decision O3) a resolution made from the shell carries
 * `actor: cli:<adminName>`, read from a personal token in `MCP_ADMIN_TOKEN` —
 * so an e2e that resolves an approval must onboard an admin exactly the way an
 * operator would, through the CLI, not by seeding the store.
 */
export async function createCliApprover(
  plane: Plane,
  name: string,
  role: AdminRole = 'operator',
): Promise<DispatchOptions> {
  // Since the owner decision of 2026-09-06 only the FIRST admin of an empty
  // store may be created without a token, so this plane's owner is minted
  // first (that bootstrap) and this admin is created AS that owner — which is
  // what an operator would do too.
  const owner = await asOwner(plane)
  const argv = ['admin', 'add', name, '--role', role]
  const token = tokenFrom(expectOk(argv, await plane.run(argv, owner)), 'admin add')
  return { approvals: { env: { [ADMIN_TOKEN_ENV_VAR]: token } } }
}

/** The admin every `agent` mutation in an e2e runs as (owner decision T4). */
export const CLI_OWNER = 'cli-owner'

/** One owner per plane, minted lazily; the promise is memoized, so never twice. */
const ownerSeams = new WeakMap<Plane, Promise<DispatchOptions>>()

/**
 * The seam that makes `agent create|grant|ungrant|revoke` — and, since owner
 * decision S2 (2026-09-03), `vault set|remove|rekey` — run AS a named owner.
 * Since owner decision T4 (2026-09-01) every personal-grant mutation needs a
 * token, so an e2e must onboard an admin exactly the way an operator would —
 * through `admin add` — rather than seeding the store.
 */
export function asOwner(plane: Plane): Promise<DispatchOptions> {
  const existing = ownerSeams.get(plane)
  if (existing !== undefined) return existing
  const seam = mintOwner(plane)
  ownerSeams.set(plane, seam)
  return seam
}

async function mintOwner(plane: Plane): Promise<DispatchOptions> {
  // The bootstrap `admin add`: the store is empty the first time this runs,
  // which is the one path that needs no token (2026-09-06).
  const argv = ['admin', 'add', CLI_OWNER, '--role', 'owner']
  const token = tokenFrom(expectOk(argv, await plane.run(argv)), 'admin add')
  const env = { [ADMIN_TOKEN_ENV_VAR]: token }
  return { server: { env }, agent: { env }, vault: { env }, admin: { env } }
}

/** `agent create` + `agent grant` for a server that is already registered. */
export async function createGrantedAgent(
  plane: Plane,
  agentName: string,
  serverName: string,
  tools?: string,
): Promise<string> {
  const owner = await asOwner(plane)
  const createArgv = ['agent', 'create', agentName]
  const token = tokenFrom(expectOk(createArgv, await plane.run(createArgv, owner)))
  const grantArgv = [
    'agent',
    'grant',
    agentName,
    serverName,
    ...(tools !== undefined ? ['--tools', tools] : []),
  ]
  expectOk(grantArgv, await plane.run(grantArgv, owner))
  return token
}

/** One JSON-RPC request body, as an HTTP agent posts it. */
export function rpcBody(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

export interface PostMcpArgs {
  readonly url: string
  readonly token: string
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}

/** POSTs one MCP message to a `serve` endpoint under the agent's bearer token. */
export function postMcp(args: PostMcpArgs): Promise<Response> {
  return fetch(args.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.token}`,
      'content-type': 'application/json',
      ...args.headers,
    },
    body: args.body,
  })
}

export interface OnboardingArgs {
  readonly serverName: string
  readonly agentName: string
  /** stdio server command and argv, as `server add --command/--args` take them. */
  readonly command: string
  readonly args: readonly string[]
  /** `--env K=V` pairs; a value may be a `vault:<name>` reference. */
  readonly env?: Readonly<Record<string, string>>
  /** Secret to put in the vault before the server needs it. */
  readonly secret?: { readonly name: string; readonly value: string }
  /** `--tools` argument of `agent grant`; omitted grants every tool. */
  readonly tools?: string
}

/**
 * The documented onboarding scenario, command for command (plan "Validation",
 * README "Registry, agents, vault"): `vault init` → `server add` →
 * `vault set` → `agent create` → `agent grant`. Returns the agent token,
 * which `agent create` prints exactly once.
 */
export async function runOnboarding(plane: Plane, args: OnboardingArgs): Promise<string> {
  expectOk(['vault', 'init'], await plane.run(['vault', 'init']))
  // Every write below runs as the plane's owner: `server add` since the owner
  // decision of 2026-09-18, `vault set` since S2, `agent create|grant` since T4.
  const owner = await asOwner(plane)

  const addArgv = [
    'server',
    'add',
    args.serverName,
    '--transport',
    'stdio',
    '--command',
    args.command,
    '--args',
    args.args.join(','),
    ...Object.entries(args.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
  ]
  expectOk(addArgv, await plane.run(addArgv, owner))

  if (args.secret !== undefined) {
    const setArgv = ['vault', 'set', args.secret.name]
    const value = args.secret.value
    expectOk(
      setArgv,
      // The value arrives on stdin, never in argv (which `ps` exposes) — the
      // injected reader is the same seam the real command reads stdin through.
      await plane.run(setArgv, {
        vault: { ...owner.vault, readSecretInput: () => Promise.resolve(value) },
      }),
    )
  }

  return createGrantedAgent(plane, args.agentName, args.serverName, args.tools)
}

export interface ConnectRunArgs {
  readonly plane: Plane
  readonly argv: readonly string[]
  readonly token: string
  readonly sessionId: string
  readonly deps?: Partial<ConnectDeps>
}

export interface ConnectDriver {
  readonly stdio: ConnectStdio
  /** Resolves once the session has ended, with the command's exit code and output. */
  readonly done: Promise<CliRun>
}

/**
 * Starts `mcpcut connect` through `dispatch()` against an injected
 * client stdio pair — the same shape a real agent's process gives it.
 */
export function startConnect(args: ConnectRunArgs): ConnectDriver {
  const stdio = createConnectStdio()
  const done = args.plane.run(args.argv, {
    connect: {
      env: { MCP_AGENT_TOKEN: args.token, PATH: process.env['PATH'] ?? '' },
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      stderr: stdio.clientStderr,
      sessionId: args.sessionId,
      revocationPollIntervalMs: POLL_INTERVAL_MS,
      childExitGraceMs: 1000,
      killEscalationMs: 500,
      ...args.deps,
    },
  })
  return { stdio, done }
}

export interface ConnectOutcome extends CliRun {
  readonly stdio: ConnectStdio
  readonly messages: Array<Record<string, unknown>>
}

/**
 * Drives one whole connect session: each line is written only after the
 * previous one has been answered (a later request may depend on what an
 * earlier *response* taught the plane — e.g. the tool catalog), then the
 * client's end of the pipe is closed.
 */
export async function runConnectLines(
  args: ConnectRunArgs & { readonly lines: readonly string[]; readonly expectedResponses?: number },
): Promise<ConnectOutcome> {
  const driver = startConnect(args)
  for (const [index, line] of args.lines.entries()) {
    driver.stdio.clientOutbox.write(line)
    if (args.expectedResponses === undefined) {
      await waitUntil(() => driver.stdio.lineCount() >= index + 1)
    }
  }
  if (args.expectedResponses !== undefined) {
    await waitUntil(() => driver.stdio.lineCount() >= args.expectedResponses!)
  }
  driver.stdio.clientOutbox.end()
  const run = await driver.done
  return { ...run, stdio: driver.stdio, messages: driver.stdio.messages() }
}

export interface WrapBaselineArgs {
  readonly plane: Plane
  readonly sessionId: string
  readonly command: string
  readonly args: readonly string[]
  readonly lines: readonly string[]
  readonly expectedResponses: number
}

/**
 * Runs the same lines through the M1 ad-hoc path (`wrap --no-policy`: no
 * registry, no agent, pure relay) and returns its client stdio, so a session
 * that gated nothing can be compared against it byte for byte.
 */
export async function runWrapBaseline(args: WrapBaselineArgs): Promise<ConnectStdio> {
  const stdio = createConnectStdio()
  const done = args.plane.run(['wrap', '--no-policy', '--', args.command, ...args.args], {
    wrap: {
      runWrap: {
        dir: args.plane.journalDir,
        sessionId: args.sessionId,
        stdin: stdio.clientOutbox,
        stdout: stdio.clientStdout,
        stderr: stdio.clientStderr,
      },
    },
  })
  for (const line of args.lines) {
    stdio.clientOutbox.write(line)
  }
  await waitUntil(() => stdio.lineCount() >= args.expectedResponses)
  stdio.clientOutbox.end()
  expectOk(['wrap'], await done)
  return stdio
}

export interface ServeRun {
  readonly port: number
  /** The URL an HTTP agent posts to for one (agent, server) pair. */
  endpoint(agent: string, server: string): string
  /** The pool address: one URL per agent, with the agent named by its token (PE5). */
  poolEndpoint(): string
  /** Shuts the front down and resolves with the `serve` command's own result. */
  shutdown(): Promise<CliRun>
}

/** Starts `mcpcut serve` through `dispatch()` on an ephemeral port. */
export async function startServe(
  plane: Plane,
  argv: readonly string[] = [],
  extra: ServeCommandOptions = {},
): Promise<ServeRun> {
  let handle: ServeHandle | undefined
  const done = plane.run(['serve', '--port', '0', ...argv], {
    serve: {
      ...extra,
      onListening: (started) => {
        handle = started
      },
    },
  })
  done.catch(() => undefined)
  await waitUntil(() => handle !== undefined)
  const started = handle as ServeHandle

  let isShutDown = false
  return {
    port: started.port,
    endpoint: (agent, server) =>
      `http://127.0.0.1:${started.port}/agents/${agent}/servers/${server}`,
    poolEndpoint: () => `http://127.0.0.1:${started.port}${POOL_ROUTE_PATH}`,
    shutdown: async () => {
      if (!isShutDown) {
        isShutDown = true
        await started.shutdown()
      }
      return done
    },
  }
}
