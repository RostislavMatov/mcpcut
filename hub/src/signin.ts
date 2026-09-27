import {
  countActive,
  discardPendingAccount,
  findAccountByGithubId,
  findAccountBySubdomain,
  findTombstone,
  insertAccount,
  joinWaitlist,
  setStatus,
  touch,
  type AccountRecord,
  type AccountsDb,
} from './accounts-db.js'
import { GithubError, type GithubClient, type GithubProfile } from './github.js'
import type { OauthFlows } from './oauth-flow.js'
import { describeOrchestratorError, type Orchestrator } from './orchestrator.js'
import type { SigninRefusalReason } from './pages/signin-refused.js'
import type { WindowCounter } from './rate-limit.js'
import { decide, type SignupDecision } from './signup-policy.js'
import { assignSubdomain, SubdomainExhaustedError } from './subdomain.js'

/**
 * `GET /auth/github/callback`, minus HTTP (plan Task 5): flow → code exchange
 * → profile → revocation → `decide` → the outcome. The route (`routes.ts`)
 * turns the outcome into a page and, for a signed-in outcome, a session.
 *
 * The GitHub token lives in one local variable for the length of
 * `obtainProfile` and is revoked on every path out of it (H4) — success or
 * failure — and never stored, logged or returned. A failed revocation is
 * logged by GitHub's own token-free error message and does not fail the
 * sign-in: the person did nothing wrong, and GitHub expires the token anyway.
 */

export interface SigninDeps {
  readonly db: AccountsDb
  readonly github: GithubClient
  readonly orchestrator: Orchestrator
  readonly flows: OauthFlows
  /** Accounts created per IP in the trailing hour (HA12). */
  readonly signups: WindowCounter
  readonly maxAccounts: number
  readonly minAccountAgeDays: number
  readonly signupsPerHourPerIp: number
  readonly clock: () => number
  readonly log: (line: string) => void
}

export interface CallbackInput {
  readonly query: URLSearchParams
  readonly flowId: string | undefined
  readonly ip: string
}

export type CallbackOutcome =
  | { readonly kind: 'refused'; readonly reason: SigninRefusalReason; readonly status: number }
  | { readonly kind: 'waitlist'; readonly position: number }
  | { readonly kind: 'signed-in'; readonly account: AccountRecord }
  | { readonly kind: 'created'; readonly account: AccountRecord; readonly ownerToken: string }

/** GitHub authorization codes are short opaque strings; anything else is not one. */
const CODE_PATTERN = /^[\x21-\x7e]{1,512}$/

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_FORBIDDEN = 403
const HTTP_CONFLICT = 409
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503

function refused(reason: SigninRefusalReason, status: number): CallbackOutcome {
  return { kind: 'refused', reason, status }
}

export async function completeCallback(deps: SigninDeps, input: CallbackInput): Promise<CallbackOutcome> {
  const { query } = input
  // Redeem first, whatever else the query says: the flow is single-use.
  const flow = deps.flows.complete({ flowId: input.flowId, state: query.get('state') ?? undefined })
  const error = query.get('error')
  if (error !== null) {
    return error === 'access_denied' ? refused({ kind: 'cancelled' }, HTTP_OK) : refused({ kind: 'try-again' }, HTTP_BAD_REQUEST)
  }
  if (!flow.ok) return refused({ kind: 'try-again' }, HTTP_BAD_REQUEST)
  const code = query.get('code')
  if (code === null || !CODE_PATTERN.test(code)) return refused({ kind: 'try-again' }, HTTP_BAD_REQUEST)
  const profile = await obtainProfile(deps, code, flow.verifier)
  if (profile.kind === 'refused') return profile
  return admit(deps, profile.profile, input.ip)
}

type ProfileRead = { readonly kind: 'profile'; readonly profile: GithubProfile } | Extract<CallbackOutcome, { kind: 'refused' }>

async function obtainProfile(deps: SigninDeps, code: string, verifier: string): Promise<ProfileRead> {
  let token: string
  try {
    token = await deps.github.exchangeCode({ code, verifier })
  } catch (error: unknown) {
    return githubFailure(deps, error)
  }
  try {
    return { kind: 'profile', profile: await deps.github.fetchProfile(token) }
  } catch (error: unknown) {
    return githubFailure(deps, error)
  } finally {
    await revokeQuietly(deps, token)
  }
}

async function revokeQuietly(deps: SigninDeps, token: string): Promise<void> {
  try {
    await deps.github.revokeToken(token)
  } catch (error: unknown) {
    // `GithubError` messages carry no token by construction (github.ts).
    const detail = error instanceof GithubError ? error.message : 'unexpected failure'
    deps.log(`[hub] GitHub token revocation failed, sign-in continues: ${detail}`)
  }
}

function githubFailure(deps: SigninDeps, error: unknown): Extract<CallbackOutcome, { kind: 'refused' }> {
  if (!(error instanceof GithubError)) {
    deps.log('[hub] GitHub sign-in failed: unexpected failure')
    return { kind: 'refused', reason: { kind: 'try-again' }, status: HTTP_BAD_GATEWAY }
  }
  deps.log(`[hub] GitHub sign-in failed: ${error.message}`)
  if (error.failure === 'timeout' || error.failure === 'unreachable') {
    return { kind: 'refused', reason: { kind: 'github-unavailable' }, status: HTTP_BAD_GATEWAY }
  }
  const status = error.failure === 'oauth-error' ? HTTP_BAD_REQUEST : HTTP_BAD_GATEWAY
  return { kind: 'refused', reason: { kind: 'try-again' }, status }
}

