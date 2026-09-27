import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { z } from 'zod'
import {
  unavailableOrchestrator,
  type CreateInstallInput,
  type InstallInspection,
  type Orchestrator,
  type OwnerTokenGrant,
} from './orchestrator.js'
import { CREATE_TIMEOUT_MS } from './provisioner/timeouts.js'

/**
 * The hub's orchestrator over the provisioner's HTTP API (plan
 * `tenant-orchestrator`, Task 5, O1). The hub never speaks Docker: it asks
 * the provisioner — the one process with the Docker socket — for exactly the
 * operations the `Orchestrator` interface names.
 *
 * Secret hygiene is structural, as in `github.ts`: no error built here quotes
 * a response body (a create's body IS an owner token), a header (the Bearer
 * secret) or a parser's message. An error names the operation, a status and
 * the provisioner's error code when that code is one word; nothing else.
 * Sockets come from the client's own agents, never the global pool.
 */

/** A create waits for the install to come up; the budget against the provisioner's own waits is in `provisioner/timeouts.ts`. */
export { CREATE_TIMEOUT_MS } from './provisioner/timeouts.js'
/** Rotate is one exec; remove and stop are a stop (10 s grace) and a few calls; a status may wait for a rotate under the provisioner's lock. */
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_RESPONSE_BYTES = 16 * 1024

const ERROR_CODE_PATTERN = /^[a-z][a-z-]{0,39}$/
const ERRNO_CODE_PATTERN = /^[A-Z0-9_]{1,40}$/
/** Visible ASCII only: the token is shown to its person and pasted into a client config. */
const OWNER_TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/
const SUBDOMAIN_PATTERN = /^[a-z0-9-]{1,63}$/
const HTTP_OK = 200
const HTTP_CREATED = 201
const HTTP_NO_CONTENT = 204

export type OrchestratorHttpFailure = 'timeout' | 'unreachable' | 'http-status' | 'bad-response' | 'invalid-input'

export class OrchestratorHttpError extends Error {
  override readonly name = 'OrchestratorHttpError'
  readonly failure: OrchestratorHttpFailure
  readonly status: number | undefined
  /** The provisioner's `error` code, when it sent a well-formed one. */
  readonly code: string | undefined

  constructor(failure: OrchestratorHttpFailure, message: string, details: { status?: number; code?: string } = {}) {
    super(message)
    this.failure = failure
    this.status = details.status
    this.code = details.code
  }
}

export interface HttpOrchestratorOptions {
  /** The provisioner's origin, e.g. `http://provisioner:8093`. */
  readonly url: string
  /** The Bearer secret the provisioner expects. */
  readonly token: string
  /** Per request for rotate and remove. */
  readonly timeoutMs?: number
  readonly createTimeoutMs?: number
}

/** An `Orchestrator` that also owns a socket pool; `close()` is for shutdown. */
export interface HttpOrchestrator extends Orchestrator {
  close(): void
}

const TokenAnswer = z.object({ ownerToken: z.string().regex(OWNER_TOKEN_PATTERN) })
const ErrorAnswer = z.object({ error: z.string() })
const InspectAnswer = z.object({
  state: z.string(),
  running: z.boolean(),
  lastActivityAt: z.iso.datetime().nullable(),
})
/** The provisioner's `state` for a subdomain it holds nothing for (`provisioner/service.ts`). */
const ABSENT_STATE = 'absent'

interface Config {
  readonly base: URL
  readonly authorization: string
  readonly timeoutMs: number
  readonly createTimeoutMs: number
}

interface Agents {
  readonly http: HttpAgent
  readonly https: HttpsAgent
}

export function createHttpOrchestrator(options: HttpOrchestratorOptions): HttpOrchestrator {
  const config = validatedConfig(options)
  const agents: Agents = { http: new HttpAgent({ keepAlive: false }), https: new HttpsAgent({ keepAlive: false }) }
  const send: Send = (request) => sendBounded(config, agents, request)
  return Object.freeze({
    available: true,
    create: (input: CreateInstallInput) => create(config, send, input),
    rotateOwnerToken: (subdomain: string) => rotate(send, subdomain),
    remove: (subdomain: string) => remove(send, subdomain),
    stop: (subdomain: string) => power(send, subdomain, 'stop'),
    start: (subdomain: string) => power(send, subdomain, 'start'),
    inspect: (subdomain: string) => inspect(send, subdomain),
    close: () => {
      agents.http.destroy()
      agents.https.destroy()
    },
  })
}

// ---------------------------------------------------------------------------
// Operations

interface WireRequest {
  readonly operation: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly timeoutMs?: number
}

interface WireResponse {
  readonly status: number
  readonly body: Buffer
}

type Send = (request: WireRequest) => Promise<WireResponse>

async function create(config: Config, send: Send, input: CreateInstallInput): Promise<OwnerTokenGrant> {
  const operation = 'provisioner create'
  const response = await send({
    operation,
    method: 'POST',
    path: '/tenants',
    body: { subdomain: input.subdomain, login: input.login, githubId: input.githubId },
    timeoutMs: config.createTimeoutMs,
  })
  return tokenOf(response, HTTP_CREATED, operation)
}

async function rotate(send: Send, subdomain: string): Promise<OwnerTokenGrant> {
  const operation = 'provisioner rotate'
  const response = await send({ operation, method: 'POST', path: `${tenantPath(subdomain, operation)}/owner-token` })
  return tokenOf(response, HTTP_OK, operation)
}

async function remove(send: Send, subdomain: string): Promise<void> {
  const operation = 'provisioner remove'
  const response = await send({ operation, method: 'DELETE', path: tenantPath(subdomain, operation) })
  if (response.status !== HTTP_NO_CONTENT) throw statusError(operation, response)
}

