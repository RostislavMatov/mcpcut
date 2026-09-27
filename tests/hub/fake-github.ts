import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
// `.ts`, not the `.js` the rest of the repo writes: `--serve` runs this file
// under Node's type stripping, which resolves specifiers literally.
import { accessTokenOf, parseBody, readBody } from './fake-github-bodies.ts'

/**
 * A local stand-in for the three GitHub endpoints the hub talks to (plan
 * `hub-signin-accounts`, Task 3): the code exchange on `github.com`, the
 * authenticated-user profile and the token revocation on `api.github.com`.
 * One `node:http` server on 127.0.0.1 plays both hosts — the client takes
 * both base URLs as parameters.
 *
 * It is strict on purpose, so a test passing against it says something about
 * the real thing: it checks the PKCE verifier against the challenge the code
 * was issued for (S256, computed here independently of `hub/src`), the exact
 * `redirect_uri`, the client secret, the headers GitHub requires
 * (`User-Agent` everywhere, the API version and media type on the API) and
 * Basic credentials on revocation.
 *
 * Deliberately free of project imports: `node tests/hub/fake-github.ts
 * --serve` runs it under Node's type stripping, which does not map the
 * `.js` specifiers `src/` uses onto `.ts` files.
 */

export const FAKE_CLIENT_ID = 'Ov23liFakeClientId00'
export const FAKE_CLIENT_SECRET = 'fake-client-secret-0123456789abcdef01234567'
export const FAKE_REDIRECT_URI = 'https://mcpcut.test/auth/github/callback'
export const EXPECTED_USER_AGENT = 'mcpcut-hub'
export const EXPECTED_API_VERSION = '2022-11-28'

const TOKEN_PREFIX = 'gho_fake'
const CODE_RANDOM_BYTES = 16
const TOKEN_RANDOM_BYTES = 24
/** Comfortably above the client's 64 KiB response cap. */
const OVERSIZED_BODY_BYTES = 128 * 1024

/** Anything goes: a test sets wrong types here to exercise the client's schema. */
export interface FakeProfile {
  readonly id: unknown
  readonly login: unknown
  readonly created_at: unknown
}

export const DEFAULT_PROFILE: FakeProfile = {
  id: 1_000_001,
  login: 'alice',
  created_at: '2019-03-04T05:06:07Z',
}

/**
 * How one endpoint answers. `ok` is the strict happy path; the rest are the
 * failure modes the hub must survive without a 500: a server error, silence
 * past the client's timeout, a well-formed JSON of the wrong shape, a body
 * over the client's cap, and a body that is not JSON (it echoes the token
 * in it, so a client that quoted the body in an error would leak it).
 */
export type FakeBehaviour = 'ok' | 'error-500' | 'hang' | 'bad-shape' | 'oversized' | 'not-json'
export type FakeEndpoint = 'token' | 'user' | 'revoke'

export interface FakeGithubOptions {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly profile?: FakeProfile
  readonly port?: number
}

export interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly userAgent: string | undefined
  readonly status: number
}

export interface ApprovedAuthorization {
  readonly code: string
  readonly state: string
  /** The registered redirect URI with `code` and `state`, as GitHub would redirect. */
  readonly callbackUrl: string
}

export interface FakeGithub {
  /** `http://127.0.0.1:<port>` — pass as both `webBase` and `apiBase`. */
  readonly baseUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  /**
   * Plays the user pressing "Authorize" on an authorize URL the hub built:
   * checks `client_id`, `redirect_uri`, `code_challenge_method=S256`, then
   * issues a one-shot code bound to the challenge and the given profile.
   */
  approve(authorizeUrl: string, profile?: FakeProfile): ApprovedAuthorization
  /** Issues a code for a challenge directly, bypassing the authorize URL. */
  issueCode(codeChallenge: string, profile?: FakeProfile): string
  setBehaviour(endpoint: FakeEndpoint, behaviour: FakeBehaviour): void
  requests(): readonly FakeRequest[]
  issuedTokens(): readonly string[]
  revokedTokens(): readonly string[]
  /** Requests held open by the `hang` behaviour right now. */
  hangingCount(): number
  close(): Promise<void>
}

interface IssuedCode {
  readonly challenge: string
  readonly profile: FakeProfile
}

interface FakeState {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly defaultProfile: FakeProfile
  readonly codes: Map<string, IssuedCode>
  readonly tokens: Map<string, FakeProfile>
  readonly revoked: string[]
  readonly log: FakeRequest[]
  readonly behaviour: Map<FakeEndpoint, FakeBehaviour>
  readonly hanging: Set<ServerResponse>
}

