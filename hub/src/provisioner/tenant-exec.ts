import { z } from 'zod'
import type { DockerClient } from './docker.js'
import { ProvisionerError } from './errors.js'
import { TENANT_CLI, TENANT_HOME_MOUNT, TENANT_USER } from './templates.js'
import { ADMIN_EXEC_TIMEOUT_MS, READY_EXEC_TIMEOUT_MS, READY_TIMEOUT_MS } from './timeouts.js'

/**
 * The three things the provisioner asks a running install, by `docker exec`
 * (plan `tenant-orchestrator`, Task 4, O7; plan `hosted-path-and-ops`, P5):
 *
 *  - "are you up?" — a fixed `node -e` probe script (`READY_PROBE_SCRIPT`
 *    below), polled until it says both `ui` and `serve` answer. This used to
 *    be `mcpcut status --json`, replaced after the live smoke on S2
 *    2026-09-27 found the provisioner never sees an install come up: `status`
 *    loads the whole CLI (config, zod, both SQLite databases) before it can
 *    answer, and under the tenant container's 0.25 CPU limit that load alone
 *    took longer than the per-exec timeout, let alone `READY_TIMEOUT_MS`
 *    across the poll (measured: ~7.3 s at idle for `status --json` in the
 *    container, vs. ~0.5 s for a bare `node -e 1`). The probe script asks
 *    nothing of the install's own code — a TCP connect to `serve`'s port and
 *    a `GET /login` to `ui`'s, same two questions `src/services/probe.ts`
 *    asks locally — so its own Node startup is the only cost, and that cost
 *    is what the smoke measured as fast. `ui` before its owner exists
 *    answers `/login` with a 303 to `/setup` (`UI_FIRST_RUN_LOCATION` in
 *    `src/services/constants.ts`); the probe accepts that redirect as ready,
 *    same as `probeUi` — the provisioner waits for readiness BEFORE it
 *    creates the owner, so a probe that refused it would never see a fresh
 *    install come up either.
 *  - "mint an owner token" — `admin add <name> --role owner --json` on the
 *    first create, `admin rotate <name> --recover --json` after. The one
 *    stdout line is the contract; it is parsed strictly and its token goes
 *    back to the caller only.
 *  - "when were you last used?" — `stat -c %Y` over the SQLite files of the
 *    data directory: the journal is written on every agent call and every
 *    admin action, the state on every change. GNU `stat` is in coreutils,
 *    which Debian marks Essential, so `node:24-bookworm-slim` carries it and
 *    the check costs no second Node process in a 256 MiB container. A file
 *    that does not exist (a `-wal` after a checkpoint) prints nothing on
 *    stdout, a complaint on stderr and makes `stat` exit 1: the lines that
 *    did come are read and the newest wins.
 *
 * No error here quotes stdout or stderr.
 */

export { ADMIN_EXEC_TIMEOUT_MS, READY_EXEC_TIMEOUT_MS, READY_TIMEOUT_MS } from './timeouts.js'
export const READY_POLL_MS = 1_000
/** The `stat` exec that answers "when was this last used" — unrelated to readiness, so its own budget. */
export const STAT_EXEC_TIMEOUT_MS = 10_000

const TENANT_HOME = '/home/node'
/** `mcpa_` + base64url of the CSPRNG bytes (`src/admin/constants.ts`). */
const OWNER_TOKEN_PATTERN = /^mcpa_[A-Za-z0-9_-]{16,256}$/

/** Env vars the probe script reads for the two ports it dials; unset in production (defaults 8091/8090 match the image). */
export const READY_PROBE_UI_PORT_ENV = 'MCPCUT_READY_UI_PORT'
export const READY_PROBE_SERVE_PORT_ENV = 'MCPCUT_READY_SERVE_PORT'

/**
 * A fixed script, no user data interpolated into it — only its own
 * `process.env` at run time, read INSIDE the container by the `node` it
 * runs under. It answers the two questions `src/services/probe.ts` asks
 * locally (`probeUi`, `probeServe`) with the same rules, restated rather than
 * imported so the provisioner does not reach into `src/`: `serve` is ready on
 * a bare TCP connect (it never leaves 401 for an unauthenticated request, so
 * there is no HTTP status to look for); `ui` is ready on a 2xx from
 * `GET /login`, or a 303 to `/setup` — the UI's own first-run state before an
 * owner exists. One JSON line on stdout, exit 0 always: the document decides
 * readiness, never the exit code.
 */
export const READY_PROBE_SCRIPT = `
const http = require('node:http');
const net = require('node:net');
const timeoutMs = 2000;
const uiPort = Number(process.env.${READY_PROBE_UI_PORT_ENV} || 8091);
const servePort = Number(process.env.${READY_PROBE_SERVE_PORT_ENV} || 8090);

function probeServe() {
  return new Promise(function (resolve) {
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port: servePort });
    const settle = function (answer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', function () { settle(true); });
    socket.once('error', function () { settle(false); });
    const timer = setTimeout(function () { settle(false); }, timeoutMs);
  });
}

function probeUi() {
  return new Promise(function (resolve) {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1',
      port: uiPort,
      path: '/login',
      method: 'GET',
      headers: { host: 'localhost:' + uiPort },
      agent: false,
    });
    const settle = function (answer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    req.once('response', function (res) {
      const status = res.statusCode || 0;
      res.resume();
      const firstRun = status === 303 && res.headers.location === '/setup';
      settle((status >= 200 && status < 300) || firstRun);
    });
    req.once('error', function () { settle(false); });
    req.end();
    const timer = setTimeout(function () { settle(false); }, timeoutMs);
  });
}

Promise.all([probeUi(), probeServe()]).then(function (results) {
  console.log(JSON.stringify({ ui: results[0], serve: results[1] }));
  process.exit(0);
});
`