/**
 * Everything from `decide` to the `insertAccount` below runs without an
 * `await`, so two callbacks cannot interleave between the policy read and
 * the seat reservation; `insertAccount`'s own transaction is the backstop.
 */
function admit(deps: SigninDeps, profile: GithubProfile, ip: string): CallbackOutcome | Promise<CallbackOutcome> {
  const { db } = deps
  const now = new Date(deps.clock()).toISOString()
  const decision = decide({
    profile: { githubId: profile.id, login: profile.login, githubCreatedAt: profile.createdAt },
    now,
    existingAccount: findAccountByGithubId(db, profile.id),
    tombstone: findTombstone(db, profile.id),
    accountCount: countActive(db),
    maxAccounts: deps.maxAccounts,
    minAccountAgeDays: deps.minAccountAgeDays,
    orchestratorAvailable: deps.orchestrator.available,
    recentSignupsFromIp: deps.signups.count(ip),
    signupsPerHourPerIp: deps.signupsPerHourPerIp,
  })
  switch (decision.kind) {
    case 'existing':
      touch(db, profile.id, profile.login, now)
      return { kind: 'signed-in', account: { ...decision.account, login: profile.login, lastSeenAt: now } }
    case 'waitlist':
      return waitlisted(db, profile, now)
    case 'refused':
      return refusalOf(decision, deps.minAccountAgeDays)
    case 'create':
      return createAccount(deps, profile, ip, now)
  }
}

function waitlisted(db: AccountsDb, profile: GithubProfile, now: string): CallbackOutcome {
  return { kind: 'waitlist', position: joinWaitlist(db, { githubId: profile.id, login: profile.login, now }) }
}

function refusalOf(decision: Extract<SignupDecision, { kind: 'refused' }>, minAccountAgeDays: number): CallbackOutcome {
  const retryOn = decision.eligibleAt?.slice(0, 10)
  switch (decision.reason) {
    // Without a date there is nothing true to say but "try again".
    case 'too-young':
      return retryOn === undefined
        ? refused({ kind: 'try-again' }, HTTP_FORBIDDEN)
        : refused({ kind: 'too-young', retryOn, minAccountAgeDays }, HTTP_FORBIDDEN)
    case 'recently-deleted':
      return retryOn === undefined
        ? refused({ kind: 'try-again' }, HTTP_FORBIDDEN)
        : refused({ kind: 'recently-deleted', retryOn }, HTTP_FORBIDDEN)
    case 'blocked':
      return refused({ kind: 'blocked' }, HTTP_FORBIDDEN)
    case 'rate-limited':
      return refused({ kind: 'rate-limited' }, HTTP_TOO_MANY_REQUESTS)
  }
}

async function createAccount(deps: SigninDeps, profile: GithubProfile, ip: string, now: string): Promise<CallbackOutcome> {
  const { db } = deps
  const reserved = reserveSeat(deps, profile, now)
  if (reserved.kind !== 'reserved') return reserved.outcome
  deps.signups.record(ip)
  const { account } = reserved
  let ownerToken: string
  try {
    ownerToken = (await deps.orchestrator.create({ githubId: account.githubId, login: account.login, subdomain: account.subdomain })).ownerToken
  } catch (error: unknown) {
    discardPendingAccount(db, account.githubId)
    deps.log(`[hub] install creation failed for ${account.subdomain}, signup rolled back: ${describeOrchestratorError(error)}`)
    return refused({ kind: 'try-again' }, HTTP_SERVICE_UNAVAILABLE)
  }
  setStatus(db, account.githubId, 'active')
  deps.log(`[hub] account created: @${account.login} -> ${account.subdomain}`)
  return { kind: 'created', account: { ...account, status: 'active' }, ownerToken }
}

type SeatReservation =
  | { readonly kind: 'reserved'; readonly account: AccountRecord }
  | { readonly kind: 'not-reserved'; readonly outcome: CallbackOutcome }

function reserveSeat(deps: SigninDeps, profile: GithubProfile, now: string): SeatReservation {
  const { db } = deps
  let subdomain: string
  try {
    subdomain = assignSubdomain(profile.login, { isOccupied: (candidate) => findAccountBySubdomain(db, candidate) !== null })
  } catch (error: unknown) {
    if (!(error instanceof SubdomainExhaustedError)) throw error
    return { kind: 'not-reserved', outcome: refused({ kind: 'try-again' }, HTTP_CONFLICT) }
  }
  const input = { githubId: profile.id, login: profile.login, subdomain, githubCreatedAt: profile.createdAt, now }
  const inserted = insertAccount(db, input, deps.maxAccounts)
  if (inserted.ok) return { kind: 'reserved', account: inserted.account }
  // `decide` is advisory on capacity (signup-policy.ts): the seat went meanwhile.
  if (inserted.reason === 'cap-reached') return { kind: 'not-reserved', outcome: waitlisted(db, profile, now) }
  return { kind: 'not-reserved', outcome: refused({ kind: 'try-again' }, HTTP_CONFLICT) }
}
