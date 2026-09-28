import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import type { z } from 'zod'

/**
 * The wire under the provisioner's Docker client (plan `tenant-orchestrator`,
 * Task 3): one HTTP request to the Docker Engine API over its unix socket,
 * under one deadline for the whole exchange and a hard cap on what is read.
 *
 * Secret hygiene is structural. A request body may carry a tenant's env and
 * an exec's output carries an owner token, so no error built here quotes
 * either: an error names the operation, the status, an errno code and at
 * most Docker's own `message` — stripped of control characters, with every
 * value the caller marked as sensitive replaced, and cut to 200 characters.
 * A body that is not Docker's `{message}` JSON is not quoted at all.
 *
 * Sockets come from the client's own agent, never `http.globalAgent`.
 */

/** Docker's JSON answers here are kilobytes; anything past this is not an answer we want. */
export const DOCKER_MAX_RESPONSE_BYTES = 1024 * 1024
/** The longest piece of Docker's `message` an error repeats. */
export const DOCKER_MESSAGE_MAX_CHARS = 200

const MAX_POOLED_SOCKETS = 8
const ERRNO_CODE_PATTERN = /^[A-Z0-9_]{1,40}$/
/** C0/C1 controls, zero-width and bidi overrides: none of them belongs in a log line. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g
/** `text` with every run of unsafe characters folded to one space, fit for a log line. */
export function printable(text: string): string {
  return text.replace(UNSAFE_CHARS, ' ')
}
/** Shorter values (`1`, `true`) are not secrets, and replacing them would garble the message. */
const MIN_REDACTED_LENGTH = 6
const REDACTED = '[redacted]'
const ELLIPSIS = '…'

export type DockerFailure = 'http-status' | 'timeout' | 'unreachable' | 'bad-response'

export class DockerApiError extends Error {
  override readonly name = 'DockerApiError'
  readonly failure: DockerFailure
  /** The HTTP status, for `http-status`. */
  readonly status: number | undefined
  /** True for a 404: the object is not there, so an idempotent removal is done. */
  readonly notFound: boolean
  /** Docker's own `message`, sanitised, redacted and cut; for `http-status`. */
  readonly dockerMessage: string | undefined

  constructor(failure: DockerFailure, message: string, details: { readonly status?: number; readonly dockerMessage?: string } = {}) {
    super(message)
    this.failure = failure
    this.status = details.status
    this.notFound = details.status === 404
    this.dockerMessage = details.dockerMessage
  }
}

export interface WireRequest {
  /** Names the call in errors, e.g. `container create`. */
  readonly operation: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  /** Already-encoded path without the version prefix, e.g. `/containers/abc/start`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  /** Sent as JSON. */
  readonly body?: unknown
  /** Values this request carries that Docker might echo in an error (env values). */
  readonly redact?: readonly string[]
  /** Overrides the client's per-request deadline. */
  readonly timeoutMs?: number
}

export interface WireResponse {
  readonly status: number
  readonly body: Buffer
}

export interface Wire {
  /** One request, the answer read whole (≤ 1 MiB). */
  send(request: WireRequest): Promise<WireResponse>
  /** One request whose 200 body is handed over chunk by chunk; any other status is an error. */
  stream(request: WireRequest, onChunk: (chunk: Buffer) => void): Promise<void>
  /** Destroys the socket pool; later calls fail without reaching the daemon. */
  close(): void
}

export interface WireOptions {
  readonly socketPath: string
  readonly apiVersion: string
  readonly timeoutMs: number
}

interface Settle<T> {
  done(value: T): void
  fail(error: DockerApiError): void
}

const HTTP_OK = 200

export function createWire(options: WireOptions): Wire {
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_POOLED_SOCKETS })
  let closed = false
  const refuseIfClosed = (request: WireRequest): Promise<never> | undefined =>
    closed ? Promise.reject(new DockerApiError('unreachable', `${request.operation}: the Docker client is closed`)) : undefined
  return {
    send: (request) =>
      refuseIfClosed(request) ??
      exchange<WireResponse>(options, agent, request, (res, settle) =>
        readBounded(res, request.operation, settle.fail, (body) => settle.done({ status: res.statusCode ?? 0, body })),
      ),
    stream: (request, onChunk) =>
      refuseIfClosed(request) ?? exchange<void>(options, agent, request, (res, settle) => pipeOrFail(res, request, onChunk, settle)),
    close: () => {
      closed = true
      agent.destroy()
    },
  }
}

/** Throws the status error unless `response.status` is one of `accepted`. */
export function expectStatus(response: WireResponse, request: WireRequest, accepted: readonly number[]): void {
  if (!accepted.includes(response.status)) throw statusError(request, response.status, response.body)
}

/** The answer parsed against `schema`; a failure names fields, never values. */
export function parseAnswer<S extends z.ZodType>(response: WireResponse, operation: string, schema: S): z.output<S> {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch {
    // The parser's own message quotes the input.
    throw new DockerApiError('bad-response', `${operation}: the answer is not JSON`)
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
    throw new DockerApiError('bad-response', `${operation}: unexpected answer shape (${fields.join(', ')})`)
  }
  return result.data
}

