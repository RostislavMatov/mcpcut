import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { z } from 'zod'

/**
 * The hub's GitHub client (plan `hub-signin-accounts`, Task 3): the authorize
 * URL, the code exchange (PKCE), the authenticated-user profile, and the
 * revocation that ends every sign-in — the hub keeps no GitHub token (H4).
 *
 * Secret hygiene is structural, not a matter of care at call sites: no error
 * built here quotes a request or response body, a header, a token, the
 * client secret, or a parser's message (V8's `JSON.parse` errors quote the
 * input, which for the exchange IS the token). Errors name the operation, a
 * status, a validated OAuth error code, or schema field names — nothing a
 * log line could leak. The client itself never logs.
 *
 * Sockets come from the client's own agents, never `http(s).globalAgent`:
 * the process-wide pool is shared with every other request the process makes
 * and a socket in it is reused without a fresh lookup. `close()` destroys the
 * client's pool.
 */

export const GITHUB_WEB_BASE = 'https://github.com'
export const GITHUB_API_BASE = 'https://api.github.com'
/** Per request, covering connect, headers and the whole body. */
export const GITHUB_TIMEOUT_MS = 10_000
/** GitHub's answers here are a few hundred bytes; anything past this is not GitHub. */
export const GITHUB_MAX_RESPONSE_BYTES = 64 * 1024

const USER_AGENT = 'mcpcut-hub'
const API_VERSION = '2022-11-28'
const API_MEDIA_TYPE = 'application/vnd.github+json'
const MAX_POOLED_SOCKETS = 16
const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
/** Visible ASCII only: a token goes into a header, and CR/LF there would split it. */
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,1024}$/
/** OAuth error codes are `snake_case` words; anything else is not echoed. */
const OAUTH_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/
const ERRNO_CODE_PATTERN = /^[A-Z0-9_]{1,40}$/
/** GitHub's own rule for usernames. */
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/
/** Plain `http:` only to this machine, so a misconfigured base cannot ship the secret in clear. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type GithubFailure = 'timeout' | 'unreachable' | 'http-status' | 'oauth-error' | 'bad-response' | 'invalid-token'

export class GithubError extends Error {
  override readonly name = 'GithubError'
  readonly failure: GithubFailure
  /** The HTTP status, for `http-status`. */
  readonly status: number | undefined
  /** The OAuth `error` code (or `unrecognized`), for `oauth-error`. */
  readonly oauthError: string | undefined

  constructor(failure: GithubFailure, message: string, details: { status?: number; oauthError?: string } = {}) {
    super(message)
    this.failure = failure
    this.status = details.status
    this.oauthError = details.oauthError
  }
}

/** The only three facts the hub keeps about a GitHub account. */
export interface GithubProfile {
  /** The stable key (H3); `login` changes and is recycled. */
  readonly id: number
  readonly login: string
  /** ISO 8601, as GitHub sent it. */
  readonly createdAt: string
}

export interface GithubClientOptions {
  readonly clientId: string
  readonly clientSecret: string
  /** The registered callback, verbatim — never derived from a request. */
  readonly redirectUri: string
  readonly webBase?: string
  readonly apiBase?: string
  readonly timeoutMs?: number
}

export interface GithubClient {
  authorizeUrl(input: { readonly state: string; readonly codeChallenge: string }): string
  /** Resolves to the access token; rejects with `GithubError`. */
  exchangeCode(input: { readonly code: string; readonly verifier: string }): Promise<string>
  fetchProfile(accessToken: string): Promise<GithubProfile>
  revokeToken(accessToken: string): Promise<void>
  /**
   * Destroys the client's socket pool, aborting every request in flight. One
   * client serves the whole process: this is for shutdown, never for the end
   * of one sign-in.
   */
  close(): void
}

export interface AuthorizeUrlInput {
  readonly webBase?: string
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}

/** GitHub's authorize page for this flow. Empty scope: `/user` needs none. */
export function authorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL('/login/oauth/authorize', input.webBase ?? GITHUB_WEB_BASE)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('allow_signup', 'true')
  return url.href
}

const TokenAnswerSchema = z.object({ access_token: z.string().regex(ACCESS_TOKEN_PATTERN) })

const ProfileSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().regex(LOGIN_PATTERN),
  // Validates the calendar too: `2019-02-30T…` is refused, not rolled over.
  created_at: z.iso.datetime(),
})

interface ClientConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly webBase: string
  readonly apiBase: string
  readonly timeoutMs: number
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const config = validatedConfig(options)
  const agents = {
    http: new HttpAgent({ keepAlive: true, maxSockets: MAX_POOLED_SOCKETS }),
    https: new HttpsAgent({ keepAlive: true, maxSockets: MAX_POOLED_SOCKETS }),
  }
  const send = (request: WireRequest): Promise<WireResponse> => sendBounded(request, agents, config.timeoutMs)
  return {
    authorizeUrl: ({ state, codeChallenge }) =>
      authorizeUrl({ webBase: config.webBase, clientId: config.clientId, redirectUri: config.redirectUri, state, codeChallenge }),
    exchangeCode: (input) => exchangeCode(config, send, input),
    fetchProfile: (token) => fetchProfile(config, send, token),
    revokeToken: (token) => revokeToken(config, send, token),
    close: () => {
      agents.http.destroy()
      agents.https.destroy()
    },
  }
}

// ---------------------------------------------------------------------------
// Operations

type Send = (request: WireRequest) => Promise<WireResponse>

async function exchangeCode(
  config: ClientConfig,
  send: Send,
  input: { readonly code: string; readonly verifier: string },
): Promise<string> {
  const operation = 'GitHub code exchange'
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: input.verifier,
  }).toString()
  const response = await send({
    operation,
    method: 'POST',
    url: new URL('/login/oauth/access_token', config.webBase),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const answer = jsonObjectOf(response, HTTP_OK, operation)
  // GitHub reports a refused exchange as 200 with `{error: …}`.
  if (Object.hasOwn(answer, 'error')) {
    const raw = answer['error']
    const code = typeof raw === 'string' && OAUTH_ERROR_PATTERN.test(raw) ? raw : 'unrecognized'
    throw new GithubError('oauth-error', `${operation}: GitHub refused the code (${code})`, { oauthError: code })
  }
  const parsed = TokenAnswerSchema.safeParse(answer)
  if (!parsed.success) throw new GithubError('bad-response', `${operation}: the answer carries no usable access token`)
  return parsed.data.access_token
}

async function fetchProfile(config: ClientConfig, send: Send, token: string): Promise<GithubProfile> {
  const operation = 'GitHub profile request'
  assertTokenForm(token, operation)
  const response = await send({
    operation,
    method: 'GET',
    url: new URL('/user', config.apiBase),
    headers: { accept: API_MEDIA_TYPE, 'x-github-api-version': API_VERSION, authorization: `Bearer ${token}` },
  })
  const parsed = ProfileSchema.safeParse(jsonObjectOf(response, HTTP_OK, operation))
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
    throw new GithubError('bad-response', `${operation}: unexpected shape (${fields.join(', ')})`)
  }
  return { id: parsed.data.id, login: parsed.data.login, createdAt: parsed.data.created_at }
}

async function revokeToken(config: ClientConfig, send: Send, token: string): Promise<void> {
  const operation = 'GitHub token revocation'
  assertTokenForm(token, operation)
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
  const response = await send({
    operation,
    method: 'DELETE',
    url: new URL(`/applications/${encodeURIComponent(config.clientId)}/token`, config.apiBase),
    headers: {
      accept: API_MEDIA_TYPE,
      'x-github-api-version': API_VERSION,
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_token: token }),
  })
  if (response.status !== HTTP_NO_CONTENT) throw statusError(operation, response.status)
}

function assertTokenForm(token: string, operation: string): void {
  if (!ACCESS_TOKEN_PATTERN.test(token)) throw new GithubError('invalid-token', `${operation}: the access token has an invalid form`)
}

