import type { IncomingHttpHeaders } from 'node:http'
import { deleteAccount, type AccountRecord } from './accounts-db.js'
import { HUB_ASSETS } from './assets.js'
import { headerValue, page, seeOther, type HubResult } from './http.js'
import { clearFlowCookie, flowIdFromCookieHeader, serializeFlowCookie } from './oauth-flow.js'
import { describeOrchestratorError } from './orchestrator.js'
import { renderAccountDeleteConfirmPage } from './pages/account-delete-confirm.js'
import { renderAccountPage, type InstallState } from './pages/account.js'
import { renderDeletedPage } from './pages/deleted.js'
import { renderNoticePage } from './pages/notice.js'
import { renderPreparingPage } from './pages/preparing.js'
import { renderPrivacyPage } from './pages/privacy.js'
import { renderSignedInPage } from './pages/signed-in.js'
import { renderSigninRefusedPage } from './pages/signin-refused.js'
import { renderTermsPage } from './pages/terms.js'
import { renderTokenOncePage } from './pages/token-once.js'
import { renderWaitlistPage } from './pages/waitlist.js'
import { idleDeadlines, type IdleSweeper } from './idle-sweeper.js'
import type { InstallWaker } from './install-waker.js'
import type { PendingTokens } from './pending-tokens.js'
import type { Provisioning } from './provisioning.js'
import type { WindowCounter } from './rate-limit.js'
import { clearHubSessionCookie, serializeHubSessionCookie, type HubSession, type HubSessions } from './sessions.js'
import { completeCallback, type CallbackOutcome, type SigninDeps } from './signin.js'

/**
 * The hub's route table and handlers (plan Task 5). `server.ts` has already
 * screened Host and Origin, resolved the session, enforced "signed in" for
 * `session` routes and checked CSRF on every POST that carries a session by
 * the time a handler here runs — handlers only do their own job.
 */

/** `public`: never looks at a session. `optional`: uses one if live. `session`: requires one. */
export type RouteAccess = 'public' | 'optional' | 'session'

export interface LiveSession {
  readonly session: HubSession
  readonly account: AccountRecord
}

export interface HubContext {
  readonly query: URLSearchParams
  readonly headers: IncomingHttpHeaders
  readonly form: Readonly<Record<string, string>>
  /** The client's rate-limit key: its address, an IPv6 one by /64 (`rate-limit.ts`). */
  readonly ip: string
  readonly sessionId: string | undefined
  readonly live: LiveSession | undefined
  /** The path segment after `/hub-assets/`, for the asset route. */
  readonly assetName?: string
}

export interface HubDeps extends SigninDeps {
  readonly tenantDomain: string
  readonly sessions: HubSessions
  /** Requests to `/signin` and the callback per IP (HA12). */
  readonly signinRequests: WindowCounter
  /** Owner tokens and failure marks the background install tasks leave (P2/P3). */
  readonly pendingTokens: PendingTokens
  readonly provisioning: Provisioning
  /** Starts a stopped install when its person comes back (P6). */
  readonly waker: InstallWaker
  /** The idle sweeper (P5/P6): `/account` asks it whether the install went missing. */
  readonly idle: IdleSweeper
}

export interface Route {
  readonly access: RouteAccess
  readonly handle: (deps: HubDeps, ctx: HubContext) => HubResult | Promise<HubResult>
}

/** `/signin` + callback requests one IP may make per window. Generous for a
 * shared NAT; tight enough that `/signin` cannot churn the flow table. */
export const SIGNIN_REQUESTS_PER_WINDOW = 30
export const SIGNIN_WINDOW_MS = 10 * 60 * 1000

export const ASSET_PREFIX = '/hub-assets/'

const ROUTES: Readonly<Record<string, Route>> = Object.freeze({
  'GET /signin': { access: 'optional', handle: signin },
  'GET /auth/github/callback': { access: 'public', handle: callback },
  'GET /account': { access: 'session', handle: account },
  'POST /account/token': { access: 'session', handle: rotateToken },
  'GET /account/delete': { access: 'session', handle: deleteConfirm },
  'POST /account/delete': { access: 'session', handle: deleteAccountRoute },
  'POST /signout': { access: 'optional', handle: signout },
  'GET /terms': { access: 'optional', handle: (_deps, ctx) => page(200, renderTermsPage(signedInView(ctx))) },
  'GET /privacy': {
    access: 'optional',
    handle: (deps, ctx) => page(200, renderPrivacyPage({ minAccountAgeDays: deps.minAccountAgeDays, ...signedInView(ctx) })),
  },
})

const ASSET_ROUTE: Route = { access: 'public', handle: asset }

