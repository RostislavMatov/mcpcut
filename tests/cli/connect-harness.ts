import { spawn, type ChildProcess } from 'node:child_process'
import { request as nodeHttpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import { createVaultStore } from '../../src/vault/store.js'

/**
 * Harness for `tests/cli/connect-cmd.test.ts`: the injected stdio a `connect`
 * run reads and writes, plane state setup (registry / agents / vault in a temp
 * directory), and a spawned HTTP fixture server.
 *
 * Kept separate from `tests/proxy/harness.ts` (which is built around
 * `runWrap`) per this task's ownership boundary; polling and journal reading
 * are imported from there rather than re-implemented.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ENV_ECHO_FIXTURE = join(__dirname, '../fixtures/env-echo-server.mjs')
export const POLICY_SERVER_FIXTURE = join(__dirname, '../fixtures/policy-server.mjs')
export const HTTP_SESSIONFUL_FIXTURE = join(__dirname, '../fixtures/http-server-sessionful.mjs')

/** Capture object for the CLI's own diagnostics (`io.stderr`). */
export interface CliCapture {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  out(): string
  err(): string
}

export function createCliCapture(): CliCapture {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

export interface ConnectStdio {
  /** What the agent writes (this run's `deps.stdin`). */
  readonly clientOutbox: PassThrough
  /** The protocol channel (this run's `deps.stdout`). */
  readonly clientStdout: PassThrough
  /** Passthrough for a spawned server's stderr (this run's `deps.stderr`). */
  readonly clientStderr: PassThrough
  /** Complete newline-terminated lines received on the protocol channel. */
  lineCount(): number
  /** Every JSON message received on the protocol channel, in order. */
  messages(): Array<Record<string, unknown>>
  /** Raw protocol-channel bytes as text. */
  stdoutText(): string
  stderrText(): string
}

export function createConnectStdio(): ConnectStdio {
  const clientOutbox = new PassThrough()
  const clientStdout = new PassThrough()
  const outChunks: Buffer[] = []
  clientStdout.on('data', (chunk: Buffer) => outChunks.push(chunk))
  const clientStderr = new PassThrough()
  const errChunks: Buffer[] = []
  clientStderr.on('data', (chunk: Buffer) => errChunks.push(chunk))
  clientStderr.resume()

  const stdoutText = (): string => Buffer.concat(outChunks).toString('utf8')

  return {
    clientOutbox,
    clientStdout,
    clientStderr,
    lineCount: () => stdoutText().split('\n').filter((line) => line.length > 0).length,
    messages: () =>
      stdoutText()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    stdoutText,
    stderrText: () => Buffer.concat(errChunks).toString('utf8'),
  }
}

/** Registers one server record in the temp-directory registry. */
export async function addServerRecord(journalDir: string, record: ServerRecord): Promise<void> {
  await createRegistryStore(journalDir).addServer(record)
}

/** Creates an agent, grants it a server, and returns its one-time token. */
export async function createGrantedAgent(args: {
  readonly journalDir: string
  readonly agentName: string
  readonly serverName: string
  readonly tools: readonly string[] | '*'
}): Promise<string> {
  const store = createAgentsStore({ journalDir: args.journalDir })
  const created = await store.createAgent(args.agentName)
  await store.grantServer(args.agentName, args.serverName, args.tools)
  return created.token
}

/** Initializes the vault and stores one secret. */
export async function seedVault(journalDir: string, name: string, value: string): Promise<void> {
  const vault = createVaultStore({ journalDir })
  await vault.init()
  const result = await vault.setSecret(name, value)
  if (result.status !== 'set') {
    throw new Error(`seedVault: ${JSON.stringify(result)}`)
  }
}

export interface HttpFixture {
  readonly url: string
  /** The fixture's own request counters (`/__control/stats`). */
  stats(): Promise<{ posts: number; getRequests: number; deletes: number }>
  stop(): void
}

const spawnedFixtures: ChildProcess[] = []

/** Spawns an HTTP fixture server and reads its ephemeral port off stdout line 1. */
export async function startHttpFixture(file: string): Promise<HttpFixture> {
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
  spawnedFixtures.push(child)
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const newlineIndex = out.indexOf('\n')
      if (newlineIndex !== -1) {
        resolve(Number.parseInt(out.slice(0, newlineIndex), 10))
      }
    })
    child.once('error', reject)
    setTimeout(() => reject(new Error('fixture did not report a port')), 5000).unref()
  })
  const base = `http://127.0.0.1:${port}`

  return {
    url: `${base}/mcp`,
    stats: () =>
      httpGetJson(`${base}/__control/stats`) as Promise<{
        posts: number
        getRequests: number
        deletes: number
      }>,
    stop: () => child.kill('SIGKILL'),
  }
}

/** Kills every fixture this harness spawned. Call from an `afterAll`. */
export function stopAllHttpFixtures(): void {
  for (const child of spawnedFixtures) {
    child.kill('SIGKILL')
  }
  spawnedFixtures.length = 0
}

function httpGetJson(target: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(target, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}