async function power(send: Send, subdomain: string, action: 'stop' | 'start'): Promise<void> {
  const operation = `provisioner ${action}`
  const response = await send({ operation, method: 'POST', path: `${tenantPath(subdomain, operation)}/${action}` })
  if (response.status !== HTTP_NO_CONTENT) throw statusError(operation, response)
}

async function inspect(send: Send, subdomain: string): Promise<InstallInspection> {
  const operation = 'provisioner inspect'
  const response = await send({ operation, method: 'GET', path: tenantPath(subdomain, operation) })
  if (response.status !== HTTP_OK) throw statusError(operation, response)
  const parsed = InspectAnswer.safeParse(jsonOf(response.body))
  if (!parsed.success) throw new OrchestratorHttpError('bad-response', `${operation}: the answer is not a tenant status`)
  const { state, running, lastActivityAt } = parsed.data
  return { state: state === ABSENT_STATE ? 'absent' : 'present', running, lastActivityAt }
}

function tenantPath(subdomain: string, operation: string): string {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) throw new OrchestratorHttpError('invalid-input', `${operation}: not a subdomain`)
  return `/tenants/${subdomain}`
}

function tokenOf(response: WireResponse, expected: number, operation: string): OwnerTokenGrant {
  if (response.status !== expected) throw statusError(operation, response)
  const parsed = TokenAnswer.safeParse(jsonOf(response.body))
  if (!parsed.success) throw new OrchestratorHttpError('bad-response', `${operation}: the answer carries no usable owner token`)
  return { ownerToken: parsed.data.ownerToken }
}

/** The status and, when well-formed, the provisioner's one-word code — never its message or body. */
function statusError(operation: string, response: WireResponse): OrchestratorHttpError {
  const answer = ErrorAnswer.safeParse(jsonOf(response.body))
  const code = answer.success && ERROR_CODE_PATTERN.test(answer.data.error) ? answer.data.error : undefined
  const detail = code === undefined ? '' : ` (${code})`
  return new OrchestratorHttpError('http-status', `${operation}: the provisioner answered HTTP ${response.status}${detail}`, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
  })
}

function jsonOf(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Configuration and wire

function validatedConfig(options: HttpOrchestratorOptions): Config {
  if (!URL.canParse(options.url)) throw new TypeError('createHttpOrchestrator: url is not an absolute URL')
  const base = new URL(options.url)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new TypeError('createHttpOrchestrator: url must be http(s)')
  if (base.username !== '' || base.password !== '') throw new TypeError('createHttpOrchestrator: url must not carry credentials')
  if (base.pathname !== '/' || base.search !== '' || base.hash !== '') throw new TypeError('createHttpOrchestrator: url must be a bare origin')
  if (!/^[\x21-\x7e]+$/.test(options.token)) throw new TypeError('createHttpOrchestrator: token must be visible ASCII')
  const timeoutMs = positive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const createTimeoutMs = positive(options.createTimeoutMs ?? CREATE_TIMEOUT_MS, 'createTimeoutMs')
  return { base, authorization: `Bearer ${options.token}`, timeoutMs, createTimeoutMs }
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`createHttpOrchestrator: ${label} must be a positive finite number`)
  return value
}

/** One request under one deadline and a hard cap on the answer; settles exactly once. */
function sendBounded(config: Config, agents: Agents, request: WireRequest): Promise<WireResponse> {
  const { operation } = request
  const url = new URL(request.path, config.base)
  const payload = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8')
  const headers = {
    authorization: config.authorization,
    accept: 'application/json',
    ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
  }
  const isHttps = url.protocol === 'https:'
  const options = { method: request.method, headers, agent: isHttps ? agents.https : agents.http }
  const timeoutMs = request.timeoutMs ?? config.timeoutMs
  return new Promise((resolve, reject) => {
    let req: ClientRequest
    try {
      req = isHttps ? httpsRequest(url, options) : httpRequest(url, options)
    } catch (error: unknown) {
      reject(unreachableError(operation, error))
      return
    }
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const fail = (error: OrchestratorHttpError): void =>
      finish(() => {
        req.destroy()
        reject(error)
      })
    const timer = setTimeout(() => fail(new OrchestratorHttpError('timeout', `${operation}: no answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref()
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) fail(new OrchestratorHttpError('bad-response', `${operation}: the answer exceeds ${MAX_RESPONSE_BYTES} bytes`))
        else chunks.push(chunk)
      })
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })))
      res.on('error', (error: unknown) => fail(unreachableError(operation, error)))
    })
    req.on('error', (error: unknown) => fail(unreachableError(operation, error)))
    req.end(payload)
  })
}

/** Names the errno code only; a socket error's message is not ours to repeat. */
function unreachableError(operation: string, error: unknown): OrchestratorHttpError {
  const code = (error as { code?: unknown } | null)?.code
  const detail = typeof code === 'string' && ERRNO_CODE_PATTERN.test(code) ? ` (${code})` : ''
  return new OrchestratorHttpError('unreachable', `${operation}: the provisioner could not be reached${detail}`)
}

/** What `serve` and the operator commands hold: an orchestrator and the way to release it. */
export interface OpenedOrchestrator {
  readonly orchestrator: Orchestrator
  close(): void
}

/**
 * The provisioner-backed orchestrator when the hub is configured with one,
 * `unavailableOrchestrator` (waitlist mode, H5) when it is not.
 */
export function openOrchestrator(link: { readonly url: string; readonly token: string } | undefined): OpenedOrchestrator {
  if (link === undefined) return { orchestrator: unavailableOrchestrator, close: () => undefined }
  const http = createHttpOrchestrator({ url: link.url, token: link.token })
  return { orchestrator: http, close: () => http.close() }
}