/** RFC 7636 S256, computed here independently of the code under test. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export async function startFakeGithub(opts: FakeGithubOptions = {}): Promise<FakeGithub> {
  const state: FakeState = {
    clientId: opts.clientId ?? FAKE_CLIENT_ID,
    clientSecret: opts.clientSecret ?? FAKE_CLIENT_SECRET,
    redirectUri: opts.redirectUri ?? FAKE_REDIRECT_URI,
    defaultProfile: opts.profile ?? DEFAULT_PROFILE,
    codes: new Map(),
    tokens: new Map(),
    revoked: [],
    log: [],
    behaviour: new Map(),
    hanging: new Set(),
  }
  const server = createServer((req, res) => {
    void handle(state, req, res)
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return buildHandle(state, server, `http://127.0.0.1:${port}`)
}

function issueCodeIn(state: FakeState, codeChallenge: string, profile?: FakeProfile): string {
  const code = randomBytes(CODE_RANDOM_BYTES).toString('hex')
  state.codes.set(code, { challenge: codeChallenge, profile: profile ?? state.defaultProfile })
  return code
}

function buildHandle(state: FakeState, server: Server, baseUrl: string): FakeGithub {
  return {
    baseUrl,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    redirectUri: state.redirectUri,
    approve: (authorizeUrl, profile) => approve(state, authorizeUrl, profile),
    issueCode: (codeChallenge, profile) => issueCodeIn(state, codeChallenge, profile),
    setBehaviour: (endpoint, behaviour) => {
      state.behaviour.set(endpoint, behaviour)
    },
    requests: () => [...state.log],
    issuedTokens: () => [...state.tokens.keys()],
    revokedTokens: () => [...state.revoked],
    hangingCount: () => state.hanging.size,
    close: () => closeServer(state, server),
  }
}

function closeServer(state: FakeState, server: Server): Promise<void> {
  for (const res of state.hanging) res.destroy()
  state.hanging.clear()
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function approve(state: FakeState, authorizeUrl: string, profile: FakeProfile | undefined): ApprovedAuthorization {
  const params = new URL(authorizeUrl).searchParams
  const problem = authorizeProblem(state, params)
  if (problem !== undefined) throw new Error(`fake GitHub refused the authorize URL: ${problem}`)
  const code = issueCodeIn(state, params.get('code_challenge') as string, profile)
  const oauthState = params.get('state') as string
  const callback = new URL(state.redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', oauthState)
  return { code, state: oauthState, callbackUrl: callback.href }
}

function authorizeProblem(state: FakeState, params: URLSearchParams): string | undefined {
  if (params.get('client_id') !== state.clientId) return 'unknown client_id'
  if (params.get('redirect_uri') !== state.redirectUri) return 'redirect_uri mismatch'
  if (params.get('code_challenge_method') !== 'S256') return 'code_challenge_method is not S256'
  if ((params.get('code_challenge') ?? '') === '') return 'missing code_challenge'
  if ((params.get('state') ?? '') === '') return 'missing state'
  return undefined
}

// ---------------------------------------------------------------------------
// Routing

async function handle(state: FakeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fake.invalid')
  const route = routeOf(state, req.method ?? '', url.pathname)
  const body = await readBody(req)
  const reply = (status: number, payload: string, contentType = 'application/json'): void => {
    state.log.push({ method: req.method ?? '', path: url.pathname, userAgent: req.headers['user-agent'], status })
    res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  if (route === undefined) {
    handleUnrouted(state, req, url, reply, res)
    return
  }
  const behaviour = state.behaviour.get(route) ?? 'ok'
  if (behaviour !== 'ok') {
    misbehave(state, behaviour, res, reply)
    return
  }
  if (req.headers['user-agent'] !== EXPECTED_USER_AGENT) {
    reply(403, JSON.stringify({ message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header' }))
    return
  }
  if (route === 'token') tokenEndpoint(state, req, body, reply)
  else if (route === 'user') userEndpoint(state, req, reply)
  else revokeEndpoint(state, req, body, reply)
}

type Reply = (status: number, payload: string, contentType?: string) => void

function routeOf(state: FakeState, method: string, path: string): FakeEndpoint | undefined {
  if (method === 'POST' && path === '/login/oauth/access_token') return 'token'
  if (method === 'GET' && path === '/user') return 'user'
  if (method === 'DELETE' && path === `/applications/${encodeURIComponent(state.clientId)}/token`) return 'revoke'
  return undefined
}

/**
 * The authorize page, answered by auto-approving — only so `--serve` can back
 * a manual browser smoke. Tests use `approve()` instead.
 */
function handleUnrouted(state: FakeState, req: IncomingMessage, url: URL, reply: Reply, res: ServerResponse): void {
  if (req.method !== 'GET' || url.pathname !== '/login/oauth/authorize') {
    reply(404, JSON.stringify({ message: 'Not Found' }))
    return
  }
  const problem = authorizeProblem(state, url.searchParams)
  if (problem !== undefined) {
    reply(400, problem, 'text/plain')
    return
  }
  const { callbackUrl } = approve(state, url.href, undefined)
  state.log.push({ method: 'GET', path: url.pathname, userAgent: req.headers['user-agent'], status: 302 })
  res.writeHead(302, { location: callbackUrl, 'content-length': 0 })
  res.end()
}

