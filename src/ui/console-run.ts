import type { IncomingMessage, ServerResponse } from 'node:http'
import { UNKNOWN_TOKEN_NOTICE } from '../admin/constants.js'
import { roleSatisfies, type Role } from '../admin/authz.js'
import { consoleRunRequestSchema, CONTENT_TYPE_NDJSON, type ConsoleRunFrame } from '../console-api/contract.js'
import type { ConsoleRunner, ConsoleRunnerRequest } from '../console-api/runner.js'
import type { AdminResolver, LoginRateLimiter, PenaltyGate } from './auth.js'
import { resolveConsoleBearer } from './console-auth.js'
import { writeConsoleError } from './console-respond.js'
import { readRequestBody } from './routes.js'
import { securityHeaders } from './security-headers.js'
import { TOO_MANY_ATTEMPTS_NOTICE } from './constants.js'

/**
 * `POST /api/console/run` (ADR-0014): the one endpoint that actually runs a
 * command. Everything before the run is a fail-closed gate, in order:
 *
 *  1. Bearer auth, exactly as `console-api.ts`'s other endpoints
 *     (`console-auth.ts`) — the rate limit and the byte-identical 401.
 *  2. The body against the wire schema (`bad-request` on anything else).
 *  3. The FIRST WORD of `argv` against a fixed allowlist (owner decision RC2
 *     names the surface as "everything the console can do"; `tui`, `ui`,
 *     `serve`, `wrap`, `connect`, `setup` and an empty argv are daemons and
 *     interactive screens that have no place in a request/response call).
 *  4. The NETWORK ROLE FLOOR for that command (owner decision RC1, follow-on
 *     from ADR-0012 §19: "console ≡ shell under the service's uid" does not
 *     hold over a network, so a coarse floor is enforced here — ON TOP OF,
 *     never instead of, each command's own gate, which still runs once
 *     `runner` dispatches).
 *  5. RC4: a vault WRITE (`vault set|remove|rekey`) is refused unless the
 *     connection is `--behind-tls` or the peer is loopback with no trusted
 *     proxy header configured (a header that could rewrite the peer address
 *     makes "the socket says loopback" untrustworthy).
 *
 * Only past all five does `runner` run, and its two streams become NDJSON
 * frames on the response — backpressure-aware, so a slow reader parks the
 * command's own write instead of buffering an unbounded run in memory, and a
 * reader that goes away releases that park instead of holding the command
 * forever (mirrors the fix to the `export` drain HIGH, `src/tui/run-sink.ts`).
 * Exactly one `exit` frame ends the stream, always last, whatever happened.
 */

/** Diagnostics sink (stderr-shaped), injectable for tests. Declared locally per the module's own precedent (`server.ts`'s `WarnSink`, `login-flow.ts`'s `LoginWarnSink`). */
export interface ConsoleRunWarnSink {
  write(chunk: string): unknown
}

export interface ConsoleRunDeps {
  readonly adminStore: AdminResolver
  readonly rateLimiter: LoginRateLimiter
  readonly penaltyGate?: PenaltyGate
  readonly trustedProxyHeader?: string
  readonly behindTls: boolean
  readonly maxBodyBytes: number
  readonly runner: ConsoleRunner
  readonly stderr: ConsoleRunWarnSink
}

// ---------------------------------------------------------------------------
// The allowlist and the network role floor (plan `remote-console.plan.md`,
// decision RC2). One fixed table so the wire surface cannot silently grow by
// a command module simply existing.
// ---------------------------------------------------------------------------

/** First-word allowlist: everything the console can run over the wire. Anything else is refused. */
const CONSOLE_ALLOWED_FIRST_WORDS: ReadonlySet<string> = new Set([
  'admin',
  'server',
  'vault',
  'agent',
  'group',
  'policy',
  'quarantine',
  'approvals',
  'sessions',
  'show',
  'export',
  'verify',
  'prune',
  'keygen',
  'backup',
  'migrate',
  'status',
  'start',
  'stop',
  'logs',
])

/**
 * First words whose network floor is `owner` — daemons, evidence-shaping
 * commands, and the vault: `vault init|list` have no gate of their own (they
 * were host reads), and the web UI shows secret NAMES to `owner` only.
 */
const OWNER_FLOOR_FIRST_WORDS: ReadonlySet<string> = new Set([
  'vault',
  'keygen',
  'backup',
  'migrate',
  'verify',
  'prune',
  'start',
  'stop',
  'logs',
])

const CONSOLE_ROLE_FLOOR_DEFAULT: Role = 'viewer'

/** `export` flags that make it write a report directory on the SERVER — `backup <dir>` in kind. */
const EXPORT_DISK_FLAGS: readonly string[] = ['--report', '--out']

/** True for `--flag` and `--flag=value` alike. */
function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

function writesServerDisk(argv: readonly string[]): boolean {
  return EXPORT_DISK_FLAGS.some((flag) => hasFlag(argv, flag))
}