/** The route for `method path`, or `undefined` (the server answers 404). */
export function matchRoute(method: string, path: string): { readonly route: Route; readonly assetName?: string } | undefined {
  if (method === 'GET' && path.startsWith(ASSET_PREFIX)) {
    return { route: ASSET_ROUTE, assetName: path.slice(ASSET_PREFIX.length) }
  }
  const key = `${method} ${path}`
  // `hasOwn`: a path like `constructor` must not find `Object.prototype`'s.
  const route = Object.hasOwn(ROUTES, key) ? ROUTES[key] : undefined
  return route === undefined ? undefined : { route }
}

function signedInView(ctx: HubContext): { signedIn?: boolean; csrfToken?: string } {
  return ctx.live === undefined ? {} : { signedIn: true, csrfToken: ctx.live.session.csrfToken }
}

function refusedPage(status: number, reason: Parameters<typeof renderSigninRefusedPage>[0]['reason'], cookies: readonly string[] = []): HubResult {
  return page(status, renderSigninRefusedPage({ reason }), cookies)
}

function notice(status: number, headline: string, message: string, live: LiveSession): HubResult {
  return page(status, renderNoticePage({ status: headline, message, signedIn: true, csrfToken: live.session.csrfToken }))
}

// --- sign-in -----------------------------------------------------------------

function signin(deps: HubDeps, ctx: HubContext): HubResult {
  if (!deps.signinRequests.tryConsume(ctx.ip, SIGNIN_REQUESTS_PER_WINDOW)) {
    return refusedPage(429, { kind: 'rate-limited' })
  }
  if (ctx.live !== undefined) return seeOther('/account')
  const flow = deps.flows.begin()
  const location = deps.github.authorizeUrl({ state: flow.state, codeChallenge: flow.challenge })
  return { status: 302, headers: { location, 'set-cookie': [serializeFlowCookie(flow.flowId)] } }
}

async function callback(deps: HubDeps, ctx: HubContext): Promise<HubResult> {
  const clearFlow = clearFlowCookie()
  if (!deps.signinRequests.tryConsume(ctx.ip, SIGNIN_REQUESTS_PER_WINDOW)) {
    return refusedPage(429, { kind: 'rate-limited' }, [clearFlow])
  }
  const flowId = flowIdFromCookieHeader(headerValue(ctx.headers, 'cookie'))
  const outcome = await completeCallback(deps, { query: ctx.query, flowId, ip: ctx.ip })
  return callbackPage(deps, outcome, clearFlow)
}

function callbackPage(deps: HubDeps, outcome: CallbackOutcome, clearFlow: string): HubResult {
  switch (outcome.kind) {
    case 'refused':
      return refusedPage(outcome.status, outcome.reason, [clearFlow])
    case 'waitlist':
      return page(200, renderWaitlistPage({ position: outcome.position }), [clearFlow])
    case 'signed-in': {
      // A stopped install starts in the background; `/account` says so meanwhile (P6).
      deps.waker.wake(outcome.account)
      const { sessionId, session } = deps.sessions.create(outcome.account)
      const body = renderSignedInPage({ login: outcome.account.login, csrfToken: session.csrfToken })
      return page(200, body, [clearFlow, serializeHubSessionCookie(sessionId)])
    }
    case 'preparing': {
      // The same same-site hand-over as `signed-in`: the refresh carries the Strict cookie.
      const { sessionId, session } = deps.sessions.create(outcome.account)
      const body = renderPreparingPage({ login: outcome.account.login, csrfToken: session.csrfToken })
      return page(200, body, [clearFlow, serializeHubSessionCookie(sessionId)])
    }
  }
}

// --- the account -------------------------------------------------------------

function requireLive(ctx: HubContext): LiveSession {
  // `server.ts` never runs a `session` route without one; this is the type's proof.
  if (ctx.live === undefined) throw new Error('session route reached without a session')
  return ctx.live
}

/**
 * `pending`: the install is still being made — "preparing", refreshing
 * itself. Ready with an owner token waiting: the token, once (P2). Otherwise
 * the account page, whose "issue a new owner token" covers a token lost to a
 * restart or the TTL. A stopped install is started first, in the background (P6).
 */
function account(deps: HubDeps, ctx: HubContext): HubResult {
  const { account: record, session } = requireLive(ctx)
  if (record.status === 'pending') return page(200, renderPreparingPage({ login: record.login, csrfToken: session.csrfToken }))
  const starting = deps.waker.wake(record)
  const waiting = deps.pendingTokens.takeToken({ githubId: record.githubId, accountCreatedAt: record.createdAt })
  if (waiting !== undefined) {
    return page(200, renderTokenOncePage({ login: record.login, token: waiting, csrfToken: session.csrfToken }))
  }
  return page(
    200,
    renderAccountPage({
      login: record.login,
      subdomain: record.subdomain,
      status: record.status,
      serveUrl: `https://${record.subdomain}.${deps.tenantDomain}`,
      csrfToken: session.csrfToken,
      install: installStateOf(deps, record, starting),
      ...idleDeadlines(record),
    }),
  )
}

