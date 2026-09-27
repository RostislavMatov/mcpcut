import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { securityHeaders } from '../../src/ui/security-headers.js'
import { findAccountByGithubId, type AccountsDb } from './accounts-db.js'
import type { HubConfig } from './config.js'
import type { GithubClient } from './github.js'
import {
  describeError,
  formFields,
  headerValue,
  MAX_HUB_BODY_BYTES,
  parseTarget,
  plain,
  readBody,
  seeOther,
  CONTENT_TYPE_HTML,
  type HubResult,
} from './http.js'
import { createOauthFlows } from './oauth-flow.js'
import type { Orchestrator } from './orchestrator.js'
import { clientIpOf, createWindowCounter, rateLimitKeyOf } from './rate-limit.js'
import { blockedAnswer, matchRoute, notFound, SIGNIN_WINDOW_MS, type HubContext, type HubDeps, type Route } from './routes.js'
import { clearHubSessionCookie, createHubSessions, sessionIdFromCookieHeader, type SessionResolution } from './sessions.js'

/**
 * The hub's HTTP server (plan Task 5), on `node:http` with no framework. The
 * pipeline mirrors the console's (`src/ui/server.ts`), in the same order:
 *
 *   `/healthz` → Host → Origin → route → body → session → CSRF → handler
 *
 * - `/healthz` answers first and says only "ok": the container healthcheck
 *   reaches the hub by its compose address, never by the public name.
 * - Host must be exactly the host of `HUB_PUBLIC_URL`. Unlike the console,
 *   no localhost name is admitted: the hub is only ever reached through
 *   Caddy, which forwards the public Host unchanged.
 * - Origin, when present, must be exactly the public origin, and a POST must
 *   carry one — a browser always does; a sibling tenant subdomain is a
 *   different origin and is refused.
 * - Every POST that carries a live session is CSRF-checked against it;
 *   `session` routes refuse a POST without one (403) and redirect a GET to
 *   `/signin`.
 * - A live session whose account was blocked is signed out on the spot with
 *   the reason (H2: `resolve` re-reads the account).
 *
 * Every answer carries the console's security headers with HSTS (the hub is
 * always behind TLS) and `no-store` unless the route set its own cache policy.
 */

export type HubServerConfig = Pick<
  HubConfig,
  'publicUrl' | 'tenantDomain' | 'maxAccounts' | 'minAccountAgeDays' | 'signupsPerHourPerIp' | 'trustCfConnectingIp'
>

export interface HubServerOptions {
  readonly config: HubServerConfig
  readonly db: AccountsDb
  readonly github: GithubClient
  readonly orchestrator: Orchestrator
  readonly clock?: () => number
  /** One line per operational event; never a token. Defaults to stderr. */
  readonly log?: (line: string) => void
}

export interface HubConnectionTimeouts {
  readonly headersTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly keepAliveTimeoutMs: number
}

export interface HubServer {
  listen(port: number, host: string): Promise<{ readonly port: number }>
  close(): Promise<void>
  sessionCount(): number
  connectionTimeouts(): HubConnectionTimeouts | null
}

/** Explicit, not Node's defaults (as `src/ui/constants.ts`): a hub form is tiny. */
export const HUB_HEADERS_TIMEOUT_MS = 10_000
export const HUB_REQUEST_TIMEOUT_MS = 30_000
export const HUB_KEEP_ALIVE_TIMEOUT_MS = 5_000

const HEALTHZ_PATH = '/healthz'
const SIGNUP_WINDOW_MS = 60 * 60 * 1000
const DEFAULT_CACHE_CONTROL = 'no-store'
const CSRF_FIELD = 'csrf_token'
const HTTP_FORBIDDEN = 403

