import type { IncomingMessage } from 'node:http'
import {
  FirstOwnerRefusedError,
  InvalidAdminNameError,
  type AdminRecord,
  type CreatedAdmin,
} from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import type { LoginRateLimiter } from './auth.js'
import { loginRateLimitKey } from './auth.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_OK,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  LOGIN_LOCATION,
  SETUP_CODE_REFUSED_NOTICE,
  SETUP_RATE_LIMIT_WARNING,
  SETUP_TOO_MANY_ATTEMPTS_NOTICE,
} from './constants.js'
import { renderSetupDonePage, renderSetupPage } from './pages/setup.js'
import { headerValue, parseBodyFields, type UiRequestContext, type UiResult } from './routes.js'
import type { SetupGate } from './setup-gate.js'

/**
 * `GET|POST /setup` — the first-run page (ADR-0004, amendment of 2026-09-19):
 * the one request that creates an admin for a caller who holds no credential.
 * It lives beside the server, like `login-flow.ts`, because it needs what an
 * injected handler is deliberately not given: the peer address (rate limit)
 * and the gate.
 *
 * What stands in for the credential is the SETUP CODE, which the composition
 * root wrote to a 0600 file beside the store: presenting it proves the caller
 * can read this install's data directory — the same proof the bootstrap token
 * file asked for, now spent on choosing a name instead of inheriting one.
 *
 * The load-bearing order of a claim — rate limit counted before anything
 * awaits, then the gate, then the code BEFORE the name, then the store's own
 * atomic check-and-create — is `createFirstOwnerWithCode` below: a
 * transport-neutral core neither this HTML page nor the JSON
 * `POST /api/console/setup` (`console-api.ts`, ADR-0014) duplicates. This
 * module is now a thin renderer of that core's outcome; the core is the one
 * place the ordering can be gotten wrong.
 *
 * The answer to success is a document, not a redirect: the token exists only
 * in that response body (`no-store`, like every page).
 */

/** Diagnostics sink (stderr-shaped), injectable for tests. */
export interface SetupWarnSink {
  write(chunk: string): unknown
}

/** What the composition root hands the server to make `/setup` exist. */
export interface FirstRunOptions {
  readonly gate: SetupGate
  /** `AdminStore.createFirstOwner`: refuses atomically once any admin exists. */
  readonly createFirstOwner: (name: string) => Promise<CreatedAdmin>
  /**
   * Runs once the owner exists (journal record, removing the code file) and
   * says whether the `access-edit` record landed. Its failure is a stderr
   * line and never a withheld token: the admin is in the store by then, and
   * keeping back the only copy of its token because a file would not unlink
   * would lock the operator out of their own install. A record that did not
   * land — reported or thrown — puts `AUDIT_RECORD_DROPPED_WARNING` on the
   * token page, as on every other UI mutation (audit 2026-09-02, F1): this is
   * the record every later attribution hangs from.
   */
  readonly afterOwnerCreated?: (admin: AdminRecord) => Promise<{ readonly written: boolean }>
}

export interface SetupFlowDeps extends FirstRunOptions {
  readonly rateLimiter: LoginRateLimiter
  readonly stderr: SetupWarnSink
  readonly trustedProxyHeader?: string
}

function page(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}

const TO_LOGIN: UiResult = Object.freeze({
  kind: 'response',
  status: HTTP_STATUS_SEE_OTHER,
  headers: Object.freeze({ location: LOGIN_LOCATION }),
})

/** `GET /setup`: the form while the first run lasts, the sign-in screen after. */
export async function handleSetupPage(firstRun: FirstRunOptions | undefined): Promise<UiResult> {
  if (firstRun === undefined || !(await firstRun.gate.isOpen())) return TO_LOGIN
  return page(HTTP_STATUS_OK, renderSetupPage())
}

/** True when the audit record landed. No hook at all is the composition root's choice, not a drop. */
async function runAfterOwnerCreated(deps: FirstOwnerCoreDeps, admin: AdminRecord): Promise<boolean> {
  if (deps.afterOwnerCreated === undefined) return true
  try {
    return (await deps.afterOwnerCreated(admin)).written
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    deps.stderr.write(`[ui] after first-owner setup: ${formatReadableField(message)}\n`)
    return false
  }
}

// ---------------------------------------------------------------------------
// The transport-neutral core (ADR-0014, wave 1): every way of claiming the
// first owner — this HTML page and the JSON `POST /api/console/setup` — is a
// thin rendering of exactly one of these outcomes, produced by exactly one
// function, so the load-bearing ORDER (rate limit → gate → code → name →
// store CAS) is defined once rather than twice.
// ---------------------------------------------------------------------------