/** The install's SQLite files, main and write-ahead log (`src/journal/db.ts`, `src/policy/store-backend.ts`). */
export const ACTIVITY_FILES: readonly string[] = Object.freeze(
  ['journal.db', 'journal.db-wal', 'state.db', 'state.db-wal'].map((file) => `${TENANT_HOME_MOUNT}/data/${file}`),
)
/** `stat` exits 0 when every file exists and 1 when some do not; anything else is not an answer. */
const STAT_EXIT_CODES: ReadonlySet<number> = new Set([0, 1])
/** Epoch seconds, as `%Y` prints them: digits only, no sign, no exponent (12 digits reach the year 33658). */
const EPOCH_SECONDS_PATTERN = /^\d{1,12}$/
const MS_PER_S = 1_000

const ReadyProbeAnswer = z.strictObject({ ui: z.boolean(), serve: z.boolean() })
const AdminAnswer = z.strictObject({
  admin: z.string(),
  role: z.literal('owner'),
  token: z.string().regex(OWNER_TOKEN_PATTERN),
})

export interface ReadinessOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly execTimeoutMs?: number
  /** Wall clock for the deadline. Defaults to `Date.now`. */
  readonly clock?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** True when `stdout` is the probe script's one JSON line naming both services up. */
export function isReadyProbe(stdout: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return false
  }
  const answer = ReadyProbeAnswer.safeParse(parsed)
  return answer.success && answer.data.ui && answer.data.serve
}

/** Polls the readiness probe until both services are up, or fails with `not-ready` at the deadline. */
export async function waitUntilReady(docker: DockerClient, container: string, options: ReadinessOptions = {}): Promise<void> {
  const clock = options.clock ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? READY_POLL_MS
  const deadline = clock() + timeoutMs
  for (;;) {
    const remaining = deadline - clock()
    const execTimeoutMs = Math.max(1, Math.min(options.execTimeoutMs ?? READY_EXEC_TIMEOUT_MS, remaining))
    if (await answersReady(docker, container, execTimeoutMs)) return
    if (clock() + pollMs >= deadline) {
      throw new ProvisionerError('not-ready', `the install did not come up within ${Math.round(timeoutMs / 1000)} s`)
    }
    await sleep(pollMs)
  }
}

async function answersReady(docker: DockerClient, container: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await docker.exec(container, ['node', '-e', READY_PROBE_SCRIPT], execOptions(timeoutMs))
    // The document decides, not the exit code: the probe script always exits 0.
    return !result.truncated.stdout && isReadyProbe(result.stdout)
  } catch {
    // Not up yet (the container is still starting, or restarting): the deadline decides.
    return false
  }
}

export type OwnerTokenMode = 'add' | 'rotate'

/** Runs `admin add|rotate --json` in the install and returns the new owner token. */
export async function mintOwnerToken(docker: DockerClient, container: string, adminName: string, mode: OwnerTokenMode): Promise<string> {
  const argv =
    mode === 'add'
      ? [...TENANT_CLI, 'admin', 'add', adminName, '--role', 'owner', '--json']
      : [...TENANT_CLI, 'admin', 'rotate', adminName, '--recover', '--json']
  const result = await docker.exec(container, argv, execOptions(ADMIN_EXEC_TIMEOUT_MS))
  const operation = `admin ${mode}`
  if (result.exitCode !== 0) throw new ProvisionerError('bad-output', `${operation} exited with code ${result.exitCode}`)
  if (result.truncated.stdout) throw new ProvisionerError('bad-output', `${operation} printed more than expected`)
  return ownerTokenFrom(result.stdout, adminName, operation)
}

/** The token from `admin add|rotate --json`'s one line; the line itself is never repeated. */
export function ownerTokenFrom(stdout: string, adminName: string, operation: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new ProvisionerError('bad-output', `${operation} did not print one JSON line`)
  }
  const answer = AdminAnswer.safeParse(parsed)
  if (!answer.success) throw new ProvisionerError('bad-output', `${operation} printed an unexpected shape`)
  if (answer.data.admin !== adminName) throw new ProvisionerError('bad-output', `${operation} named another admin`)
  return answer.data.token
}

/** When the install last wrote its journal or state, as ISO-8601; `null` when none of the files exists. */
export async function readLastActivity(docker: DockerClient, container: string): Promise<string | null> {
  const result = await docker.exec(container, ['stat', '-c', '%Y', ...ACTIVITY_FILES], execOptions(STAT_EXEC_TIMEOUT_MS))
  if (!STAT_EXIT_CODES.has(result.exitCode)) throw new ProvisionerError('bad-output', `stat exited with code ${result.exitCode}`)
  if (result.truncated.stdout) throw new ProvisionerError('bad-output', 'stat printed more than expected')
  return lastActivityFrom(result.stdout)
}

/** The newest of `stat -c %Y`'s lines as ISO-8601, `null` for none; a line that is not epoch seconds is a failure. */
export function lastActivityFrom(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.some((line) => !EPOCH_SECONDS_PATTERN.test(line))) {
    throw new ProvisionerError('bad-output', 'stat printed something other than epoch seconds')
  }
  if (lines.length === 0) return null
  const newest = Math.max(...lines.map(Number))
  return new Date(newest * MS_PER_S).toISOString()
}

function execOptions(timeoutMs: number): { user: string; env: Record<string, string>; timeoutMs: number } {
  return { user: TENANT_USER, env: { HOME: TENANT_HOME }, timeoutMs }
}