export function createHubServer(options: HubServerOptions): HubServer {
  const pipeline = buildPipeline(options)
  let server: Server | null = null
  let closing: Promise<void> | null = null
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(pipeline, req, res).catch((error: unknown) => {
      pipeline.deps.log(`[hub] request handler failed: ${describeError(error)}`)
      if (!res.headersSent) writeResult(res, plain(500, 'Internal Server Error'))
      else res.destroy()
    })
  }
  return Object.freeze({
    listen: async (port: number, host: string) => {
      const bound = await bind(onRequest, port, host)
      // Only a bound listener is ours to close: one that failed to bind
      // would make `close()` reject with "Server is not running".
      server = bound.instance
      return { port: bound.port }
    },
    close: () =>
      (closing ??= (async () => {
        const instance = server
        server = null
        if (instance !== null) await closeListener(instance)
      })()),
    sessionCount: () => pipeline.deps.sessions.size(),
    connectionTimeouts: () => (server === null ? null : timeoutsOf(server)),
  })
}

/** What one request needs beyond itself. */
interface Pipeline {
  readonly deps: HubDeps
  readonly publicHost: string
  readonly publicOrigin: string
  readonly trustCfConnectingIp: boolean
}

function buildPipeline(options: HubServerOptions): Pipeline {
  const publicUrl = new URL(options.config.publicUrl)
  return {
    deps: buildDeps(options),
    publicHost: publicUrl.host.toLowerCase(),
    publicOrigin: publicUrl.origin,
    trustCfConnectingIp: options.config.trustCfConnectingIp,
  }
}

function writeResult(res: ServerResponse, result: HubResult): void {
  // Security headers LAST: a route may pick its content type and cache
  // policy, never weaken the CSP, framing or referrer policy.
  const given = result.headers ?? {}
  const headers: Record<string, string | string[]> = {
    ...(result.body !== undefined ? { 'content-type': CONTENT_TYPE_HTML } : {}),
    'cache-control': DEFAULT_CACHE_CONTROL,
    ...Object.fromEntries(Object.entries(given).map(([name, value]) => [name, typeof value === 'string' ? value : [...value]])),
    ...securityHeaders({ behindTls: true }),
  }
  res.writeHead(result.status, headers)
  res.end(result.body)
}

/** Host, then Origin: the two checks that run before a route is even looked up. */
function screen(pipeline: Pipeline, req: IncomingMessage): HubResult | undefined {
  const host = headerValue(req.headers, 'host')
  if (host === undefined || host.toLowerCase() !== pipeline.publicHost) return plain(HTTP_FORBIDDEN, 'Forbidden')
  const origin = headerValue(req.headers, 'origin')
  if (origin !== undefined && origin !== pipeline.publicOrigin) return plain(HTTP_FORBIDDEN, 'Forbidden')
  if (req.method === 'POST' && origin === undefined) return plain(HTTP_FORBIDDEN, 'Forbidden')
  return undefined
}

async function handle(pipeline: Pipeline, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = parseTarget(req.url)
  if (req.method === 'GET' && path === HEALTHZ_PATH) {
    writeResult(res, plain(200, 'ok'))
    return
  }
  const refusal = screen(pipeline, req)
  const match = refusal === undefined ? matchRoute(req.method ?? '', path) : undefined
  if (refusal !== undefined || match === undefined) {
    writeResult(res, refusal ?? notFound())
    return
  }
  const body = req.method === 'POST' ? await readBody(req, MAX_HUB_BODY_BYTES) : { ok: true as const, body: Buffer.alloc(0) }
  if (!body.ok) {
    writeResult(res, plain(413, 'Payload Too Large'))
    res.destroy()
    return
  }
  const base = {
    query,
    headers: req.headers,
    form: formFields(body.body, headerValue(req.headers, 'content-type')),
    ip: rateLimitKeyOf(clientIpOf(req, pipeline.trustCfConnectingIp)),
    ...(match.assetName === undefined ? {} : { assetName: match.assetName }),
  }
  writeResult(res, await dispatch(pipeline.deps, req, match.route, base))
}

