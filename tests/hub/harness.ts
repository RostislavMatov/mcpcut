import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAccountsDb, type AccountsDb } from '../../hub/src/accounts-db.js'
import { createGithubClient, type GithubClient } from '../../hub/src/github.js'
import type { Orchestrator } from '../../hub/src/orchestrator.js'
import { createHubServer, type HubServer, type HubServerConfig } from '../../hub/src/server.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'
import { DEFAULT_PROFILE, startFakeGithub, type FakeGithub, type FakeProfile } from './fake-github.js'

/**
 * Drives the composed hub over a real socket (plan Task 5): `createHubServer`
 * on port 0, the strict fake GitHub (`fake-github.ts`) behind a real
 * `createGithubClient`, a fake orchestrator, a temp `hub.db`, and an
 * injectable clock. Requests use `node:http` with `agent: false`, like
 * `tests/ui/harness.ts`: a pooled agent keeps sockets alive past `close()`.
 *
 * `publicUrl` is `https://mcpcut.test` — the origin the fake GitHub's
 * registered redirect URI lives on — so every request carries
 * `Host: mcpcut.test` and every POST `Origin: https://mcpcut.test`, exactly
 * what a browser behind Caddy would send.
 */

export const HUB_TEST_PUBLIC_URL = 'https://mcpcut.test'
export const HUB_TEST_HOST = 'mcpcut.test'
export const HUB_TEST_START_MS = Date.parse('2026-09-27T10:00:00.000Z')

export interface HubResponse {
  readonly status: number
  readonly headers: NodeJS.Dict<string | string[]>
  readonly body: string
}

export interface RequestOptions {
  readonly cookie?: string
  /** `null` sends no Origin; default: the public origin on POST, none on GET. */
  readonly origin?: string | null
  readonly host?: string
  /** `application/x-www-form-urlencoded` fields. */
  readonly form?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
}

/** A browser: a cookie jar and the CSRF token of the last page it saw. */
export interface Browser {
  cookieHeader(): string
  has(name: string): boolean
  get(path: string, options?: RequestOptions): Promise<HubResponse>
  /** POSTs a form with the jar's cookies and the last seen CSRF token. */
  post(path: string, form?: Readonly<Record<string, string>>, options?: RequestOptions): Promise<HubResponse>
  /** The full sign-in dance; returns the callback's response. */
  signIn(profile?: FakeProfile): Promise<HubResponse>
  csrfToken(): string
}

export interface HubHarness {
  readonly server: HubServer
  readonly port: number
  readonly db: AccountsDb
  readonly github: FakeGithub
  readonly orchestrator: FakeOrchestrator
  readonly logs: string[]
  /** Every response body and header the hub wrote, for leak scans. */
  readonly transcript: string[]
  advance(ms: number): void
  nowMs(): number
  request(method: string, path: string, options?: RequestOptions): Promise<HubResponse>
  browser(): Browser
  close(): Promise<void>
}

export interface StartHubOptions {
  readonly config?: Partial<HubServerConfig>
  /** Replaces the fake orchestrator the harness otherwise wires in. */
  readonly orchestrator?: Orchestrator
}

export async function startHub(options: StartHubOptions = {}): Promise<HubHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-server-test-'))
  const db = await openAccountsDb(dir)
  const github = await startFakeGithub()
  const fakeOrchestrator = createFakeOrchestrator()
  const client: GithubClient = createGithubClient({
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    redirectUri: github.redirectUri,
    webBase: github.baseUrl,
    apiBase: github.baseUrl,
    timeoutMs: 500,
  })
  let now = HUB_TEST_START_MS
  const logs: string[] = []
  const transcript: string[] = []
  const server = createHubServer({
    config: { ...defaultConfig(), ...options.config },
    db,
    github: client,
    orchestrator: options.orchestrator ?? fakeOrchestrator,
    clock: () => now,
    log: (line) => logs.push(line),
  })
  const { port } = await server.listen(0, '127.0.0.1')
  const request = (method: string, path: string, requestOptions: RequestOptions = {}): Promise<HubResponse> =>
    send(port, method, path, requestOptions).then((response) => {
      transcript.push(JSON.stringify(response.headers), response.body)
      return response
    })
  const harness: HubHarness = {
    server,
    port,
    db,
    github,
    orchestrator: fakeOrchestrator,
    logs,
    transcript,
    advance: (ms) => (now += ms),
    nowMs: () => now,
    request,
    browser: () => createBrowser(harness),
    close: async () => {
      await server.close()
      client.close()
      await github.close()
      db.handle.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
  return harness
}

function defaultConfig(): HubServerConfig {
  return {
    publicUrl: HUB_TEST_PUBLIC_URL,
    tenantDomain: 'mcpcut.com',
    maxAccounts: 15,
    minAccountAgeDays: 30,
    signupsPerHourPerIp: 3,
    trustCfConnectingIp: false,
  }
}

function send(port: number, method: string, path: string, options: RequestOptions): Promise<HubResponse> {
  const body = options.form === undefined ? undefined : new URLSearchParams(options.form).toString()
  const origin = options.origin === undefined ? (method === 'POST' ? HUB_TEST_PUBLIC_URL : null) : options.origin
  const headers: Record<string, string> = {
    host: options.host ?? HUB_TEST_HOST,
    ...(origin === null ? {} : { origin }),
    ...(options.cookie === undefined || options.cookie === '' ? {} : { cookie: options.cookie }),
    ...(body === undefined
      ? {}
      : { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) }),
    ...options.headers,
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** The `Set-Cookie` values of a response, as an array. */
export function setCookiesOf(response: HubResponse): readonly string[] {
  const raw = response.headers['set-cookie']
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
}

/** The page's CSRF token, from `<meta name="csrf-token">`. */
export function csrfTokenOf(body: string): string {
  return /<meta name="csrf-token" content="([^"]*)">/.exec(body)?.[1] ?? ''
}

function createBrowser(harness: HubHarness): Browser {
  const jar = new Map<string, string>()
  let csrf = ''
  const absorb = (response: HubResponse): HubResponse => {
    for (const cookie of setCookiesOf(response)) {
      const [pair = ''] = cookie.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (value === '' || cookie.includes('Max-Age=0')) jar.delete(name)
      else jar.set(name, value)
    }
    const token = csrfTokenOf(response.body)
    if (token !== '') csrf = token
    return response
  }
  const cookieHeader = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const browser: Browser = {
    cookieHeader,
    has: (name) => jar.has(name),
    csrfToken: () => csrf,
    get: async (path, options = {}) => absorb(await harness.request('GET', path, { cookie: cookieHeader(), ...options })),
    post: async (path, form = {}, options = {}) =>
      absorb(
        await harness.request('POST', path, {
          cookie: cookieHeader(),
          form: { csrf_token: csrf, ...form },
          ...options,
        }),
      ),
    signIn: async (profile = DEFAULT_PROFILE) => {
      const start = await browser.get('/signin')
      const location = String(start.headers.location ?? '')
      const { callbackUrl } = harness.github.approve(location, profile)
      const callback = new URL(callbackUrl)
      return browser.get(`${callback.pathname}${callback.search}`)
    },
  }
  return browser
}