function installStateOf(deps: HubDeps, record: AccountRecord, starting: boolean): InstallState {
  if (deps.idle.isMissing({ githubId: record.githubId, createdAt: record.createdAt })) return 'missing'
  if (record.stoppedAt === null) return 'running'
  return starting ? 'starting' : 'stopped'
}

const TOKEN_NOT_ISSUED = 'Owner token not issued'
const TOKEN_NOT_ISSUED_MESSAGE =
  'Your install could not be reached, so no new token was issued and your current one still works. Try again later.'

async function rotateToken(deps: HubDeps, ctx: HubContext): Promise<HubResult> {
  const live = requireLive(ctx)
  const { account: record, session } = live
  if (!deps.orchestrator.available || record.status !== 'active') {
    return notice(503, TOKEN_NOT_ISSUED, TOKEN_NOT_ISSUED_MESSAGE, live)
  }
  let ownerToken: string
  try {
    ownerToken = (await deps.orchestrator.rotateOwnerToken(record.subdomain)).ownerToken
  } catch (error: unknown) {
    deps.log(`[hub] owner token rotation failed for ${record.subdomain}: ${describeOrchestratorError(error)}`)
    return notice(503, TOKEN_NOT_ISSUED, TOKEN_NOT_ISSUED_MESSAGE, live)
  }
  // A first token still waiting stopped working the moment this one was minted.
  deps.pendingTokens.forget(record.githubId)
  return page(200, renderTokenOncePage({ login: record.login, token: ownerToken, csrfToken: session.csrfToken }))
}

function deleteConfirm(_deps: HubDeps, ctx: HubContext): HubResult {
  const { account: record, session } = requireLive(ctx)
  return page(200, renderAccountDeleteConfirmPage({ login: record.login, csrfToken: session.csrfToken }))
}

const DELETE_UNAVAILABLE_MESSAGE =
  'Your install cannot be removed right now, so nothing was deleted. Try again later.'
const DELETE_WHILE_PREPARING_MESSAGE =
  'Your install is still being prepared, so nothing was deleted. Try again once it is ready.'

async function deleteAccountRoute(deps: HubDeps, ctx: HubContext): Promise<HubResult> {
  const { account: record, session } = requireLive(ctx)
  const refuse = (status: number, error: string): HubResult =>
    page(status, renderAccountDeleteConfirmPage({ login: record.login, csrfToken: session.csrfToken, error }))
  const typed = (ctx.form['login'] ?? '').trim().toLowerCase()
  if (typed !== record.login.toLowerCase()) {
    return refuse(400, `The login you typed does not match @${record.login} — nothing was deleted.`)
  }
  // A remove racing the background create could leave an install behind with no account.
  if (record.status === 'pending') return refuse(409, DELETE_WHILE_PREPARING_MESSAGE)
  if (!deps.orchestrator.available) return refuse(503, DELETE_UNAVAILABLE_MESSAGE)
  try {
    await deps.orchestrator.remove(record.subdomain)
  } catch (error: unknown) {
    deps.log(`[hub] install removal failed for ${record.subdomain}, account kept: ${describeOrchestratorError(error)}`)
    return refuse(503, DELETE_UNAVAILABLE_MESSAGE)
  }
  deleteAccount(deps.db, record.githubId, 'deleted', new Date(deps.clock()).toISOString())
  deps.sessions.destroyAccount(record.githubId)
  deps.pendingTokens.forget(record.githubId)
  deps.log(`[hub] account deleted by its owner: @${record.login} (${record.subdomain})`)
  return page(200, renderDeletedPage({ login: record.login }), [clearHubSessionCookie()])
}

function signout(deps: HubDeps, ctx: HubContext): HubResult {
  if (ctx.live !== undefined) deps.sessions.destroy(ctx.sessionId)
  return seeOther('/', [clearHubSessionCookie()])
}

// --- assets ------------------------------------------------------------------

function asset(_deps: HubDeps, ctx: HubContext): HubResult {
  const name = ctx.assetName ?? ''
  const found = Object.hasOwn(HUB_ASSETS, name) ? HUB_ASSETS[name] : undefined
  if (found === undefined) return notFound()
  const headers = { 'content-type': found.contentType, etag: found.etag, 'cache-control': found.cacheControl }
  if (headerValue(ctx.headers, 'if-none-match') === found.etag) return { status: 304, headers }
  return { status: 200, headers, body: found.body }
}

/** The hub's 404. */
export function notFound(): HubResult {
  return page(404, renderNoticePage({ status: 'Not found', message: 'There is nothing at this address.' }))
}

/** What a session whose install could not be created gets, once: signed out, and told why (P3). */
export function installFailedAnswer(): HubResult {
  return refusedPage(503, { kind: 'install-failed' }, [clearHubSessionCookie()])
}

/** What a live session whose account was just blocked gets: signed out, and told why. */
export function blockedAnswer(): HubResult {
  return refusedPage(403, { kind: 'blocked' }, [clearHubSessionCookie()])
}
