import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SESSION_ID_PATTERN } from '../../src/config.js'
import {
  ACTIVITY_BLINK_WINDOW_MS,
  PROBE_MAX_CONCURRENT,
  PROBE_SESSION_ID,
  PROBE_TIMEOUT_MS,
  STATUS_STALE_AFTER_MS,
} from '../../src/probe/constants.js'
import { probe } from '../../src/probe/engine.js'
import type { ResolveEnvRefsFn } from '../../src/proxy/server-env.js'
import { REGISTRY_SERVER_NAME_PATTERN } from '../../src/registry/constants.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'

/**
 * Probe engine (M5.5 п.1, Task 1). What this file proves:
 *
 *  - a live stdio server answers `initialize` → `alive` with a measured
 *    latency and (optionally) its `tools/list` descriptors;
 *  - the `tools/list` step happens OUTSIDE the latency measurement;
 *  - a server that never answers → `unreachable` by timeout, and the child
 *    is actually gone afterwards (no leaked processes);
 *  - a server that answers garbage → `error`;
 *  - a vault refusal → `vault-refused` BEFORE anything is spawned;
 *  - `protocol: 'stateless'` is probed with `tools/list`, never `initialize`
 *    (ADR-0002's `guardInitialize`); sessionful http — with `initialize`;
 *  - no error message ever carries a secret VALUE (names only).
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_SERVER_FIXTURE = join(__dirname, '../fixtures/fake-server.mjs')
const SILENT_SERVER_FIXTURE = join(__dirname, '../fixtures/silent-server.mjs')
const GARBAGE_SERVER_FIXTURE = join(__dirname, '../fixtures/garbage-server.mjs')
const HTTP_STATELESS_FIXTURE = join(__dirname, '../fixtures/http-server-stateless.mjs')
const HTTP_SESSIONFUL_FIXTURE = join(__dirname, '../fixtures/http-server-sessionful.mjs')

/** A value that must NEVER appear in any probe message (secret-value marker). */
const SECRET_VALUE_MARKER = 'S3CR3T-VALUE-MARKER-c81f'

/** Fast-cleanup knobs so timeout tests stay quick. */
const FAST_CHILD_TIMINGS = { childExitGraceMs: 50, killEscalationMs: 50 } as const

const resolvePassthrough: ResolveEnvRefsFn = (record) =>
  Promise.resolve({ status: 'resolved', values: { ...record } })

function stdioRecord(args: readonly string[], env?: Record<string, string>): ServerRecord {
  return serverRecordSchema.parse({
    name: 'probe-target',
    transport: 'stdio',
    command: process.execPath,
    args: [...args],
    ...(env !== undefined ? { env } : {}),
  })
}

function httpRecord(
  url: string,
  protocol: 'sessionful' | 'stateless' | 'auto',
  headers?: Record<string, string>,
): ServerRecord {
  return serverRecordSchema.parse({
    name: 'probe-target',
    transport: 'http',
    url,
    protocol,
    ...(headers !== undefined ? { headers } : {}),
  })
}

function baseDeps() {
  return { processEnv: process.env, resolveRefs: resolvePassthrough }
}

// ---------------------------------------------------------------------------
// HTTP fixture harness (same style as tests/transport/http/client.test.ts)
// ---------------------------------------------------------------------------

interface FixtureStats {
  readonly posts: number
  readonly lastPostHeaders: Record<string, string> | null
}

interface HttpFixture {
  readonly mcpUrl: string
  stats(): Promise<FixtureStats>
}

const spawnedFixtures: ChildProcess[] = []

async function startHttpFixture(file: string): Promise<HttpFixture> {
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
    setTimeout(() => reject(new Error('fixture did not report a port')), 5_000).unref()
  })
  const base = `http://127.0.0.1:${port}`
  return {
    mcpUrl: `${base}/mcp`,
    stats: () =>
      new Promise<FixtureStats>((resolve, reject) => {
        httpGet(`${base}/__control/stats`, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureStats),
          )
        }).on('error', reject)
      }),
  }
}

