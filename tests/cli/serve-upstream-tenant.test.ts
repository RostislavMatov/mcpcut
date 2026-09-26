import { createServer as createNetServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { REFUSAL_STDIO_REFUSED } from '../../src/cli/serve-constants.js'
import { openUpstream, type OpenUpstreamDeps, type UpstreamEndpoints } from '../../src/cli/serve-upstream.js'
import { UpstreamAddressRefusedError } from '../../src/net/upstream-guard.js'
import type { ResolveEnvRefsFn } from '../../src/proxy/server-env.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { UpstreamConnectionError } from '../../src/transport/http/client.js'
import { clientMessage } from '../../src/transport/message.js'

/**
 * Tenant mode on `serve`'s upstream path (ADR-0017 T3/T4, plan Task 6). Every
 * child `serve` opens — a single-server session, a pool member, a resident —
 * goes through `openUpstream`, so this is where the stdio start-time lock and
 * the SSRF guard have to hold. Without the mode: exactly as before.
 */

const LIMITS = { servers: 5, agents: 5, groups: 2 } as const
const TENANT: TenantSettings = { isTenant: true, stdioServers: 'refused', upstreams: 'public-https', limits: LIMITS }
const UNRESTRICTED: TenantSettings = { isTenant: false, stdioServers: 'allowed', upstreams: 'any', limits: LIMITS }

const listeners: Server[] = []
const upstreams: UpstreamEndpoints[] = []

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()))
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

function depsFor(tenant: TenantSettings): { deps: OpenUpstreamDeps; vaultReads: () => number } {
  let reads = 0
  const resolveRefs: ResolveEnvRefsFn = (declared) => {
    reads += 1
    return Promise.resolve({ status: 'resolved', values: { ...declared } })
  }
  const deps: OpenUpstreamDeps = {
    processEnv: {},
    envAllowlist: [],
    resolveRefs,
    onServerStderr: () => undefined,
    onError: () => undefined,
    killEscalationMs: 50,
    tenant,
  }
  return { deps, vaultReads: () => reads }
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

/** Opens the upstream and POSTs one request; resolves with the write's error, or null. */
async function sendOne(record: ServerRecord, deps: OpenUpstreamDeps): Promise<unknown> {
  const opened = await openUpstream(record, deps)
  if (opened.status !== 'opened') throw new Error(`expected opened, got ${opened.status}`)
  upstreams.push(opened.upstream)
  opened.upstream.source.onError(() => undefined)
  const message = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))
  return opened.upstream.sink.write(message).then(
    () => null,
    (error: unknown) => error,
  )
}

describe('openUpstream in tenant mode', () => {
  test('a stdio record is refused before the vault is read: a bare code to the agent, the reason to stderr', async () => {
    const { deps, vaultReads } = depsFor(TENANT)

    const opened = await openUpstream(stdioRecord, deps)

    expect(opened).toEqual({
      status: 'refused',
      error: REFUSAL_STDIO_REFUSED,
      detail:
        'server "local-tool" is stdio: this install refuses stdio servers (tenant mode) — register it over https',
    })
    expect(vaultReads()).toBe(0)
  })

  test('an http upstream at a loopback literal is refused by the guard; the listener sees nothing', async () => {
    const listener = await countingListener()

    const error = await sendOne(httpsRecord(listener.port), depsFor(TENANT).deps)

    expect(error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(listener.connections()).toBe(0)
  })
})

describe('openUpstream without tenant mode (unchanged)', () => {
  test('a stdio record is spawned as before', async () => {
    const opened = await openUpstream(stdioRecord, depsFor(UNRESTRICTED).deps)

    expect(opened.status).toBe('opened')
    if (opened.status === 'opened') upstreams.push(opened.upstream)
  })

  test('the same loopback upstream is dialed (no guard)', async () => {
    const listener = await countingListener()

    const error = await sendOne(httpsRecord(listener.port), depsFor(UNRESTRICTED).deps)

    expect(error).toBeInstanceOf(UpstreamConnectionError)
    expect(listener.connections()).toBe(1)
  })
})
