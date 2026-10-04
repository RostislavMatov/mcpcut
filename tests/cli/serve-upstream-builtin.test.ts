import { afterEach, describe, expect, test } from 'vitest'
import { REFUSAL_BUILTIN_NEEDS_AGENT, REFUSAL_BUILTIN_REFUSED } from '../../src/cli/serve-constants.js'
import { checkModelCompatibility, openUpstream, type OpenUpstreamDeps, type UpstreamEndpoints } from '../../src/cli/serve-upstream.js'
import type { FilesBackend } from '../../src/files/upstream.js'
import { serverRecordSchema } from '../../src/registry/schema.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { clientMessage } from '../../src/transport/message.js'

/** The built-in file server on `serve`'s upstream path (ADR-0020 §1): in process, agent required, tenants refused. */

const LIMITS = { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 } as const
const TENANT: TenantSettings = { isTenant: true, stdioServers: 'refused', upstreams: 'public-https', limits: LIMITS }
const UNRESTRICTED: TenantSettings = { isTenant: false, stdioServers: 'allowed', upstreams: 'any', limits: LIMITS }

const record = serverRecordSchema.parse({ name: 'files', transport: 'builtin', kind: 'files' })
const backend: FilesBackend = { actor: 'me', roots: async () => [], rules: async () => [] }

const upstreams: UpstreamEndpoints[] = []
afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()))
})

function depsFor(tenant: TenantSettings, files?: FilesBackend): OpenUpstreamDeps {
  return {
    processEnv: {},
    envAllowlist: [],
    resolveRefs: () => Promise.reject(new Error('the vault must not be read for a built-in server')),
    onServerStderr: () => undefined,
    onError: () => undefined,
    tenant,
    ...(files !== undefined ? { files } : {}),
  }
}

describe('openUpstream: builtin files server', () => {
  test('opens an in-process pair that answers tools/list', async () => {
    const opened = await openUpstream(record, depsFor(UNRESTRICTED, backend))
    expect(opened.status).toBe('opened')
    if (opened.status !== 'opened') return
    upstreams.push(opened.upstream)
    const answer = new Promise<{ result: { tools: unknown[] } }>((resolve) => {
      opened.upstream.source.onMessage((message) => resolve(JSON.parse(message.bytes.toString('utf8'))))
    })
    await opened.upstream.sink.write(clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }))))
    expect((await answer).result.tools).toHaveLength(9)
  })

  test('tenant mode refuses with a code and a stderr-only detail', async () => {
    const opened = await openUpstream(record, depsFor(TENANT, backend))
    expect(opened).toMatchObject({ status: 'refused', error: REFUSAL_BUILTIN_REFUSED })
    if (opened.status === 'refused') expect(opened.detail).toContain('built-in')
  })

  test('without an agent backend it refuses', async () => {
    const opened = await openUpstream(record, depsFor(UNRESTRICTED))
    expect(opened).toMatchObject({ status: 'refused', error: REFUSAL_BUILTIN_NEEDS_AGENT })
  })
})

describe('checkModelCompatibility: builtin', () => {
  test('is fine for a sessionful client', () => {
    expect(checkModelCompatibility('sessionful', record)).toBeNull()
  })

  test('is refused for a stateless client, like a stdio server', () => {
    expect(checkModelCompatibility('stateless', record)).toContain('files')
  })
})
