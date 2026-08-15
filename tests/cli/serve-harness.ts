import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { runServe, type ServeCommandOptions, type ServeHandle } from '../../src/cli/serve-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createRegistryStore, type RegistryStore } from '../../src/registry/store.js'
import { createVaultStore, type VaultStore } from '../../src/vault/store.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Shared plumbing for the `serve` tests (M3 Task 13): a real `runServe` on an
 * ephemeral port, backed by real registry/agents/vault stores in a temp
 * journal directory, plus the fixture servers both transports need.
 *
 * Cleanup is explicit (`disposeServeFixtures()` from each file's `afterEach`),
 * mirroring `tests/proxy/harness.ts` — an imported module must not silently
 * install hooks into whichever suite happens to import it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../fixtures')

export const POLICY_SERVER = join(FIXTURES, 'policy-server.mjs')
export const ENV_ECHO_SERVER = join(FIXTURES, 'env-echo-server.mjs')
export const HTTP_SESSIONFUL_FIXTURE = join(FIXTURES, 'http-server-sessionful.mjs')
export const HTTP_STATELESS_FIXTURE = join(FIXTURES, 'http-server-stateless.mjs')

export const AGENT = 'research-bot'
export const SERVER = 'testsrv'
export const POLL_INTERVAL_MS = 25
export const WAIT_TIMEOUT_MS = 10_000

export const DEFAULT_POLICY = {
  version: 1,
  defaultDecision: 'allow',
  quarantine: { enabled: false },
}

export interface CapturedIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  outText(): string
  errText(): string
}

export function captureIo(): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    outText: () => out.join(''),
    errText: () => err.join(''),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitUntil(predicate: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: timed out waiting for ${what}`)
    await sleep(5)
  }
}

export interface ServeFixture {
  readonly journalDir: string
  readonly policyPath: string
  readonly registry: RegistryStore
  readonly agents: AgentsStore
  readonly vault: VaultStore
  readonly io: CapturedIo
  /** Resolves with `runServe`'s exit code once the front has shut down. */
  readonly exit: Promise<number>
  readonly handle: ServeHandle
  readonly token: string
  readonly baseUrl: string
  readonly path: string
  post(body: string, headers?: Record<string, string>, path?: string): Promise<Response>
  get(headers?: Record<string, string>, path?: string): Promise<Response>
  del(headers?: Record<string, string>, path?: string): Promise<Response>
  journalRecords(): Promise<JournalRecord[]>
  shutdown(): Promise<number>
}

export interface StartServeOptions {
  /** Extra argv appended after the standard `--port 0 --policy <path>`. */
  readonly argv?: readonly string[]
  readonly policy?: unknown
  /** Grant for the agent; omitted means "created with no grant at all". */
  readonly grant?: readonly string[] | '*'
  readonly grantServer?: string
  /** Extra `runServe` options merged over the harness defaults. */
  readonly serveOptions?: Partial<ServeCommandOptions>
}

const cleanups: Array<() => Promise<void>> = []
const spawnedFixtures: ChildProcess[] = []

/** Tears down every fixture started since the last call. Call from `afterEach`. */
export async function disposeServeFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
  for (const child of spawnedFixtures.splice(0)) {
    child.kill('SIGKILL')
  }
}

/** Registers an extra cleanup to run with the fixtures (LIFO). */
export function onDispose(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

/** Creates a temp journal dir with a policy file, cleaned up on dispose. */
export async function createJournalDir(policy: unknown = DEFAULT_POLICY): Promise<{
  journalDir: string
  policyPath: string
}> {
  const journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-serve-test-'))
  const policyPath = join(journalDir, 'policy.json')
  await writeFile(policyPath, typeof policy === 'string' ? policy : JSON.stringify(policy), 'utf8')
  onDispose(() => rm(journalDir, { recursive: true, force: true }))
  return { journalDir, policyPath }
}

/** Boots one `serve` run on an ephemeral port with real stores. */
export async function startServe(opts: StartServeOptions = {}): Promise<ServeFixture> {
  const { journalDir, policyPath } = await createJournalDir(opts.policy ?? DEFAULT_POLICY)

  const registry = createRegistryStore(journalDir)
  const agents = createAgentsStore({ journalDir })
  const vault = createVaultStore({ journalDir })
  await vault.init()
  const created = await agents.createAgent(AGENT)
  if (opts.grant !== undefined) {
    await agents.grantServer(AGENT, opts.grantServer ?? SERVER, opts.grant)
  }

  const io = captureIo()
  let handle: ServeHandle | undefined
  const exit = runServe(['--port', '0', '--policy', policyPath, ...(opts.argv ?? [])], io, {
    journalDir,
    signals: [],
    revocationPollIntervalMs: POLL_INTERVAL_MS,
    ...opts.serveOptions,
    onListening: (started) => {
      handle = started
    },
  })
  exit.catch(() => undefined)
  await waitUntil(() => handle !== undefined, 'the front to listen')

  const started = handle as ServeHandle
  const baseUrl = `http://127.0.0.1:${started.port}`
  const path = `/agents/${AGENT}/servers/${SERVER}`
  let isShutDown = false
  const shutdown = async (): Promise<number> => {
    if (!isShutDown) {
      isShutDown = true
      await started.shutdown()
    }
    return exit
  }
  // Registered before the journal dir cleanup runs (LIFO): the front must be
  // down before its temp directory disappears.
  onDispose(async () => {
    await shutdown()
  })

  const call = (method: string) =>
    (headers: Record<string, string> = {}, target: string = path): Promise<Response> =>
      fetch(`${baseUrl}${target}`, {
        method,
        headers: { authorization: `Bearer ${created.token}`, ...headers },
      })

  return {
    journalDir,
    policyPath,
    registry,
    agents,
    vault,
    io,
    exit,
    handle: started,
    token: created.token,
    baseUrl,
    path,
    post: (body, headers = {}, target = path) =>
      fetch(`${baseUrl}${target}`, {
        method: 'POST',
        body,
        headers: {
          authorization: `Bearer ${created.token}`,
          'content-type': 'application/json',
          ...headers,
        },
      }),
    get: call('GET'),
    del: call('DELETE'),
    journalRecords: () => readJournal(journalDir),
    shutdown,
  }
}

/** Every journal record written into `journalDir`, across all sessions, in commit order. */
export async function readJournal(journalDir: string): Promise<JournalRecord[]> {
  return readJournalRecords(journalDir)
}

/** Spawns one of the HTTP MCP fixtures and returns its `/mcp` endpoint URL. */
export async function startHttpFixture(file: string): Promise<string> {
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
  spawnedFixtures.push(child)
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const newlineIndex = out.indexOf('\n')
      if (newlineIndex !== -1) resolve(Number(out.slice(0, newlineIndex)))
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`fixture exited early: ${String(code)}`)))
  })
  return `http://127.0.0.1:${port}/mcp`
}

/** POSTs to a fixture's `/__control/...` endpoint. */
export async function fixtureControl(
  mcpUrl: string,
  action: string,
  body?: string,
): Promise<Response> {
  return fetch(mcpUrl.replace(/\/mcp$/, `/__control/${action}`), {
    method: 'POST',
    ...(body !== undefined ? { body } : {}),
  })
}

export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2026-07-28', capabilities: {} },
})

export function toolCallBody(id: number, name: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { text: 'hi' } },
  })
}

/** Registers `SERVER` as a stdio server running `file` with `env`. */
export async function addStdioServer(
  fixture: ServeFixture,
  file: string,
  env: Record<string, string> = {},
): Promise<void> {
  await fixture.registry.addServer({
    name: SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [file],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  })
}