function statusError(request: WireRequest, status: number, body: Buffer): DockerApiError {
  const dockerMessage = dockerMessageOf(body, request.redact ?? [])
  const suffix = dockerMessage === undefined ? '' : `: ${dockerMessage}`
  return new DockerApiError('http-status', `${request.operation}: Docker answered HTTP ${status}${suffix}`, {
    status,
    ...(dockerMessage === undefined ? {} : { dockerMessage }),
  })
}

/** Docker's `{message}`, made safe to log; undefined when the body is anything else. */
function dockerMessageOf(body: Buffer, redact: readonly string[]): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
  const raw = (parsed as { message?: unknown } | null)?.message
  if (typeof raw !== 'string') return undefined
  const redacted = redact
    .map(printable)
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .reduce((text, value) => text.split(value).join(REDACTED), printable(raw))
    .trim()
  if (redacted === '') return undefined
  return redacted.length <= DOCKER_MESSAGE_MAX_CHARS ? redacted : `${redacted.slice(0, DOCKER_MESSAGE_MAX_CHARS - 1)}${ELLIPSIS}`
}

function pathOf(apiVersion: string, request: WireRequest): string {
  const query = request.query === undefined ? '' : `?${new URLSearchParams(request.query).toString()}`
  return `/${apiVersion}${request.path}${query}`
}

/**
 * One request; `onResponse` settles it. Whatever goes wrong settles the
 * promise exactly once with a `DockerApiError` carrying no request content.
 */
function exchange<T>(
  options: WireOptions,
  agent: Agent,
  request: WireRequest,
  onResponse: (res: IncomingMessage, settle: Settle<T>) => void,
): Promise<T> {
  const { operation } = request
  const payload = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8')
  const headers = {
    accept: 'application/json',
    ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
  }
  const timeoutMs = request.timeoutMs ?? options.timeoutMs
  const requestOptions = { socketPath: options.socketPath, path: pathOf(options.apiVersion, request), method: request.method, headers, agent }
  return new Promise<T>((resolve, reject) => {
    let req: ClientRequest
    try {
      req = httpRequest(requestOptions)
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
    const fail = (error: DockerApiError): void =>
      finish(() => {
        req.destroy()
        reject(error)
      })
    const timer = setTimeout(() => fail(new DockerApiError('timeout', `${operation}: no answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref()
    req.on('response', (res) => onResponse(res, { done: (value) => finish(() => resolve(value)), fail }))
    req.on('error', (error: unknown) => fail(unreachableError(operation, error)))
    req.end(payload)
  })
}

/**
 * A 200 body goes to `onChunk` as it arrives, until the daemon closes the
 * connection (exec start answers without a length). `onChunk` may throw to
 * stop the exchange; anything that is not a `DockerApiError` is reported as
 * a malformed stream without its message.
 */
function pipeOrFail(res: IncomingMessage, request: WireRequest, onChunk: (chunk: Buffer) => void, settle: Settle<void>): void {
  const status = res.statusCode ?? 0
  if (status !== HTTP_OK) {
    readBounded(res, request.operation, settle.fail, (body) => settle.fail(statusError(request, status, body)))
    return
  }
  res.on('data', (chunk: Buffer) => {
    try {
      onChunk(chunk)
    } catch (error: unknown) {
      settle.fail(
        error instanceof DockerApiError ? error : new DockerApiError('bad-response', `${request.operation}: the output stream is malformed`),
      )
    }
  })
  res.on('end', () => settle.done(undefined))
  res.on('error', (error: unknown) => settle.fail(unreachableError(request.operation, error)))
}

function readBounded(res: IncomingMessage, operation: string, fail: (error: DockerApiError) => void, done: (body: Buffer) => void): void {
  const tooLarge = (): DockerApiError =>
    new DockerApiError('bad-response', `${operation}: the answer exceeds ${DOCKER_MAX_RESPONSE_BYTES} bytes`)
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > DOCKER_MAX_RESPONSE_BYTES) {
    fail(tooLarge())
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  res.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > DOCKER_MAX_RESPONSE_BYTES) {
      fail(tooLarge())
      return
    }
    chunks.push(chunk)
  })
  res.on('end', () => done(Buffer.concat(chunks)))
  res.on('error', (error: unknown) => fail(unreachableError(operation, error)))
}

/** Names the errno code only; a socket error's message repeats the socket path. */
function unreachableError(operation: string, error: unknown): DockerApiError {
  const code = (error as { code?: unknown } | null)?.code
  const detail = typeof code === 'string' && ERRNO_CODE_PATTERN.test(code) ? ` (${code})` : ''
  return new DockerApiError('unreachable', `${operation}: the Docker daemon could not be reached${detail}`)
}