function jsonObjectOf(response: WireResponse, expectedStatus: number, operation: string): Record<string, unknown> {
  if (response.status !== expectedStatus) throw statusError(operation, response.status)
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch {
    // The parser's own message quotes the input; it must not travel.
    throw new GithubError('bad-response', `${operation}: the answer is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GithubError('bad-response', `${operation}: the answer is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function statusError(operation: string, status: number): GithubError {
  return new GithubError('http-status', `${operation}: GitHub answered HTTP ${status}`, { status })
}

// ---------------------------------------------------------------------------
// Configuration

function validatedConfig(options: GithubClientOptions): ClientConfig {
  if (options.clientId === '') throw new TypeError('createGithubClient: clientId is empty')
  if (options.clientSecret === '') throw new TypeError('createGithubClient: clientSecret is empty')
  if (!URL.canParse(options.redirectUri)) throw new TypeError('createGithubClient: redirectUri is not an absolute URL')
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`createGithubClient: timeoutMs must be a positive finite number, got ${timeoutMs}`)
  }
  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    webBase: baseOriginOf(options.webBase ?? GITHUB_WEB_BASE, 'webBase'),
    apiBase: baseOriginOf(options.apiBase ?? GITHUB_API_BASE, 'apiBase'),
    timeoutMs,
  }
}

/** A base is a bare origin: every path the client uses is absolute from it. */
function baseOriginOf(base: string, label: string): string {
  const refuse = (why: string): never => {
    throw new TypeError(`createGithubClient: ${label} ${why}`)
  }
  if (!URL.canParse(base)) return refuse('is not an absolute URL')
  const url = new URL(base)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('must be https')
  if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) refuse('may use http only on loopback')
  if (url.username !== '' || url.password !== '') refuse('must not carry credentials')
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') refuse('must be a bare origin')
  return url.origin
}

// ---------------------------------------------------------------------------
// Wire

interface WireRequest {
  readonly operation: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

interface WireResponse {
  readonly status: number
  readonly body: Buffer
}

interface Agents {
  readonly http: HttpAgent
  readonly https: HttpsAgent
}

/**
 * One request under a single deadline for the whole exchange and a hard cap
 * on the body. Whatever goes wrong settles the promise exactly once with a
 * `GithubError` whose message carries no request or response content.
 */
function sendBounded(request: WireRequest, agents: Agents, timeoutMs: number): Promise<WireResponse> {
  const { operation, url } = request
  const isHttps = url.protocol === 'https:'
  const payload = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8')
  const headers = {
    ...request.headers,
    'user-agent': USER_AGENT,
    ...(payload === undefined ? {} : { 'content-length': String(payload.length) }),
  }
  const options = { method: request.method, headers, agent: isHttps ? agents.https : agents.http }
  return new Promise((resolve, reject) => {
    let req: ClientRequest
    try {
      req = isHttps ? httpsRequest(url, options) : httpRequest(url, options)
    } catch (error: unknown) {
      // A synchronous throw would otherwise reject with the raw error, outside
      // the `GithubError` contract and its hygiene.
      reject(unreachableError(operation, error))
      return
    }
    let settled = false
    const timer = setTimeout(() => fail(new GithubError('timeout', `${operation}: no answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref()
    function finish(outcome: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    function fail(error: GithubError): void {
      finish(() => {
        req.destroy()
        reject(error)
      })
    }
    req.on('response', (res) => readBounded(res, operation, fail, (body) => finish(() => resolve({ status: res.statusCode ?? 0, body }))))
    req.on('error', (error: unknown) => fail(unreachableError(operation, error)))
    req.end(payload)
  })
}

function readBounded(
  res: IncomingMessage,
  operation: string,
  fail: (error: GithubError) => void,
  done: (body: Buffer) => void,
): void {
  const tooLarge = (): GithubError =>
    new GithubError('bad-response', `${operation}: the answer exceeds ${GITHUB_MAX_RESPONSE_BYTES} bytes`)
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > GITHUB_MAX_RESPONSE_BYTES) {
    fail(tooLarge())
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  res.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > GITHUB_MAX_RESPONSE_BYTES) {
      fail(tooLarge())
      return
    }
    chunks.push(chunk)
  })
  res.on('end', () => done(Buffer.concat(chunks)))
  res.on('error', (error: unknown) => fail(unreachableError(operation, error)))
}

/** Names the errno code only; a socket error's message is not ours to repeat. */
function unreachableError(operation: string, error: unknown): GithubError {
  const code = (error as { code?: unknown } | null)?.code
  const detail = typeof code === 'string' && ERRNO_CODE_PATTERN.test(code) ? ` (${code})` : ''
  return new GithubError('unreachable', `${operation}: GitHub could not be reached${detail}`)
}