/**
 * `policy show` with no flag at all is the one `policy` form a `viewer` may
 * ask for. Every other form either names a file on the server (`--policy`,
 * `validate <path>`) or has no gate of its own to fall back on — and
 * `policy show --policy <path>` would otherwise be a file-probing oracle for
 * the lowest role (security review, H2). Written as an allow of ONE shape
 * rather than a deny of known flags, so a flag added later is not a new hole.
 */
function isPlainPolicyShow(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[1] === 'show'
}

/**
 * The network floor for one already-allowlisted argv. A command's OWN gate
 * (e.g. `vault set` refusing below `owner`, `quarantine approve` below
 * `operator`) keeps acting on top of this — the floor is a coarse pre-check,
 * not a replacement for it.
 */
function roleFloorOf(argv: readonly string[]): Role {
  const first = argv[0]
  if (first !== undefined && OWNER_FLOOR_FIRST_WORDS.has(first)) return 'owner'
  if (first === 'export') return writesServerDisk(argv) ? 'owner' : 'operator'
  if (first === 'policy') return isPlainPolicyShow(argv) ? CONSOLE_ROLE_FLOOR_DEFAULT : 'operator'
  return CONSOLE_ROLE_FLOOR_DEFAULT
}

/** `vault set|remove|rekey`: the one shape RC4 gates on network exposure, not on role. */
function isVaultWrite(argv: readonly string[]): boolean {
  return argv[0] === 'vault' && (argv[1] === 'set' || argv[1] === 'remove' || argv[1] === 'rekey')
}

/**
 * True for the loopback addresses Node's socket reports, including the
 * IPv4-mapped IPv6 form a dual-stack listener sees for an IPv4 peer. Narrow on
 * purpose — the exact set `net/origin-host.ts`'s `LOCALHOST_HOSTNAMES` already
 * treats as local, not the whole `127.0.0.0/8` block.
 */
function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false
  const stripped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return stripped === '127.0.0.1' || stripped === '::1'
}

/**
 * RC4: a vault write is allowed over TLS unconditionally, or over plain HTTP
 * only from the loopback peer AND only while no trusted-proxy header is
 * configured — a header that could rewrite what the socket reports makes
 * "the peer looks like loopback" a claim the proxy controls, not the network.
 */
function isVaultWriteAllowed(req: IncomingMessage, deps: ConsoleRunDeps): boolean {
  if (deps.behindTls) return true
  if (deps.trustedProxyHeader !== undefined) return false
  return isLoopbackPeer(req.socket.remoteAddress)
}

// ---------------------------------------------------------------------------
// Messages. Fixed sentences, never composed from request data — the point of
// a `forbidden`/`bad-request` refusal is that it says nothing an attacker
// could not already have guessed from the allowlist itself.
// ---------------------------------------------------------------------------

const CONSOLE_RUN_BAD_REQUEST_MESSAGE = 'Malformed run request.'
const CONSOLE_RUN_COMMAND_REFUSED_MESSAGE =
  'This command has no remote-console form: it is a daemon, an interactive screen, or not on the allowlist.'
const CONSOLE_RUN_ROLE_REFUSED_MESSAGE = 'Your role does not meet the network floor for this command.'
const CONSOLE_RUN_VAULT_HTTP_REFUSED_MESSAGE =
  'Writing to the vault over plain HTTP from a non-loopback peer is refused; use HTTPS or run the console on this host.'
const CONSOLE_RUN_INTERNAL_FRAME_MESSAGE = 'The command failed unexpectedly.'

/** Exit code answered when the runner itself throws, rather than the command exiting non-zero on its own. */
const RUN_INTERNAL_FAILURE_EXIT_CODE = 1

// ---------------------------------------------------------------------------
// Streaming: one write per frame, backpressure honoured, a `close`d peer
// releases any parked write instead of holding the run open forever.
// ---------------------------------------------------------------------------

/** Every event that can end a wait for the response to accept more: it drained, or it never will again. */
const SETTLING_EVENTS = ['drain', 'close', 'error'] as const

/**
 * Releases a writer parked on backpressure, whatever ends the wait — mirrors
 * `src/tui/run-sink.ts`'s `releaseOnSettled`, reimplemented here rather than
 * imported: that module is `src/tui/**`, out of bounds for this wave, and a
 * `ServerResponse` is a different stream than the `WriteStream` it was written
 * for. A response already ended or destroyed releases on the next microtask —
 * the event that would free the writer has already gone by.
 */
function onceDrainOrSettled(res: ServerResponse, listener: () => void): void {
  if (res.writableEnded || res.destroyed) {
    queueMicrotask(listener)
    return
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    for (const event of SETTLING_EVENTS) res.off(event, release)
    listener()
  }
  for (const event of SETTLING_EVENTS) res.once(event, release)
}

