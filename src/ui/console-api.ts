import type { IncomingMessage, ServerResponse } from 'node:http'
import { UNKNOWN_TOKEN_NOTICE } from '../admin/constants.js'
import {
  CONSOLE_API_RUN_PATH,
  CONSOLE_API_SETUP_PATH,
  CONSOLE_API_STATE_PATH,
  CONSOLE_API_VERSION,
  CONSOLE_API_WHOAMI_PATH,
  consoleSetupRequestSchema,
  type ConsoleSetupResponse,
  type ConsoleState,
  type ConsoleWhoami,
} from '../console-api/contract.js'
import type { ConsoleRunner } from '../console-api/runner.js'
import type { AdminResolver, LoginRateLimiter, PenaltyGate } from './auth.js'
import { loginRateLimitKey } from './auth.js'
import { resolveConsoleBearer } from './console-auth.js'
import { handleConsoleRun, type ConsoleRunWarnSink } from './console-run.js'
import { writeConsoleError, writeConsoleJson } from './console-respond.js'
import { headerValue, parseTarget, readRequestBody } from './routes.js'
import { SETUP_CODE_REFUSED_NOTICE, TOO_MANY_ATTEMPTS_NOTICE } from './constants.js'
import { createFirstOwnerWithCode, type FirstOwnerOutcome, type FirstRunOptions } from './setup-flow.js'

/**
 * `/api/console/*` (ADR-0014): the JSON surface `mcpcut --remote <url>`
 * speaks to, on the SAME port and process as the browser admin UI but through
 * none of its machinery — `server.ts` branches here BEFORE the cookie
 * resolution and the "POST without Origin" rule apply, so this module owns
 * its own, stricter rule for the whole prefix: no cookie is ever read, and a
 * request carrying ANY `Origin` header (not just on a POST) is refused —
 * no browser is a legitimate caller of this API, and refusing every one of
 * them is the whole CSRF story here (`contract.ts`'s own module doc).
 *
 * `GET state` is the one unauthenticated route (a console must know whether
 * to open its first-owner screen before anyone can sign in); `whoami`,
 * `setup` and `run` all answer through this router too, each a thin
 * transport wrapper: `whoami` resolves the bearer, `setup` renders
 * `createFirstOwnerWithCode`'s outcome as JSON instead of a page, and `run`
 * is handed off to `console-run.ts` in full (it owns the streaming answer).
 *
 * An unmatched method or path under the prefix is refused the same
 * detail-free 403 as a request that carries an Origin: this router does not
 * distinguish "wrong path" from "not a client of this API" on the wire, which
 * is what keeps it from being an existence oracle over its own surface.
 */

export interface ConsoleApiOptions {
  readonly adminStore: AdminResolver
  readonly rateLimiter: LoginRateLimiter
  /** The server's ONE gate, shared with `/login`: bounds how many callers sit in the global penalty at once. */
  readonly penaltyGate?: PenaltyGate
  readonly trustedProxyHeader?: string
  /** Absent — `POST /api/console/setup` always answers `closed`, the same as an HTML `/setup` built without `firstRun`. */
  readonly firstRun?: FirstRunOptions
  readonly runner: ConsoleRunner
  readonly behindTls: boolean
  readonly maxBodyBytes: number
  readonly stderr: ConsoleRunWarnSink
}

export interface ConsoleApiRouter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const CONSOLE_CLOSED_MESSAGE = 'This install already has an admin: the first-run setup is closed.'
const CONSOLE_SETUP_BAD_REQUEST_MESSAGE = 'Malformed setup request.'
const CONSOLE_ROUTE_REFUSED_MESSAGE = 'Not found.'
const CONSOLE_NO_BROWSERS_MESSAGE =
  'The remote console API is not a browser client; a request carrying Origin is refused.'

/** Parses a request body as JSON, tolerating anything unparseable (the schema below rejects it). */
function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