/** Session, then CSRF, then the handler. */
async function dispatch(
  deps: HubDeps,
  req: IncomingMessage,
  route: Route,
  base: Omit<HubContext, 'sessionId' | 'live'>,
): Promise<HubResult> {
  if (route.access === 'public') return route.handle(deps, { ...base, sessionId: undefined, live: undefined })
  const sessionId = sessionIdFromCookieHeader(headerValue(req.headers, 'cookie'))
  const resolution: SessionResolution = deps.sessions.resolve(sessionId)
  if (resolution.kind === 'blocked') return blockedAnswer()
  const live = resolution.kind === 'live' ? { session: resolution.session, account: resolution.account } : undefined
  const hadDeadCookie = sessionId !== undefined && live === undefined
  if (route.access === 'session' && live === undefined) {
    if (req.method === 'POST') return plain(HTTP_FORBIDDEN, 'Forbidden')
    return seeOther('/signin', hadDeadCookie ? [clearHubSessionCookie()] : [])
  }
  if (req.method === 'POST' && live !== undefined && !isCsrfValid(base.form[CSRF_FIELD], live.session.csrfToken)) {
    return plain(HTTP_FORBIDDEN, 'Forbidden')
  }
  const result = await route.handle(deps, { ...base, sessionId, live })
  return hadDeadCookie ? withClearedSession(result) : result
}

function bind(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  port: number,
  host: string,
): Promise<{ readonly instance: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const instance = createServer(onRequest)
    instance.headersTimeout = HUB_HEADERS_TIMEOUT_MS
    instance.requestTimeout = HUB_REQUEST_TIMEOUT_MS
    instance.keepAliveTimeout = HUB_KEEP_ALIVE_TIMEOUT_MS
    instance.once('error', reject)
    instance.listen(port, host, () => {
      instance.removeListener('error', reject)
      const address = instance.address()
      if (address === null || typeof address === 'string') {
        instance.close()
        reject(new Error('hub server: listener has no TCP address'))
        return
      }
      resolve({ instance, port: address.port })
    })
  })
}

async function closeListener(instance: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())))
  instance.closeAllConnections()
  await closed
}

function timeoutsOf(instance: Server): HubConnectionTimeouts {
  return {
    headersTimeoutMs: instance.headersTimeout,
    requestTimeoutMs: instance.requestTimeout,
    keepAliveTimeoutMs: instance.keepAliveTimeout,
  }
}

function buildDeps(options: HubServerOptions): HubDeps {
  const clock = options.clock ?? Date.now
  const { config, db } = options
  return {
    db,
    github: options.github,
    orchestrator: options.orchestrator,
    flows: createOauthFlows({ clock }),
    sessions: createHubSessions({ findAccount: (githubId) => findAccountByGithubId(db, githubId), clock }),
    signups: createWindowCounter({ windowMs: SIGNUP_WINDOW_MS, clock }),
    signinRequests: createWindowCounter({ windowMs: SIGNIN_WINDOW_MS, clock }),
    tenantDomain: config.tenantDomain,
    maxAccounts: config.maxAccounts,
    minAccountAgeDays: config.minAccountAgeDays,
    signupsPerHourPerIp: config.signupsPerHourPerIp,
    clock,
    log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
  }
}

/** Constant-time over sha256 digests: equal lengths whatever was submitted. */
function isCsrfValid(submitted: string | undefined, expected: string): boolean {
  if (submitted === undefined || submitted === '') return false
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(submitted), digest(expected))
}

/** Adds the session-clearing cookie unless the route already set the session cookie. */
function withClearedSession(result: HubResult): HubResult {
  const existing = result.headers?.['set-cookie']
  const cookies = existing === undefined ? [] : typeof existing === 'string' ? [existing] : [...existing]
  if (cookies.some((cookie) => cookie.startsWith('__Host-mcpcut_hub='))) return result
  return { ...result, headers: { ...result.headers, 'set-cookie': [...cookies, clearHubSessionCookie()] } }
}
