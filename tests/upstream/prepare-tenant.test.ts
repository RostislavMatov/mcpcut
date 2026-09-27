import { createServer as createNetServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { UpstreamAddressRefusedError } from '../../src/net/upstream-guard.js'
import type { ResolveEnvRefsFn } from '../../src/proxy/server-env.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { UpstreamConnectionError } from '../../src/transport/http/client.js'
import { clientMessage } from '../../src/transport/message.js'
import { prepareUpstream, type ConnectUpstream, type PrepareUpstreamArgs } from '../../src/upstream/prepare.js'

/**
 * Tenant mode on the `connect`/probe upstream path (ADR-0017 T3/T4, plan
 * Task 6): a stdio record is refused before the vault is read or anything
 * spawned — the start-time lock for a record written before the mode was on —
 * and an http upstream carries the SSRF guard. Without the mode, both behave
 * exactly as before.
 */

const LIMITS = { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 } as const
const TENANT: TenantSettings = { isTenant: true, stdioServers: 'refused', upstreams: 'public-https', limits: LIMITS }
const UNRESTRICTED: TenantSettings = { isTenant: false, stdioServers: 'allowed', upstreams: 'any', limits: LIMITS }

const listeners: Server[] = []
const opened: ConnectUpstream[] = []

afterEach(async () => {
  for (const upstream of opened.splice(0)) {
    await upstream.finish()
    upstream.dispose()
  }
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  }
})

async function countingListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const listener = createNetServer((socket) => {
    connections += 1
    socket.destroy()
  })
  listeners.push(listener)
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  return { port: (listener.address() as AddressInfo).port, connections: () => connections }
}

function countingResolver(): { resolveRefs: ResolveEnvRefsFn; calls: () => number } {
  let calls = 0
  return {
    resolveRefs: (declared) => {
      calls += 1
      return Promise.resolve({ status: 'resolved', values: { ...declared } })
    },
    calls: () => calls,
  }
}

function argsFor(record: ServerRecord, resolveRefs: ResolveEnvRefsFn, tenant: TenantSettings): PrepareUpstreamArgs {
  return { record, processEnv: {}, resolveRefs, onDiagnostic: () => undefined, tenant }
}

const stdioRecord = serverRecordSchema.parse({
  name: 'local-tool',
  transport: 'stdio',
  command: process.execPath,
  args: ['-e', 'process.exit(0)'],
})

function httpsRecord(port: number): ServerRecord {
  return serverRecordSchema.parse({
    name: 'remote',
    transport: 'http',
    url: `https://127.0.0.1:${port}/mcp`,
    protocol: 'stateless',
  })
}

/** Opens the prepared upstream and POSTs one request through it. */
async function sendOne(args: PrepareUpstreamArgs): Promise<unknown> {
  const prepared = await prepareUpstream(args)
  if (prepared.status !== 'prepared') throw new Error(`expected prepared, got ${prepared.status}`)
  const upstream = prepared.upstream.open()
  opened.push(upstream)
  upstream.endpoints.source.onError(() => undefined)
  const message = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))
  return upstream.endpoints.sink.write(message).then(
    () => null,
    (error: unknown) => error,
  )
}

describe('prepareUpstream in tenant mode', () => {
  test('a stdio record is refused with the tenant reason, before the vault is read', async () => {
    const vault = countingResolver()

    const result = await prepareUpstream(argsFor(stdioRecord, vault.resolveRefs, TENANT))

    expect(result).toEqual({
      status: 'refused',
      reason: 'tenant',
      message:
        'server "local-tool" is stdio: this install refuses stdio servers (tenant mode) — register it over https\n',
    })
    expect(vault.calls()).toBe(0)
  })

  test('an http upstream at a loopback literal is refused by the guard; the listener sees nothing', async () => {
    const listener = await countingListener()
    const vault = countingResolver()

    const error = await sendOne(argsFor(httpsRecord(listener.port), vault.resolveRefs, TENANT))

    expect(error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(listener.connections()).toBe(0)
  })
})

describe('prepareUpstream without tenant mode (unchanged)', () => {
  test('a stdio record is prepared as before', async () => {
    const vault = countingResolver()

    const result = await prepareUpstream(argsFor(stdioRecord, vault.resolveRefs, UNRESTRICTED))

    expect(result.status).toBe('prepared')
    expect(vault.calls()).toBe(1)
  })

  test('the same loopback upstream is dialed (no guard)', async () => {
    const listener = await countingListener()
    const vault = countingResolver()

    const error = await sendOne(argsFor(httpsRecord(listener.port), vault.resolveRefs, UNRESTRICTED))

    expect(error).toBeInstanceOf(UpstreamConnectionError)
    expect(listener.connections()).toBe(1)
  })
})