/** What `createFirstOwnerWithCode` needs beyond `FirstRunOptions`: the shared rate limiter and a stderr sink. */
export interface FirstOwnerCoreDeps extends FirstRunOptions {
  readonly rateLimiter: LoginRateLimiter
  readonly stderr: SetupWarnSink
}

/** One claim attempt: the caller's rate-limit key (already resolved by the transport) plus its two fields. */
export interface FirstOwnerCoreInput {
  readonly key: string
  readonly code: string
  readonly name: string
}

/**
 * The one outcome of a claim attempt, named for what a renderer does with it
 * rather than for what went wrong: a renderer needs to know WHICH page or
 * document to answer with, not re-derive it from an error class.
 */
export type FirstOwnerOutcome =
  | { readonly kind: 'rate-limited' }
  /** The gate is not open: an admin exists already, here or via a shell (or a race lost `createFirstOwner`'s CAS). */
  | { readonly kind: 'closed' }
  | { readonly kind: 'code-refused' }
  | { readonly kind: 'invalid-name'; readonly message: string }
  | {
      readonly kind: 'created'
      readonly admin: AdminRecord
      /** Shown to the operator exactly once; unrecoverable afterwards. */
      readonly token: string
      /** False when the `access-edit` record of this creation did not land (audit 2026-09-02, H4). */
      readonly journaled: boolean
    }

/**
 * The transport-neutral core of a first-owner claim. Order, load-bearing:
 *
 *  1. The keyed rate limit, counted before anything awaits (the reasoning is
 *     `login-flow.ts`'s, verbatim: an `await` between check and count turns
 *     the allowance into a burst). Shared with `/login`'s limiter by the
 *     caller passing the same instance, so neither surface is a second
 *     budget for the same address.
 *  2. The gate. Closed — an admin exists, here or via a shell — → `closed`.
 *  3. The code, BEFORE the name: a caller without the code learns nothing
 *     about this install, not even what names it would accept.
 *  4. The store's own check-and-create (`createFirstOwner`), atomic, so two
 *     holders of the code racing each other yield one owner.
 */
export async function createFirstOwnerWithCode(
  deps: FirstOwnerCoreDeps,
  input: FirstOwnerCoreInput,
): Promise<FirstOwnerOutcome> {
  if (!deps.rateLimiter.allow(input.key)) {
    deps.stderr.write(`${SETUP_RATE_LIMIT_WARNING}\n`)
    return { kind: 'rate-limited' }
  }
  deps.rateLimiter.recordFailure(input.key)
  if (!(await deps.gate.isOpen())) return { kind: 'closed' }
  if (!deps.gate.verify(input.code)) return { kind: 'code-refused' }

  let created: CreatedAdmin
  try {
    created = await deps.createFirstOwner(input.name)
  } catch (error: unknown) {
    if (error instanceof InvalidAdminNameError) return { kind: 'invalid-name', message: error.message }
    if (error instanceof FirstOwnerRefusedError) {
      deps.gate.close()
      return { kind: 'closed' }
    }
    throw error
  }
  deps.rateLimiter.recordSuccess(input.key)
  deps.gate.close()
  const journaled = await runAfterOwnerCreated(deps, created.admin)
  return { kind: 'created', admin: created.admin, token: created.token, journaled }
}

/** Renders one `FirstOwnerOutcome` as the HTML page's plan; `name` re-fills the form on a refusal. */
function renderSetupOutcome(outcome: FirstOwnerOutcome, name: string): UiResult {
  switch (outcome.kind) {
    case 'rate-limited':
      return page(HTTP_STATUS_TOO_MANY_REQUESTS, renderSetupPage({ error: SETUP_TOO_MANY_ATTEMPTS_NOTICE }))
    case 'closed':
      return TO_LOGIN
    case 'code-refused':
      return page(HTTP_STATUS_UNAUTHORIZED, renderSetupPage({ error: SETUP_CODE_REFUSED_NOTICE, name }))
    case 'invalid-name':
      return page(HTTP_STATUS_BAD_REQUEST, renderSetupPage({ error: outcome.message, name }))
    case 'created':
      return page(
        HTTP_STATUS_OK,
        renderSetupDonePage({
          admin: outcome.admin.name,
          token: outcome.token,
          ...(outcome.journaled ? {} : { warning: AUDIT_RECORD_DROPPED_WARNING }),
        }),
      )
  }
}

/** Handles one `POST /setup`, returning the plan for the server to write. */
export async function handleSetupRequest(
  deps: SetupFlowDeps,
  ctx: UiRequestContext,
  req: IncomingMessage,
): Promise<UiResult> {
  const key = loginRateLimitKey(req, deps.trustedProxyHeader)
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const name = fields.name ?? ''
  const outcome = await createFirstOwnerWithCode(deps, { key, code: fields.code ?? '', name })
  return renderSetupOutcome(outcome, name)
}