/** Renders one `FirstOwnerOutcome` as the JSON answer of `POST /api/console/setup`. */
function writeSetupOutcome(res: ServerResponse, outcome: FirstOwnerOutcome, behindTls: boolean): void {
  switch (outcome.kind) {
    case 'rate-limited':
      writeConsoleError(res, 429, 'rate-limited', TOO_MANY_ATTEMPTS_NOTICE, behindTls)
      return
    case 'closed':
      writeConsoleError(res, 409, 'closed', CONSOLE_CLOSED_MESSAGE, behindTls)
      return
    case 'code-refused':
      writeConsoleError(res, 401, 'code-refused', SETUP_CODE_REFUSED_NOTICE, behindTls)
      return
    case 'invalid-name':
      writeConsoleError(res, 400, 'invalid-name', outcome.message, behindTls)
      return
    case 'created': {
      const body: ConsoleSetupResponse = {
        name: outcome.admin.name,
        token: outcome.token,
        journaled: outcome.journaled,
      }
      writeConsoleJson(res, 200, body, behindTls)
      return
    }
  }
}

export function createConsoleApiRoutes(opts: ConsoleApiOptions): ConsoleApiRouter {
  async function handleState(res: ServerResponse): Promise<void> {
    const firstRun = opts.firstRun !== undefined && (await opts.firstRun.gate.isOpen())
    const body: ConsoleState = { api: CONSOLE_API_VERSION, firstRun }
    writeConsoleJson(res, 200, body, opts.behindTls)
  }

  async function handleWhoami(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = await resolveConsoleBearer(opts, req)
    if (result.kind === 'rate-limited') {
      writeConsoleError(res, 429, 'rate-limited', TOO_MANY_ATTEMPTS_NOTICE, opts.behindTls)
      return
    }
    if (result.kind === 'unauthorized') {
      writeConsoleError(res, 401, 'unauthorized', UNKNOWN_TOKEN_NOTICE, opts.behindTls)
      return
    }
    const body: ConsoleWhoami = { name: result.admin.name, role: result.admin.role }
    writeConsoleJson(res, 200, body, opts.behindTls)
  }

  async function handleSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (opts.firstRun === undefined) {
      writeConsoleError(res, 409, 'closed', CONSOLE_CLOSED_MESSAGE, opts.behindTls)
      return
    }
    const bodyResult = await readRequestBody(req, opts.maxBodyBytes)
    if (!bodyResult.ok) {
      res.destroy()
      return
    }
    const parsed = consoleSetupRequestSchema.safeParse(parseJsonBody(bodyResult.body))
    if (!parsed.success) {
      writeConsoleError(res, 400, 'bad-request', CONSOLE_SETUP_BAD_REQUEST_MESSAGE, opts.behindTls)
      return
    }
    const key = loginRateLimitKey(req, opts.trustedProxyHeader)
    const outcome = await createFirstOwnerWithCode(
      { ...opts.firstRun, rateLimiter: opts.rateLimiter, stderr: opts.stderr },
      { key, code: parsed.data.code, name: parsed.data.name },
    )
    writeSetupOutcome(res, outcome, opts.behindTls)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No browser is a legitimate caller of this API (module doc): a request
    // carrying Origin is refused outright, on every method and every path
    // under the prefix — a GET included, unlike the cookie-based UI's rule.
    if (headerValue(req.headers, 'origin') !== undefined) {
      writeConsoleError(res, 403, 'forbidden', CONSOLE_NO_BROWSERS_MESSAGE, opts.behindTls)
      return
    }
    const { path } = parseTarget(req.url)
    const method = req.method ?? ''
    if (method === 'GET' && path === CONSOLE_API_STATE_PATH) {
      await handleState(res)
      return
    }
    if (method === 'POST' && path === CONSOLE_API_WHOAMI_PATH) {
      await handleWhoami(req, res)
      return
    }
    if (method === 'POST' && path === CONSOLE_API_SETUP_PATH) {
      await handleSetup(req, res)
      return
    }
    if (method === 'POST' && path === CONSOLE_API_RUN_PATH) {
      await handleConsoleRun(req, res, {
        adminStore: opts.adminStore,
        rateLimiter: opts.rateLimiter,
        ...(opts.penaltyGate !== undefined ? { penaltyGate: opts.penaltyGate } : {}),
        ...(opts.trustedProxyHeader !== undefined ? { trustedProxyHeader: opts.trustedProxyHeader } : {}),
        behindTls: opts.behindTls,
        maxBodyBytes: opts.maxBodyBytes,
        runner: opts.runner,
        stderr: opts.stderr,
      })
      return
    }
    // Deny-by-default, same as the cookie-based UI's unlisted route: no
    // existence oracle over which paths under the prefix are real.
    writeConsoleError(res, 403, 'forbidden', CONSOLE_ROUTE_REFUSED_MESSAGE, opts.behindTls)
  }

  return Object.freeze({ handle })
}
