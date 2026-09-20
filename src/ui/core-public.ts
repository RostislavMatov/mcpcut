import type { IncomingMessage } from 'node:http'
import type { RouteEntry } from './authz.js'
import { HTTP_STATUS_SEE_OTHER, LOGIN_LOCATION, SETUP_LOCATION } from './constants.js'
import { handleLoginRequest, type LoginFlowDeps } from './login-flow.js'
import type { UiRequestContext, UiResult } from './routes.js'
import { handleSetupPage, handleSetupRequest, type FirstRunOptions } from './setup-flow.js'

/**
 * The public routes the server core serves ITSELF — `POST /login`, `GET|POST
 * /setup` — plus the one question both they and the signed-out redirect ask:
 * is this install still in its first run? Split out of `server.ts` when the
 * first-run page arrived (2026-09-19) and that file had no room for it; the
 * seam is the two dependency bags the flows already declared.
 *
 * Handler keys are matched by the `@`-prefixed names `authz.ts`'s route table
 * gives them; an entry this module does not own answers `undefined` and the
 * server dispatches it to the injected handler map as before.
 */

/** Route-table keys of the core-served public routes. */
export const CORE_HANDLER_LOGIN = '@login'
export const CORE_HANDLER_SETUP_PAGE = '@setupPage'
export const CORE_HANDLER_SETUP = '@setup'
/** The injected sign-in screen — intercepted, not served, while the first run lasts. */
const INJECTED_LOGIN_PAGE = 'loginPage'

export interface CorePublicDeps {
  readonly login: LoginFlowDeps
  /** Absent — `/setup` answers `/login`, as if the first run were over. */
  readonly firstRun?: FirstRunOptions
}

export interface CorePublicRoutes {
  /**
   * Where a caller who is not signed in belongs: the sign-in screen, or —
   * while the install has no admin at all — the first-run page. Asked per
   * request because a shell may create the first admin at any moment; a gate
   * that has closed answers without touching the store.
   */
  signedOutLocation(): Promise<string>
  /** The plan for a core-served public route; `undefined` for an injected one. */
  handle(entry: RouteEntry, ctx: UiRequestContext, req: IncomingMessage): Promise<UiResult | undefined>
}

export function createCorePublicRoutes(deps: CorePublicDeps): CorePublicRoutes {
  const { firstRun, login } = deps

  async function isFirstRun(): Promise<boolean> {
    return firstRun !== undefined && (await firstRun.gate.isOpen())
  }

  async function handle(
    entry: RouteEntry,
    ctx: UiRequestContext,
    req: IncomingMessage,
  ): Promise<UiResult | undefined> {
    if (entry.handler === CORE_HANDLER_LOGIN) return handleLoginRequest(login, ctx, req)
    if (entry.handler === CORE_HANDLER_SETUP_PAGE) return handleSetupPage(firstRun)
    if (entry.handler === CORE_HANDLER_SETUP) {
      if (firstRun === undefined) return handleSetupPage(undefined)
      const { rateLimiter, stderr, trustedProxyHeader } = login
      return handleSetupRequest(
        {
          ...firstRun,
          rateLimiter,
          stderr,
          ...(trustedProxyHeader !== undefined ? { trustedProxyHeader } : {}),
        },
        ctx,
        req,
      )
    }
    // The sign-in screen of an install with no admin is a form nothing can
    // satisfy; the first-run page is the honest answer to the same visit.
    if (entry.handler === INJECTED_LOGIN_PAGE && (await isFirstRun())) {
      return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location: SETUP_LOCATION } }
    }
    return undefined
  }

  return Object.freeze({
    signedOutLocation: async () => ((await isFirstRun()) ? SETUP_LOCATION : LOGIN_LOCATION),
    handle,
  })
}
