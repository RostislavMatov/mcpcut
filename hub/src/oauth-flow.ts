import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The hub's half of one GitHub sign-in (plan `hub-signin-accounts`, Task 3):
 * `begin()` mints the `state` and the PKCE pair for `GET /signin`, and
 * `complete()` redeems them once on `GET /auth/github/callback`.
 *
 * What makes the callback trustworthy is the pairing of three things no
 * attacker holds together: the flow id in a `__Host-` cookie on the
 * victim's browser, the `state` GitHub echoes back, and the PKCE verifier
 * that never left this process. A forged callback (login CSRF — an attacker
 * signing the victim into the attacker's account) carries the attacker's
 * `state` but the victim's cookie, and the pair does not match.
 *
 * Everything lives in memory: a restart forgets every open flow, which costs
 * a person one more click on "Sign in with GitHub" — the same trade the
 * console's sessions make (ADR-0004). The verifier is returned by
 * `complete()` only, never by `begin()`: it has nowhere to go but the code
 * exchange.
 */

/** GitHub's authorization code lives ten minutes; a flow outliving it is useless. */
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000
/**
 * Ceiling on open flows. Each is ~200 bytes, so the cap bounds memory at a
 * few MB however hard `/signin` is hammered; the per-IP limit on that route
 * (Task 5) is what keeps an attacker from evicting other people's flows.
 */
export const OAUTH_FLOW_MAX_ENTRIES = 10_000

/** 32 bytes → 43 base64url characters: the RFC 7636 verifier and 256 bits for ids. */
const FLOW_RANDOM_BYTES = 32
const FLOW_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const OAUTH_FLOW_COOKIE_NAME = '__Host-mcpcut_oauth'
export const OAUTH_FLOW_COOKIE_MAX_AGE_SECONDS = OAUTH_FLOW_TTL_MS / 1000

/**
 * `SameSite=Lax`, not the `Strict` the session cookie uses: the callback is
 * a top-level navigation arriving FROM github.com, and a `Strict` cookie is
 * withheld from exactly that request — every sign-in would fail. `__Host-`
 * requires `Secure`, `Path=/` and no `Domain`, which also keeps a tenant's
 * `*.mcpcut.com` page from planting this cookie for the apex.
 */
const FLOW_COOKIE_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'] as const

/** What `GET /signin` needs: the cookie value and the two authorize-URL parameters. */
export interface FlowStart {
  readonly flowId: string
  readonly state: string
  readonly challenge: string
}

export type FlowRefusal = 'missing' | 'unknown-flow' | 'expired' | 'state-mismatch'

export type FlowCompletion =
  | { readonly ok: true; readonly verifier: string }
  | { readonly ok: false; readonly reason: FlowRefusal }

export interface OauthFlows {
  begin(): FlowStart
  /**
   * Redeems a flow. Single-use whatever the outcome: any callback carrying
   * the cookie ends the flow, so a wrong `state` cannot be retried against
   * it and a replayed callback finds nothing.
   */
  complete(input: { readonly flowId: string | undefined; readonly state: string | undefined }): FlowCompletion
  /** Open flows, for tests and diagnostics. */
  size(): number
}

export interface OauthFlowOptions {
  readonly clock?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
}

interface FlowEntry {
  readonly stateDigest: Buffer
  readonly verifier: string
  readonly expiresAt: number
}

/** RFC 7636 §4.2 `S256`: base64url(sha256(ASCII(verifier))), unpadded. */
export function pkceChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function createOauthFlows(options: OauthFlowOptions = {}): OauthFlows {
  const clock = options.clock ?? Date.now
  const ttlMs = options.ttlMs ?? OAUTH_FLOW_TTL_MS
  const maxEntries = options.maxEntries ?? OAUTH_FLOW_MAX_ENTRIES
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`createOauthFlows: ttlMs must be a positive finite number, got ${ttlMs}`)
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(`createOauthFlows: maxEntries must be a positive integer, got ${maxEntries}`)
  }
  // Insertion order is creation order, and with one TTL for all also expiry
  // order: the first key is always the oldest flow.
  const flows = new Map<string, FlowEntry>()

  function sweep(now: number): void {
    for (const [flowId, entry] of flows) {
      if (entry.expiresAt > now) return
      flows.delete(flowId)
    }
  }

  function evictToFit(): void {
    for (const flowId of flows.keys()) {
      if (flows.size < maxEntries) return
      flows.delete(flowId)
    }
  }

  return {
    begin(): FlowStart {
      const now = clock()
      sweep(now)
      evictToFit()
      const flowId = randomValue()
      const state = randomValue()
      const verifier = randomValue()
      flows.set(flowId, { stateDigest: digestOf(state), verifier, expiresAt: now + ttlMs })
      return { flowId, state, challenge: pkceChallengeOf(verifier) }
    },
    complete({ flowId, state }): FlowCompletion {
      if (flowId === undefined || flowId === '' || state === undefined || state === '') {
        return { ok: false, reason: 'missing' }
      }
      const entry = flows.get(flowId)
      if (entry === undefined) return { ok: false, reason: 'unknown-flow' }
      flows.delete(flowId)
      if (clock() >= entry.expiresAt) return { ok: false, reason: 'expired' }
      // Digests, not the raw strings: equal lengths whatever the caller sent,
      // so `timingSafeEqual` neither throws nor leaks the length.
      if (!timingSafeEqual(digestOf(state), entry.stateDigest)) return { ok: false, reason: 'state-mismatch' }
      return { ok: true, verifier: entry.verifier }
    },
    size: () => flows.size,
  }
}

/** The `Set-Cookie` value carrying a flow id to the callback. */
export function serializeFlowCookie(flowId: string): string {
  if (!FLOW_VALUE_PATTERN.test(flowId)) {
    // A value outside the pattern could smuggle attributes (`; Domain=…`).
    throw new TypeError('serializeFlowCookie: not a flow id')
  }
  return [`${OAUTH_FLOW_COOKIE_NAME}=${flowId}`, ...FLOW_COOKIE_ATTRIBUTES, `Max-Age=${OAUTH_FLOW_COOKIE_MAX_AGE_SECONDS}`].join(
    '; ',
  )
}

/** The `Set-Cookie` value that removes the flow cookie once the callback has used it. */
export function clearFlowCookie(): string {
  return [`${OAUTH_FLOW_COOKIE_NAME}=`, ...FLOW_COOKIE_ATTRIBUTES, 'Max-Age=0'].join('; ')
}

/**
 * The flow id from a request's `Cookie` header, or `undefined`. A malformed
 * value reads as absent. The same name with two different values is
 * ambiguous and also reads as absent: guessing which one is ours is how a
 * planted cookie would win.
 */
export function flowIdFromCookieHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const values = new Set<string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== OAUTH_FLOW_COOKIE_NAME) continue
    values.add(part.slice(eq + 1).trim())
  }
  if (values.size !== 1) return undefined
  const [value] = values
  return value !== undefined && FLOW_VALUE_PATTERN.test(value) ? value : undefined
}

function randomValue(): string {
  return randomBytes(FLOW_RANDOM_BYTES).toString('base64url')
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
