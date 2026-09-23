import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { ServeCommandOptions } from '../../src/cli/serve-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  onDispose,
  POOL_SERVER,
  startServe,
  waitUntil,
  type ServeFixture,
  type StartServeOptions,
} from './serve-harness.js'

/**
 * Plumbing for the resident-server suites (ADR-0016): a `serve` with
 * residents ON (the ordinary harness turns them off), a pool fixture that
 * writes a pid file, and the reads the assertions need — which pid served,
 * whether it is alive, what the pool journaled.
 */

/** Fast knobs: reconcile and restarts in tens of milliseconds, not seconds. */
export const RESIDENT_SERVE_OPTIONS: Partial<ServeCommandOptions> = {
  maxPoolResidents: 32,
  poolWarmIdleMs: 60_000,
  poolResidentReconcileMs: 40,
  poolResidentRestartBaseMs: 50,
}

export async function startResidentServe(
  serveOptions: Partial<ServeCommandOptions> = {},
  extra: Omit<StartServeOptions, 'serveOptions'> = {},
): Promise<ServeFixture> {
  const fixture = await startServe({ ...extra, serveOptions: { ...RESIDENT_SERVE_OPTIONS, ...serveOptions } })
  // Last out (LIFO): after the front is down, no process of a test survives.
  onDispose(async () => {
    const pids = await allPids(fixture)
    await fixture.shutdown()
    for (const pid of pids) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
  return fixture
}

export function pidFileOf(fixture: ServeFixture, name: string): string {
  return join(fixture.journalDir, `pids-${name}.txt`)
}

/** Registers `name` as a pool fixture writing its pid file, and grants it to `agent`. */
export async function registerResident(
  fixture: ServeFixture,
  name: string,
  options: { agent?: string; tools?: readonly string[]; env?: Record<string, string> } = {},
): Promise<void> {
  await fixture.registry.addServer({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_SERVER, ...(options.tools ?? ['echo'])],
    env: { POOL_FIXTURE_NAME: name, POOL_FIXTURE_PID_FILE: pidFileOf(fixture, name), ...options.env },
  })
  await fixture.agents.grantServer(options.agent ?? AGENT, name, '*')
}

export interface PidLine {
  readonly pid: number
  readonly startedAt: number
}

export async function pidLines(fixture: ServeFixture, name: string): Promise<PidLine[]> {
  const text = await readFile(pidFileOf(fixture, name), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, startedAt] = line.split(' ')
      return { pid: Number(pid), startedAt: Number(startedAt) }
    })
}

export async function pidsOf(fixture: ServeFixture, name: string): Promise<number[]> {
  return (await pidLines(fixture, name)).map((line) => line.pid)
}

async function allPids(fixture: ServeFixture): Promise<number[]> {
  const servers = await fixture.registry.listServers()
  const lists = await Promise.all(servers.map((server) => pidsOf(fixture, server.name)))
  return lists.flat()
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until `name` has started `count` processes, and returns their pids. */
export async function waitForStarts(fixture: ServeFixture, name: string, count: number): Promise<number[]> {
  await waitUntil(async () => (await pidsOf(fixture, name)).length >= count, `${count} start(s) of ${name}`)
  return pidsOf(fixture, name)
}

export async function waitForDeath(pid: number, what = `process ${pid} to exit`): Promise<void> {
  await waitUntil(() => !isAlive(pid), what)
}

export interface PoolSession {
  readonly sessionId: string
  call(body: unknown): Promise<Record<string, unknown>>
  close(): Promise<void>
}

/** Opens a pool session for `token` (the harness agent by default). */
export async function openPool(fixture: ServeFixture, token = fixture.token): Promise<PoolSession> {
  const auth = { authorization: `Bearer ${token}` }
  const opened = await fixture.post(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }),
    auth,
    POOL_ROUTE_PATH,
  )
  expect(opened.status).toBe(200)
  const sessionId = opened.headers.get('mcp-session-id') as string
  return {
    sessionId,
    call: async (body) => {
      const answer = await fixture.post(JSON.stringify(body), { ...auth, 'mcp-session-id': sessionId }, POOL_ROUTE_PATH)
      const text = await answer.text()
      return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
    },
    close: async () => {
      await fixture.del({ ...auth, 'mcp-session-id': sessionId }, POOL_ROUTE_PATH)
    },
  }
}

export async function listNames(pool: PoolSession, id = 2): Promise<string[]> {
  const body = await pool.call({ jsonrpc: '2.0', id, method: 'tools/list' })
  const tools = (body['result'] as { tools?: { name: string }[] } | undefined)?.tools ?? []
  return tools.map((tool) => tool.name)
}

export function poolPayloads(records: readonly JournalRecord[], event: string): Array<Record<string, unknown>> {
  return records
    .filter((record) => record.kind === 'pool')
    .map((record) => record.payload as Record<string, unknown>)
    .filter((payload) => payload['event'] === event)
}

/** Every pool `attach` so far, once the journal has written at least `count`. */
export async function attachesOf(fixture: ServeFixture, count: number): Promise<Array<Record<string, unknown>>> {
  await waitUntil(async () => poolPayloads(await fixture.journalRecords(), 'attach').length >= count, `${count} attach(es)`)
  return poolPayloads(await fixture.journalRecords(), 'attach')
}

export { AGENT }