/** A localhost port with nothing listening on it (connection-refused tests). */
async function refusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterAll(() => {
  for (const child of spawnedFixtures) {
    child.kill('SIGKILL')
  }
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('probe constants', () => {
  test('owner-approved values (O-decisions 2026-08-24)', () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000)
    expect(PROBE_MAX_CONCURRENT).toBe(4)
    expect(STATUS_STALE_AFTER_MS).toBe(3_600_000)
    expect(ACTIVITY_BLINK_WINDOW_MS).toBe(300_000)
  })

  test('PROBE_SESSION_ID is a valid journal session id', () => {
    expect(SESSION_ID_PATTERN.test(PROBE_SESSION_ID)).toBe(true)
  })

  test('PROBE_SESSION_ID can never collide with a registry server name', () => {
    // Probe journal records must be separable from agent traffic by
    // construction: no registrable server name may equal the probe session id.
    expect(REGISTRY_SERVER_NAME_PATTERN.test(PROBE_SESSION_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

describe('probe over stdio', () => {
  let scratchDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'probe-engine-'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  test('a live server answering initialize → alive with latency and tools', async () => {
    const result = await probe(stdioRecord([FAKE_SERVER_FIXTURE]), {
      ...baseDeps(),
      withTools: true,
      ...FAST_CHILD_TIMINGS,
    })

    expect(result.status).toBe('alive')
    if (result.status !== 'alive') return
    expect(result.probedVia).toBe('initialize')
    expect(result.initializeLatencyMs).toBeGreaterThan(0)
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo'])
  })

  test('the tools/list step happens OUTSIDE the latency measurement', async () => {
    // The injectable clock is consulted exactly twice: at probe start and at
    // the valid probe answer. If the tools/list step were inside the
    // measurement, either the latency would include a third tick or the
    // clock would be consulted again.
    let calls = 0
    const clock = (): number => {
      calls += 1
      if (calls === 1) return 0
      if (calls === 2) return 42
      return 100_000
    }

    const result = await probe(stdioRecord([FAKE_SERVER_FIXTURE]), {
      ...baseDeps(),
      withTools: true,
      clock,
      ...FAST_CHILD_TIMINGS,
    })

    expect(result.status).toBe('alive')
    if (result.status !== 'alive') return
    expect(result.initializeLatencyMs).toBe(42)
    expect(result.tools).toBeDefined()
    expect(calls).toBe(2)
  })

  test('a server that never answers → unreachable by timeout, child killed', async () => {
    const pidFile = join(scratchDir, 'silent.pid')

    const result = await probe(stdioRecord([SILENT_SERVER_FIXTURE, pidFile]), {
      ...baseDeps(),
      timeoutMs: 250,
      ...FAST_CHILD_TIMINGS,
    })

    expect(result.status).toBe('unreachable')
    if (result.status !== 'unreachable') return
    expect(result.message).toContain('initialize')

    // No leaked process: by the time probe() resolves, the child must be
    // gone (the silent fixture survives stdin close, so only the SIGTERM
    // escalation can have ended it).
    const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
    expect(Number.isInteger(pid)).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('a server answering garbage → error', async () => {
    const result = await probe(stdioRecord([GARBAGE_SERVER_FIXTURE]), {
      ...baseDeps(),
      ...FAST_CHILD_TIMINGS,
    })

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    // The raw garbage bytes are server-controlled and must not be echoed.
    expect(result.message).not.toContain('this is not JSON-RPC at all')
  })

  test('a vault refusal → vault-refused BEFORE any spawn', async () => {
    const sentinel = join(scratchDir, 'spawned.sentinel')
    const record = stdioRecord(
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned')`],
      { PROBE_TOKEN: 'vault:probe-token' },
    )
    const refuseMissing: ResolveEnvRefsFn = () =>
      Promise.resolve({ status: 'missing-secrets', missing: ['probe-token'] })

    const result = await probe(record, {
      processEnv: process.env,
      resolveRefs: refuseMissing,
      ...FAST_CHILD_TIMINGS,
    })

    expect(result.status).toBe('vault-refused')
    if (result.status !== 'vault-refused') return
    // Names only, never values.
    expect(result.message).toContain('probe-token')
    expect(result.message).not.toContain(SECRET_VALUE_MARKER)
    expect(existsSync(sentinel)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

describe('probe over http', () => {
  test('stateless: initialize is NEVER sent — probed via tools/list', async () => {
    const fixture = await startHttpFixture(HTTP_STATELESS_FIXTURE)

    const result = await probe(httpRecord(fixture.mcpUrl, 'stateless'), {
      ...baseDeps(),
      withTools: true,
    })

    expect(result.status).toBe('alive')
    if (result.status !== 'alive') return
    expect(result.probedVia).toBe('tools/list')
    expect(result.initializeLatencyMs).toBeGreaterThan(0)

    const stats = await fixture.stats()
    expect(stats.posts).toBe(1)
    expect(stats.lastPostHeaders?.['mcp-method']).toBe('tools/list')
  })

  test('sessionful: probed via initialize', async () => {
    const fixture = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)

    const result = await probe(httpRecord(fixture.mcpUrl, 'sessionful'), baseDeps())

    expect(result.status).toBe('alive')
    if (result.status !== 'alive') return
    expect(result.probedVia).toBe('initialize')

    const stats = await fixture.stats()
    expect(stats.posts).toBe(1)
  })

  test('nothing listening → unreachable, and a resolved header secret never leaks', async () => {
    const port = await refusedPort()
    const resolveToMarker: ResolveEnvRefsFn = () =>
      Promise.resolve({ status: 'resolved', values: { authorization: SECRET_VALUE_MARKER } })

    const result = await probe(
      httpRecord(`http://127.0.0.1:${port}/mcp`, 'stateless', {
        authorization: 'vault:probe-token',
      }),
      { processEnv: process.env, resolveRefs: resolveToMarker, timeoutMs: 2_000 },
    )

    expect(result.status).toBe('unreachable')
    if (result.status !== 'unreachable') return
    expect(result.message).not.toContain(SECRET_VALUE_MARKER)
  })
})
