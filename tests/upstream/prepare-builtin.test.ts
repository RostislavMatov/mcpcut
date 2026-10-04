import { afterEach, describe, expect, test } from 'vitest'
import type { FilesBackend } from '../../src/files/upstream.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { clientMessage } from '../../src/transport/message.js'
import { prepareUpstream, type ConnectUpstream, type PrepareUpstreamArgs } from '../../src/upstream/prepare.js'

const LIMITS = { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 } as const
const TENANT: TenantSettings = { isTenant: true, stdioServers: 'refused', upstreams: 'public-https', limits: LIMITS }
const UNRESTRICTED: TenantSettings = { isTenant: false, stdioServers: 'allowed', upstreams: 'any', limits: LIMITS }

const record: ServerRecord = serverRecordSchema.parse({ name: 'files', transport: 'builtin', kind: 'files' })
const backend: FilesBackend = { actor: 'me', roots: async () => [], rules: async () => [] }

const opened: ConnectUpstream[] = []
afterEach(async () => {
  for (const upstream of opened.splice(0)) {
    await upstream.finish()
    upstream.dispose()
  }
})

function argsFor(extra: Partial<PrepareUpstreamArgs> = {}): PrepareUpstreamArgs {
  return {
    record,
    processEnv: {},
    resolveRefs: () => Promise.reject(new Error('the vault must not be read for a built-in server')),
    onDiagnostic: () => undefined,
    tenant: UNRESTRICTED,
    ...extra,
  }
}

describe('prepareUpstream: builtin files server', () => {
  test('without an agent it refuses in one line that says how to connect as an agent', async () => {
    const result = await prepareUpstream(argsFor())
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') return
    expect(result.reason).toBe('agent')
    expect(result.message.trimEnd()).not.toContain('\n')
    expect(result.message).toContain('mcpcut agent create <name>')
    expect(result.message).toContain('mcpcut connect')
  })

  test('tenant mode refuses it before anything else', async () => {
    const result = await prepareUpstream(argsFor({ tenant: TENANT, files: backend }))
    expect(result).toMatchObject({ status: 'refused', reason: 'tenant' })
    if (result.status === 'refused') expect(result.message.trimEnd()).not.toContain('\n')
  })

  test('with an agent backend it answers initialize in process and never reads the vault', async () => {
    const result = await prepareUpstream(argsFor({ files: backend }))
    expect(result.status).toBe('prepared')
    if (result.status !== 'prepared') return
    expect(result.upstream.dropClientBlanks).toBe(true)
    expect(result.upstream.guardInitialize).toBe(false)
    const upstream = result.upstream.open()
    opened.push(upstream)
    const answer = new Promise<unknown>((resolve) => {
      upstream.endpoints.source.onMessage((message) => resolve(JSON.parse(message.bytes.toString('utf8'))))
    })
    await upstream.endpoints.sink.write(clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))))
    expect(await answer).toMatchObject({ id: 1, result: { serverInfo: { name: 'mcpcut-files' } } })
    expect(await upstream.finish()).toBe(0)
  })
})
