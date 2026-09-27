import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createProvisionerServer,
  PROVISIONER_HEADERS_TIMEOUT_MS,
  PROVISIONER_MAX_BODY_BYTES,
  type ProvisionerServer,
} from '../../../hub/src/provisioner/server.js'
import type { ProvisionerService } from '../../../hub/src/provisioner/service.js'
import { tenantObjects, useProvisioner } from './provisioner-harness.js'

/**
 * The provisioner's HTTP API (plan `tenant-orchestrator`, Task 4) in front of
 * the real service over the fake Docker Engine: Bearer first, then route,
 * then body; the owner token only in a successful body, never in a log line.
 */

const TOKEN = 'p'.repeat(48)
const ctx = useProvisioner()
let server: ProvisionerServer
let port: number
let serverLogs: string[]

interface Reply {
  readonly status: number
  readonly headers: NodeJS.Dict<string | string[]>
  readonly body: string
  json(): Record<string, unknown>
}

async function startServer(service: ProvisionerService = ctx.service()): Promise<void> {
  serverLogs = []
  server = createProvisionerServer({ service, token: TOKEN, log: (line) => serverLogs.push(line) })
  port = (await server.listen(0, '127.0.0.1')).port
}

beforeEach(async () => {
  await startServer()
})

afterEach(async () => {
  await server.close()
})

function send(
  method: string,
  path: string,
  options: { readonly body?: string; readonly token?: string | null; readonly contentType?: string } = {},
): Promise<Reply> {
  const token = options.token === undefined ? TOKEN : options.token
  const headers: Record<string, string> = {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(options.body === undefined
      ? {}
      : { 'content-type': options.contentType ?? 'application/json', 'content-length': String(Buffer.byteLength(options.body)) }),
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as Record<string, unknown> })
      })
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const createBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ subdomain: 'alice', login: 'Alice', githubId: 1001, ...overrides })

describe('health and authentication', () => {
  test('/healthz answers without a secret', async () => {
    const reply = await send('GET', '/healthz', { token: null })

    expect(reply.status).toBe(200)
    expect(reply.body).toBe('ok\n')
  })

  test.each([
    ['no Authorization', null],
    ['a wrong token', 'q'.repeat(48)],
    ['a prefix of the token', TOKEN.slice(0, 20)],
    ['an empty Bearer', ''],
  ])('%s → 401, Docker untouched', async (_label, token) => {
    const before = ctx.fake().calls().length

    for (const [method, path] of [
      ['POST', '/tenants'],
      ['GET', '/tenants/alice'],
      ['DELETE', '/tenants/alice'],
      ['POST', '/tenants/alice/owner-token'],
      ['GET', '/nowhere'],
    ] as const) {
      const reply = await send(method, path, { token, ...(method === 'POST' ? { body: createBody() } : {}) })
      expect(reply.status).toBe(401)
      expect(reply.json().error).toBe('unauthorized')
    }
    expect(ctx.fake().calls().length).toBe(before)
  })

  test('a Basic header is not a Bearer', async () => {
    const reply = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'GET', path: '/tenants/alice', headers: { authorization: `Basic ${TOKEN}` }, agent: false },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })

    expect(reply).toBe(401)
  })
})

describe('the tenant lifecycle over HTTP', () => {
  test('create → status → rotate → remove → status', async () => {
    const created = await send('POST', '/tenants', { body: createBody() })
    expect(created.status).toBe(201)
    const firstToken = String(created.json().ownerToken)
    expect(firstToken).toMatch(/^mcpa_/)
    expect(created.headers['cache-control']).toBe('no-store')

    ctx.fake().setVolumeSize('mcpcut-t-alice', 2048)
    const status = await send('GET', '/tenants/alice')
    expect(status.status).toBe(200)
    expect(status.json()).toEqual({ state: 'running', sizeBytes: 2048 })

    const rotated = await send('POST', '/tenants/alice/owner-token')
    expect(rotated.status).toBe(200)
    expect(rotated.json().ownerToken).not.toBe(firstToken)

    const removed = await send('DELETE', '/tenants/alice')
    expect(removed.status).toBe(204)
    expect(removed.body).toBe('')
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })

    expect((await send('GET', '/tenants/alice')).json()).toEqual({ state: 'absent', sizeBytes: null })
    expect((await send('DELETE', '/tenants/alice')).status).toBe(204)
  })

  test('no owner token is ever logged', async () => {
    await send('POST', '/tenants', { body: createBody() })
    await send('POST', '/tenants/alice/owner-token')

    const logs = [...serverLogs, ...ctx.logs()].join('\n')
    for (const token of ctx.tokens()) expect(logs).not.toContain(token)
    expect(logs).toContain('[provisioner] create alice: ok')
    expect(logs).toContain('[provisioner] rotate alice: ok')
  })
})