/** One frame, newline-delimited (NDJSON). */
function frameLine(frame: ConsoleRunFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/** Builds the `stdout`/`stderr` writable the runner sees: every write becomes one `out`/`err` frame. */
function consoleFrameWritable(res: ServerResponse, t: 'out' | 'err') {
  return {
    write: (chunk: string): boolean => {
      // A peer that has gone away is answered `true` (never blocked on): the
      // response is already lost, so nothing is gained by pretending this
      // write might still apply backpressure.
      if (res.writableEnded || res.destroyed) return true
      return res.write(frameLine({ t, d: chunk }))
    },
    once: (event: 'drain', listener: () => void): void => {
      if (event !== 'drain') return
      onceDrainOrSettled(res, listener)
    },
  }
}

const REDACTED_PLACEHOLDER = '[redacted]'

/**
 * Removes every occurrence of the request's bearer token and (if any) its
 * `stdin` secret from a piece of text before it reaches the server's stderr —
 * the defence-in-depth half of the same guarantee `consoleFrameWritable`
 * gives the client-visible frames. A thrown error's message is the one piece
 * of text in this module NOT built by `console-run.ts` itself, so it is the
 * one place a command's own bug (or a hostile one) could embed either value;
 * this makes that embedding harmless instead of trusting every command never
 * to do it.
 */
function redactRequestSecrets(text: string, request: ConsoleRunnerRequest): string {
  let redacted = text.split(request.token).join(REDACTED_PLACEHOLDER)
  if (request.stdin !== undefined && request.stdin !== '') {
    redacted = redacted.split(request.stdin).join(REDACTED_PLACEHOLDER)
  }
  return redacted
}

/** Ends the response with one `exit` frame, unless the peer is already gone. */
function endWithExit(res: ServerResponse, code: number): void {
  if (res.writableEnded || res.destroyed) return
  res.end(frameLine({ t: 'exit', code }))
}

/** Runs the command and streams its two outputs; always ends with exactly one `exit` frame. */
async function streamRun(
  res: ServerResponse,
  deps: ConsoleRunDeps,
  request: ConsoleRunnerRequest,
): Promise<void> {
  res.writeHead(200, {
    'content-type': CONTENT_TYPE_NDJSON,
    'cache-control': 'no-store',
    ...securityHeaders({ behindTls: deps.behindTls }),
  })

  let exitCode: number
  try {
    exitCode = await deps.runner(request, {
      stdout: consoleFrameWritable(res, 'out'),
      stderr: consoleFrameWritable(res, 'err'),
    })
  } catch (error: unknown) {
    // The detail — which may name a path, a store error, anything the server
    // process saw — goes to the server's OWN stderr, never the client: the
    // frame the client gets is one fixed, safe sentence. The bearer and the
    // secret are redacted from the stderr line too, defensively: a command
    // that (bug or not) embedded either in a thrown message must not be the
    // one place they leak, even to a log this server's own operator reads.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    deps.stderr.write(`[ui] console run failed: ${redactRequestSecrets(detail, request)}\n`)
    if (!res.writableEnded && !res.destroyed) {
      res.write(frameLine({ t: 'err', d: CONSOLE_RUN_INTERNAL_FRAME_MESSAGE }))
    }
    exitCode = RUN_INTERNAL_FAILURE_EXIT_CODE
  }
  endWithExit(res, exitCode)
}

/** Parses a request body as JSON, tolerating anything unparseable (the schema below rejects it). */
function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

/** Handles one `POST /api/console/run`. */
export async function handleConsoleRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleRunDeps,
): Promise<void> {
  const auth = await resolveConsoleBearer(deps, req)
  if (auth.kind === 'rate-limited') {
    writeConsoleError(res, 429, 'rate-limited', TOO_MANY_ATTEMPTS_NOTICE, deps.behindTls)
    return
  }
  if (auth.kind === 'unauthorized') {
    writeConsoleError(res, 401, 'unauthorized', UNKNOWN_TOKEN_NOTICE, deps.behindTls)
    return
  }

  const bodyResult = await readRequestBody(req, deps.maxBodyBytes)
  if (!bodyResult.ok) {
    res.destroy()
    return
  }
  const parsed = consoleRunRequestSchema.safeParse(parseJsonBody(bodyResult.body))
  if (!parsed.success) {
    writeConsoleError(res, 400, 'bad-request', CONSOLE_RUN_BAD_REQUEST_MESSAGE, deps.behindTls)
    return
  }

  const { argv } = parsed.data
  const first = argv[0]
  if (first === undefined || !CONSOLE_ALLOWED_FIRST_WORDS.has(first)) {
    writeConsoleError(res, 403, 'forbidden', CONSOLE_RUN_COMMAND_REFUSED_MESSAGE, deps.behindTls)
    return
  }
  if (!roleSatisfies(auth.admin.role, roleFloorOf(argv))) {
    writeConsoleError(res, 403, 'forbidden', CONSOLE_RUN_ROLE_REFUSED_MESSAGE, deps.behindTls)
    return
  }
  if (isVaultWrite(argv) && !isVaultWriteAllowed(req, deps)) {
    writeConsoleError(res, 403, 'forbidden', CONSOLE_RUN_VAULT_HTTP_REFUSED_MESSAGE, deps.behindTls)
    return
  }

  const request: ConsoleRunnerRequest = {
    argv,
    ...(parsed.data.stdin !== undefined ? { stdin: parsed.data.stdin } : {}),
    token: auth.token,
  }
  await streamRun(res, deps, request)
}
