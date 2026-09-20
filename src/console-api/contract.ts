import { z } from 'zod'

/**
 * The wire contract of the remote console (ADR-0014): what `mcpcut --remote
 * <url>` says to a `ui` service on another host, and what it hears back.
 *
 * One leaf module imported by BOTH sides — the routes in `src/ui/console-api*`
 * and the client in `src/tui/remote/*` — so neither can drift from the other,
 * and both validate what arrives with the same schemas: the server never
 * trusts a request body, the client never trusts a response.
 *
 * The console is a thin layer over `dispatch(argv)`, so the contract is thin
 * too: a command goes over as its argv (plus the one secret a form may carry,
 * which must never be in argv), and comes back as the two streams and the exit
 * code a local dispatch would have produced. Everything else a console does —
 * forms, tabs, the live queue, writing an export to a file — stays on the
 * client.
 *
 * Authentication is the admin's own token as `Authorization: Bearer`, on every
 * request: there is no cookie and no server-side console session. A request
 * that carries an `Origin` header is refused — no browser is a client of this
 * API, and refusing them all is the whole CSRF story.
 */

/** Bumped when a change would make an old client misread a new server. */
export const CONSOLE_API_VERSION = 1

export const CONSOLE_API_PREFIX = '/api/console/'
export const CONSOLE_API_STATE_PATH = '/api/console/state'
export const CONSOLE_API_WHOAMI_PATH = '/api/console/whoami'
export const CONSOLE_API_SETUP_PATH = '/api/console/setup'
export const CONSOLE_API_RUN_PATH = '/api/console/run'

export const CONTENT_TYPE_NDJSON = 'application/x-ndjson'
export const BEARER_PREFIX = 'Bearer '

/** Bounds on a run request; an argv beyond them is nothing a console form produces. */
export const MAX_RUN_ARGV_ENTRIES = 64
export const MAX_RUN_ARG_LENGTH = 8192
export const MAX_RUN_STDIN_LENGTH = 65536

/** `GET state` — public: the one thing a console must know before anybody can sign in. */
export const consoleStateSchema = z.strictObject({
  api: z.number().int(),
  /** True while the install has no admin: the console opens its first-owner screen. */
  firstRun: z.boolean(),
})
export type ConsoleState = z.infer<typeof consoleStateSchema>

/** `POST whoami` — the token in the header, resolved to the admin it names. */
export const consoleWhoamiSchema = z.strictObject({
  name: z.string().min(1),
  role: z.enum(['owner', 'operator', 'viewer']),
})
export type ConsoleWhoami = z.infer<typeof consoleWhoamiSchema>

/** `POST setup` — the first owner, by the code from `<data dir>/setup-code` (ADR-0004, 2026-09-19). */
export const consoleSetupRequestSchema = z.strictObject({
  code: z.string().max(MAX_RUN_ARG_LENGTH),
  name: z.string().max(MAX_RUN_ARG_LENGTH),
})
export type ConsoleSetupRequest = z.infer<typeof consoleSetupRequestSchema>

export const consoleSetupResponseSchema = z.strictObject({
  name: z.string().min(1),
  /** The only copy of the owner's token; the response is `no-store`. */
  token: z.string().min(1),
  /** False when the `access-edit` record of this creation did not land (audit 2026-09-02, H4). */
  journaled: z.boolean(),
})
export type ConsoleSetupResponse = z.infer<typeof consoleSetupResponseSchema>

/** `POST run` — one command of the catalogue. */
export const consoleRunRequestSchema = z.strictObject({
  argv: z.array(z.string().max(MAX_RUN_ARG_LENGTH)).min(1).max(MAX_RUN_ARGV_ENTRIES),
  /** The vault secret of `vault set`. Never in argv, never logged, never echoed. */
  stdin: z.string().max(MAX_RUN_STDIN_LENGTH).optional(),
})
export type ConsoleRunRequest = z.infer<typeof consoleRunRequestSchema>

/**
 * One line of a run's NDJSON answer. `out`/`err` frames arrive as the command
 * writes; exactly one `exit` frame ends a run. A stream that ends without one
 * is a run whose outcome is unknown — the client reports it as failed, never
 * as exit 0.
 */
export const consoleRunFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('out'), d: z.string() }),
  z.strictObject({ t: z.literal('err'), d: z.string() }),
  z.strictObject({ t: z.literal('exit'), code: z.number().int() }),
])
export type ConsoleRunFrame = z.infer<typeof consoleRunFrameSchema>

/**
 * Every refusal (any non-200) is this document. `error` is for the client's
 * branching, `message` is for the operator's eyes and is already safe to show.
 */
export const CONSOLE_API_ERRORS = [
  'unauthorized',
  'forbidden',
  'bad-request',
  'rate-limited',
  'code-refused',
  'invalid-name',
  'closed',
] as const

export const consoleErrorSchema = z.strictObject({
  error: z.enum(CONSOLE_API_ERRORS),
  message: z.string(),
})
export type ConsoleError = z.infer<typeof consoleErrorSchema>
