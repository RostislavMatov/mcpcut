import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CREATE_TIMEOUT_MS,
  createHttpOrchestrator,
  OrchestratorHttpError,
  type HttpOrchestrator,
} from '../../hub/src/orchestrator-http.js'
import { describeOrchestratorError } from '../../hub/src/orchestrator.js'

/**
 * `hub/src/orchestrator-http.ts` (plan `tenant-orchestrator`, Task 5) against
 * a scripted stand-in for the provisioner: the requests it sends, the answers
 * it accepts, and that no error ever quotes a body or the Bearer secret.
 */

const SECRET = 's'.repeat(48)
const OWNER_TOKEN = 'mcpa_ownerTokenValue0123456789abcdef'

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

let server: Server
let port: number
let seen: Seen[]
let handler: Handler
let orchestrator: HttpOrchestrator | undefined

beforeEach(async () => {
  seen = []
  handler = (_req, res) => res.writeHead(500).end()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterEach(async () => {
  orchestrator?.close()
  orchestrator = undefined
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function client(options: { timeoutMs?: number; createTimeoutMs?: number } = {}): HttpOrchestrator {
  orchestrator = createHttpOrchestrator({ url: `http://127.0.0.1:${port}`, token: SECRET, ...options })
  return orchestrator
}

function json(status: number, body: unknown): Handler {
  return (_req, res) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }).end(payload)
  }
}

async function failureOf(promise: Promise<unknown>): Promise<OrchestratorHttpError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof OrchestratorHttpError) return error
    throw new Error(`expected OrchestratorHttpError, got ${String(error)}`)
  }
  throw new Error('expected the call to fail')
}

describe('the requests it sends', () => {
  test('create: POST /tenants with the Bearer secret and exactly three fields', async () => {
    handler = json(201, { ownerToken: OWNER_TOKEN })

    const grant = await client().create({ githubId: 42, login: 'Alice', subdomain: 'alice' })

    expect(grant).toEqual({ ownerToken: OWNER_TOKEN })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toBe('/tenants')
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(seen[0]?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ subdomain: 'alice', login: 'Alice', githubId: 42 })
  })

  test('rotate: POST /tenants/:sub/owner-token', async () => {
    handler = json(200, { ownerToken: OWNER_TOKEN })

    expect(await client().rotateOwnerToken('alice')).toEqual({ ownerToken: OWNER_TOKEN })
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/tenants/alice/owner-token', body: '' })
  })

  test('remove: DELETE /tenants/:sub, 204 is success', async () => {
    handler = (_req, res) => res.writeHead(204).end()

    await expect(client().remove('alice')).resolves.toBeUndefined()
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/tenants/alice' })
  })

  test('is available, and waits 120 s for a create by default', () => {
    expect(client().available).toBe(true)
    expect(CREATE_TIMEOUT_MS).toBe(120_000)
  })

  test('a subdomain that is not one never becomes a path', async () => {
    const error = await failureOf(client().remove('../admin'))

    expect(error.failure).toBe('invalid-input')
    expect(seen).toEqual([])
  })
})

describe('failures carry no body, no token, no secret', () => {
  test('an error status names the status and the provisioner’s code only', async () => {
    handler = json(409, { error: 'exists', message: `mcpcut-t-alice exists; ${OWNER_TOKEN}` })

    const error = await failureOf(client().create({ githubId: 1, login: 'alice', subdomain: 'alice' }))

    expect(error.failure).toBe('http-status')
    expect(error.status).toBe(409)
    expect(error.code).toBe('exists')
    expect(error.message).toBe('provisioner create: the provisioner answered HTTP 409 (exists)')
    expect(describeOrchestratorError(error)).not.toContain(SECRET)
  })

  test('a malformed error code is not repeated', async () => {
    handler = json(500, { error: `oops ${OWNER_TOKEN}` })

    const error = await failureOf(client().rotateOwnerToken('alice'))

    expect(error.message).toBe('provisioner rotate: the provisioner answered HTTP 500')
    expect(error.code).toBeUndefined()
  })

  test('a token on the wrong status is not accepted, nor quoted', async () => {
    handler = json(200, { ownerToken: OWNER_TOKEN })

    const error = await failureOf(client().create({ githubId: 1, login: 'alice', subdomain: 'alice' }))

    expect(error.status).toBe(200)
    expect(error.message).not.toContain(OWNER_TOKEN)
  })

  test.each([
    ['not JSON', 'ownerToken=mcpa_x'],
    ['no token', '{}'],
    ['a token with a newline', JSON.stringify({ ownerToken: 'mcpa_abc\ndefghijklmnopqrstu' })],
  ])('a success answer with %s is bad-response', async (_label, body) => {
    handler = (_req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end(body)

    const error = await failureOf(client().create({ githubId: 1, login: 'alice', subdomain: 'alice' }))

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain('mcpa_')
  })

  test('an answer over the size cap is refused', async () => {
    handler = (_req, res) => res.writeHead(200).end('x'.repeat(64 * 1024))

    expect((await failureOf(client().rotateOwnerToken('alice'))).failure).toBe('bad-response')
  })

  test('remove answering anything but 204 fails', async () => {
    handler = json(502, { error: 'docker' })

    const error = await failureOf(client().remove('alice'))

    expect(error.message).toBe('provisioner remove: the provisioner answered HTTP 502 (docker)')
  })

  test('no answer within the deadline is a timeout', async () => {
    handler = () => undefined

    const error = await failureOf(client({ timeoutMs: 50 }).rotateOwnerToken('alice'))

    expect(error.failure).toBe('timeout')
    expect(error.message).toBe('provisioner rotate: no answer within 50 ms')
  })

  test('create has its own, longer deadline', async () => {
    handler = () => undefined

    const error = await failureOf(client({ timeoutMs: 10_000, createTimeoutMs: 50 }).create({ githubId: 1, login: 'a', subdomain: 'a' }))

    expect(error.message).toBe('provisioner create: no answer within 50 ms')
  })

  test('a provisioner that is down is unreachable, with the errno only', async () => {
    const orchestratorDown = createHttpOrchestrator({ url: 'http://127.0.0.1:1', token: SECRET })
    try {
      const error = await failureOf(orchestratorDown.remove('alice'))
      expect(error.failure).toBe('unreachable')
      expect(error.message).toBe('provisioner remove: the provisioner could not be reached (ECONNREFUSED)')
    } finally {
      orchestratorDown.close()
    }
  })
})

describe('configuration', () => {
  test.each([
    [{ url: 'not a url', token: SECRET }, /absolute URL/],
    [{ url: 'ftp://p', token: SECRET }, /http\(s\)/],
    [{ url: 'http://u:p@p', token: SECRET }, /credentials/],
    [{ url: 'http://p/tenants', token: SECRET }, /bare origin/],
    [{ url: 'http://p', token: 'a b' }, /visible ASCII/],
    [{ url: 'http://p', token: SECRET, timeoutMs: 0 }, /timeoutMs/],
    [{ url: 'http://p', token: SECRET, createTimeoutMs: Number.NaN }, /createTimeoutMs/],
  ])('refuses %j', (options, message) => {
    expect(() => createHttpOrchestrator(options)).toThrow(message)
  })

  test('an https origin is accepted', () => {
    const https = createHttpOrchestrator({ url: 'https://provisioner.internal', token: SECRET })
    expect(https.available).toBe(true)
    https.close()
  })
})
