import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { headerValue, parseTarget, readBody } from '../http.js'
import { describeOrchestratorError } from '../orchestrator.js'
import { ProvisionerError, type ProvisionerErrorCode } from './errors.js'
import type { ProvisionerService } from './service.js'
import { printable } from './docker-wire.js'
import { PROVISIONER_SOCKET_TIMEOUT_MS } from './timeouts.js'

/**
 * The provisioner's HTTP API for the hub (plan `tenant-orchestrator`,
 * Task 4, O1; plan `hosted-path-and-ops`, Task C). Six operations and a
 * health check, nothing else:
 *
 *   GET    /healthz                    → 200 "ok" (no secret needed)
 *   POST   /tenants                    {subdomain, login, githubId} → 201 {ownerToken}
 *   POST   /tenants/:sub/owner-token   → 200 {ownerToken}
 *   DELETE /tenants/:sub               → 204
 *   POST   /tenants/:sub/stop          → 204 (idempotent)
 *   POST   /tenants/:sub/start         → 204 (idempotent)
 *   GET    /tenants/:sub               → 200 {state, sizeBytes, running, lastActivityAt}
 *
 * The Bearer secret is checked FIRST, before the route or the body is looked
 * at, and in constant time (sha256 digests of equal length). A body is JSON,
 * at most 4 KiB, with exactly the three fields; everything else is refused
 * before the service — let alone Docker — is reached. Errors answer
 * `{error: <code>, message}` built from fixed text; an owner token appears
 * only in the body of a successful create or rotate, never in a log line.
 */

export const PROVISIONER_MAX_BODY_BYTES = 4 * 1024
export const PROVISIONER_HEADERS_TIMEOUT_MS = 10_000
/** Receiving the request only; a create's answer may take up to its readiness wait. */
export const PROVISIONER_REQUEST_TIMEOUT_MS = 10_000
/** Idle socket bound, longer than the hub waits for the slowest create (`timeouts.ts`). */
export { PROVISIONER_SOCKET_TIMEOUT_MS } from './timeouts.js'
export const PROVISIONER_KEEP_ALIVE_TIMEOUT_MS = 5_000

const BEARER_PREFIX = 'Bearer '
const TENANT_PATH = /^\/tenants\/([a-z0-9-]{1,63})$/
const OWNER_TOKEN_PATH = /^\/tenants\/([a-z0-9-]{1,63})\/owner-token$/
const POWER_PATH = /^\/tenants\/([a-z0-9-]{1,63})\/(stop|start)$/

const CreateBody = z.strictObject({
  subdomain: z.string().max(63),
  login: z.string().max(39),
  githubId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

const STATUS_OF: Readonly<Record<ProvisionerErrorCode, number>> = {
  'invalid-input': 400,
  exists: 409,
  'not-found': 404,
  'not-ours': 409,
  capacity: 507,
  'not-ready': 503,
  'bad-output': 502,
  docker: 502,
  internal: 500,
}

export interface ProvisionerServerOptions {
  readonly service: ProvisionerService
  /** The Bearer secret the hub presents. */
  readonly token: string
  /** One line per request outcome; never a token or a body. */
  readonly log?: (line: string) => void
}

export interface ProvisionerServer {
  listen(port: number, host: string): Promise<{ readonly port: number }>
  close(): Promise<void>
}

interface Answer {
  readonly status: number
  readonly body?: unknown
  /** Close the connection after answering: the request body was not read to its end. */
  readonly close?: boolean
}

interface Deps {
  readonly service: ProvisionerService
  readonly tokenDigest: Buffer
  readonly log: (line: string) => void
}

export function createProvisionerServer(options: ProvisionerServerOptions): ProvisionerServer {
  if (options.token.length === 0) throw new TypeError('createProvisionerServer: token is empty')
  const deps: Deps = {
    service: options.service,
    tokenDigest: digest(options.token),
    log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
  }
  let server: Server | null = null
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(deps, req, res).catch((error: unknown) => {
      deps.log(`[provisioner] request failed: ${describeOrchestratorError(error)}`)
      if (!res.headersSent) write(res, { status: 500, body: { error: 'internal', message: 'internal error' } })
      else res.destroy()
    })
  }
  return Object.freeze({
    listen: async (port: number, host: string) => {
      const bound = await bind(onRequest, port, host)
      server = bound.instance
      return { port: bound.port }
    },
    close: async () => {
      const instance = server
      server = null
      if (instance === null) return
      const closed = new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())))
      instance.closeAllConnections()
      await closed
    },
  })
}

async function handle(deps: Deps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path } = parseTarget(req.url)
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('ok\n')
    return
  }
  if (!isAuthorized(deps.tokenDigest, headerValue(req.headers, 'authorization'))) {
    // The body is never read for an unauthenticated request: the connection closes after the answer.
    write(res, { status: 401, body: { error: 'unauthorized', message: 'a valid Bearer token is required' }, close: true })
    return
  }
  write(res, await route(deps, req, path))
}