function misbehave(state: FakeState, behaviour: FakeBehaviour, res: ServerResponse, reply: Reply): void {
  switch (behaviour) {
    case 'error-500':
      reply(500, JSON.stringify({ message: 'Server Error' }))
      return
    case 'hang':
      // Headers are never sent; the client's own deadline must end this.
      state.hanging.add(res)
      return
    case 'bad-shape':
      reply(200, JSON.stringify({ id: 'not-a-number', login: 42, created_at: 'yesterday', access_token: 7 }))
      return
    case 'oversized':
      reply(200, JSON.stringify({ padding: 'x'.repeat(OVERSIZED_BODY_BYTES) }))
      return
    case 'not-json':
      reply(200, `access_token=${TOKEN_PREFIX}LEAKED_IN_BODY&scope=`, 'application/x-www-form-urlencoded')
      return
    case 'ok':
      return
  }
}

// ---------------------------------------------------------------------------
// Endpoints

function tokenEndpoint(state: FakeState, req: IncomingMessage, body: string, reply: Reply): void {
  if (req.headers.accept !== 'application/json') {
    // GitHub answers form-encoded without it; the client could not parse that.
    reply(200, 'error=accept_header_missing', 'application/x-www-form-urlencoded')
    return
  }
  const params = parseBody(req, body)
  const oauthError = (error: string): void => reply(200, JSON.stringify({ error, error_description: error }))
  if (params.get('client_id') !== state.clientId || params.get('client_secret') !== state.clientSecret) {
    oauthError('incorrect_client_credentials')
    return
  }
  if (params.get('redirect_uri') !== state.redirectUri) {
    oauthError('redirect_uri_mismatch')
    return
  }
  const code = params.get('code') ?? ''
  const issued = state.codes.get(code)
  // Codes are one-shot: any exchange attempt consumes it.
  state.codes.delete(code)
  const verifier = params.get('code_verifier') ?? ''
  if (issued === undefined || verifier === '' || s256(verifier) !== issued.challenge) {
    oauthError('bad_verification_code')
    return
  }
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('hex')}`
  state.tokens.set(token, issued.profile)
  reply(200, JSON.stringify({ access_token: token, token_type: 'bearer', scope: '' }))
}

function userEndpoint(state: FakeState, req: IncomingMessage, reply: Reply): void {
  if (req.headers['x-github-api-version'] !== EXPECTED_API_VERSION) {
    reply(400, JSON.stringify({ message: 'Unsupported API version' }))
    return
  }
  if (req.headers.accept !== 'application/vnd.github+json') {
    reply(415, JSON.stringify({ message: 'Unsupported media type' }))
    return
  }
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const profile = state.tokens.get(token)
  if (profile === undefined || state.revoked.includes(token)) {
    reply(401, JSON.stringify({ message: 'Bad credentials' }))
    return
  }
  // Extra fields, as the real response carries dozens; the client must ignore them.
  reply(200, JSON.stringify({ ...profile, node_id: 'MDQ6VXNlcjE=', type: 'User', site_admin: false }))
}

function revokeEndpoint(state: FakeState, req: IncomingMessage, body: string, reply: Reply): void {
  const expected = `Basic ${Buffer.from(`${state.clientId}:${state.clientSecret}`).toString('base64')}`
  if (req.headers.authorization !== expected) {
    reply(401, JSON.stringify({ message: 'Requires authentication' }))
    return
  }
  if (req.headers['x-github-api-version'] !== EXPECTED_API_VERSION) {
    reply(400, JSON.stringify({ message: 'Unsupported API version' }))
    return
  }
  const token = accessTokenOf(body)
  if (token === undefined || !state.tokens.has(token) || state.revoked.includes(token)) {
    reply(404, JSON.stringify({ message: 'Not Found' }))
    return
  }
  state.revoked.push(token)
  reply(204, '')
}

// ---------------------------------------------------------------------------
// Manual smoke: `node tests/hub/fake-github.ts --serve [--port N] [--login L] [--id N] [--created ISO]`

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

async function serveFromCli(argv: readonly string[]): Promise<void> {
  const port = Number(flagValue(argv, '--port') ?? '0')
  const profile: FakeProfile = {
    id: Number(flagValue(argv, '--id') ?? DEFAULT_PROFILE.id),
    login: flagValue(argv, '--login') ?? DEFAULT_PROFILE.login,
    created_at: flagValue(argv, '--created') ?? DEFAULT_PROFILE.created_at,
  }
  const redirectUri = flagValue(argv, '--redirect-uri') ?? FAKE_REDIRECT_URI
  const fake = await startFakeGithub({ port, profile, redirectUri })
  process.stdout.write(
    `fake GitHub on ${fake.baseUrl}\n` +
      `client id:     ${fake.clientId}\n` +
      `client secret: ${fake.clientSecret} (fake, for local smoke only)\n` +
      `redirect uri:  ${fake.redirectUri}\n`,
  )
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href && process.argv.includes('--serve')) {
  void serveFromCli(process.argv.slice(2))
}