describe('refusals', () => {
  test.each([
    ['a reserved subdomain', createBody({ subdomain: 'www' })],
    ['a bad subdomain', createBody({ subdomain: 'Al/ice' })],
    ['a bad login', createBody({ login: 'al ice' })],
    ['a missing githubId', JSON.stringify({ subdomain: 'alice', login: 'alice' })],
    ['an extra field', createBody({ image: 'evil:latest' })],
    ['a string githubId', createBody({ githubId: '1' })],
    ['not JSON', '{"subdomain":'],
    ['an array', '[]'],
  ])('%s → 400 before Docker', async (_label, body) => {
    const before = ctx.fake().calls().length

    const reply = await send('POST', '/tenants', { body })

    expect(reply.status).toBe(400)
    expect(reply.json().error).toBe('invalid-input')
    expect(ctx.fake().calls().length).toBe(before)
  })

  test('a non-JSON content type → 415', async () => {
    const reply = await send('POST', '/tenants', { body: createBody(), contentType: 'application/x-www-form-urlencoded' })

    expect(reply.status).toBe(415)
  })

  test(`a body over ${PROVISIONER_MAX_BODY_BYTES} bytes → 413`, async () => {
    const reply = await send('POST', '/tenants', { body: createBody({ login: 'a'.repeat(PROVISIONER_MAX_BODY_BYTES) }) })

    expect(reply.status).toBe(413)
    expect(reply.headers.connection).toBe('close')
  })

  test('an existing tenant → 409 exists', async () => {
    await send('POST', '/tenants', { body: createBody() })

    const reply = await send('POST', '/tenants', { body: createBody() })

    expect(reply.status).toBe(409)
    expect(reply.json()).toMatchObject({ error: 'exists' })
  })

  test('rotating a tenant that does not exist → 404', async () => {
    expect((await send('POST', '/tenants/alice/owner-token')).status).toBe(404)
  })

  test('a reserved subdomain in a path → 400', async () => {
    expect((await send('GET', '/tenants/www')).status).toBe(400)
  })

  test('an unknown route → 404; a wrong method → 405', async () => {
    expect((await send('GET', '/tenants/alice/else')).status).toBe(404)
    expect((await send('GET', '/tenants/..%2Fetc')).status).toBe(404)
    expect((await send('GET', '/tenants')).status).toBe(405)
    expect((await send('PUT', '/tenants/alice')).status).toBe(405)
    expect((await send('GET', '/tenants/alice/owner-token')).status).toBe(405)
  })

  test('a failed create answers the code without a token and leaves nothing behind', async () => {
    ctx.fake().failNext('POST /containers/create', 500, 'no space')

    const reply = await send('POST', '/tenants', { body: createBody() })

    expect(reply.status).toBe(502)
    expect(reply.json().error).toBe('docker')
    expect(reply.body).not.toContain('mcpa_')
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
  })

  test('an unexpected service failure is a 500 with a fixed message', async () => {
    await server.close()
    const broken: ProvisionerService = {
      ...ctx.service(),
      status: () => Promise.reject(new Error('mcpa_leakyleakyleakyleaky0000')),
    }
    await startServer(broken)

    const reply = await send('GET', '/tenants/alice')

    expect(reply.status).toBe(500)
    expect(reply.body).not.toContain('leaky')
    expect(serverLogs.join('\n')).not.toContain('mcpa_leaky')
  })
})

describe('configuration', () => {
  test('explicit connection timeouts', () => {
    expect(PROVISIONER_HEADERS_TIMEOUT_MS).toBe(10_000)
  })

  test('an empty token is refused at construction', () => {
    expect(() => createProvisionerServer({ service: ctx.service(), token: '' })).toThrow(TypeError)
  })

  test('closing twice is harmless', async () => {
    await server.close()
    await expect(server.close()).resolves.toBeUndefined()
  })
})