async function route(deps: Deps, req: IncomingMessage, path: string): Promise<Answer> {
  const method = req.method ?? ''
  const tenant = TENANT_PATH.exec(path)?.[1]
  const rotating = OWNER_TOKEN_PATH.exec(path)?.[1]
  const power = POWER_PATH.exec(path)
  if (path === '/tenants') return method === 'POST' ? createTenant(deps, req) : notAllowed()
  if (rotating !== undefined) return method === 'POST' ? run(deps, 'rotate', rotating, () => rotate(deps, rotating)) : notAllowed()
  if (power !== null) return method === 'POST' ? switchPower(deps, power[1] as string, power[2] === 'stop' ? 'stop' : 'start') : notAllowed()
  if (tenant === undefined) return { status: 404, body: { error: 'not-found', message: 'no such route' } }
  if (method === 'DELETE') return run(deps, 'remove', tenant, () => remove(deps, tenant))
  if (method === 'GET') return run(deps, 'status', tenant, async () => ({ status: 200, body: await deps.service.status(tenant) }))
  return notAllowed()
}

async function createTenant(deps: Deps, req: IncomingMessage): Promise<Answer> {
  const contentType = headerValue(req.headers, 'content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { status: 415, body: { error: 'invalid-input', message: 'the body must be application/json' } }
  }
  const read = await readBody(req, PROVISIONER_MAX_BODY_BYTES)
  if (!read.ok) {
    return { status: 413, body: { error: 'invalid-input', message: `the body exceeds ${PROVISIONER_MAX_BODY_BYTES} bytes` }, close: true }
  }
  const input = parseCreateBody(read.body)
  if (input === undefined) {
    return { status: 400, body: { error: 'invalid-input', message: 'the body must be {subdomain, login, githubId}' } }
  }
  return run(deps, 'create', input.subdomain, async () => ({ status: 201, body: { ownerToken: (await deps.service.create(input)).ownerToken } }))
}

function parseCreateBody(body: Buffer): z.output<typeof CreateBody> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
  const result = CreateBody.safeParse(parsed)
  return result.success ? result.data : undefined
}

async function rotate(deps: Deps, subdomain: string): Promise<Answer> {
  return { status: 200, body: { ownerToken: (await deps.service.rotateOwnerToken(subdomain)).ownerToken } }
}

async function remove(deps: Deps, subdomain: string): Promise<Answer> {
  await deps.service.remove(subdomain)
  return { status: 204 }
}

function switchPower(deps: Deps, subdomain: string, operation: 'stop' | 'start'): Promise<Answer> {
  return run(deps, operation, subdomain, async () => {
    await (operation === 'stop' ? deps.service.stop(subdomain) : deps.service.start(subdomain))
    return { status: 204 }
  })
}

/** Runs one operation, logs its outcome (never its body), maps a failure to its status. */
async function run(deps: Deps, operation: string, subdomain: string, task: () => Promise<Answer>): Promise<Answer> {
  // A create body's subdomain is logged before it is validated; one line per event.
  const shown = printable(subdomain)
  try {
    const answer = await task()
    if (operation !== 'status') deps.log(`[provisioner] ${operation} ${shown}: ok`)
    return answer
  } catch (error: unknown) {
    if (!(error instanceof ProvisionerError)) throw error
    deps.log(`[provisioner] ${operation} ${shown}: ${error.code} — ${printable(describeOrchestratorError(error))}`)
    return { status: STATUS_OF[error.code], body: { error: error.code, message: error.message } }
  }
}

function notAllowed(): Answer {
  return { status: 405, body: { error: 'method-not-allowed', message: 'method not allowed' } }
}

function isAuthorized(expected: Buffer, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return false
  const presented = header.slice(BEARER_PREFIX.length)
  if (presented.length === 0) return false
  return timingSafeEqual(digest(presented), expected)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function write(res: ServerResponse, answer: Answer): void {
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...(answer.close === true ? { connection: 'close' } : {}) }
  if (answer.body === undefined) {
    res.writeHead(answer.status, headers).end()
    return
  }
  const payload = JSON.stringify(answer.body)
  res
    .writeHead(answer.status, { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
    .end(payload)
}

function bind(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  port: number,
  host: string,
): Promise<{ readonly instance: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const instance = createServer(onRequest)
    instance.headersTimeout = PROVISIONER_HEADERS_TIMEOUT_MS
    instance.requestTimeout = PROVISIONER_REQUEST_TIMEOUT_MS
    instance.keepAliveTimeout = PROVISIONER_KEEP_ALIVE_TIMEOUT_MS
    instance.timeout = PROVISIONER_SOCKET_TIMEOUT_MS
    instance.once('error', reject)
    instance.listen(port, host, () => {
      instance.removeListener('error', reject)
      const address = instance.address()
      if (address === null || typeof address === 'string') {
        instance.close()
        reject(new Error('provisioner server: listener has no TCP address'))
        return
      }
      resolve({ instance, port: address.port })
    })
  })
}
