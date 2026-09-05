import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { AGENT_TOKEN_ENV_VAR } from '../cli/connect-constants.js'
import type { Supervisor } from '../setup/constants.js'

/**
 * Constants of the `mcpcut` service manager (install-config phase 1, owner
 * decision C2-revised: `ui` and `serve` run as detached daemons that survive
 * the terminal that started them).
 *
 * Per-area constants rule (`src/cli/serve-constants.ts`, `src/probe/constants.ts`
 * precedent): these belong to the manager and not to `src/config.ts`, which
 * only holds what the journal and the whole plane share.
 */

/**
 * The services the manager knows how to run. A closed list on purpose: every
 * one of them needs a readiness probe of its own (`src/services/probe.ts`),
 * so a third service is a code change and not a configuration value.
 */
export const SERVICE_NAMES = ['ui', 'serve'] as const

/** One managed service, narrowed from the closed list above. */
export type ServiceName = (typeof SERVICE_NAMES)[number]

/** Directory under the data dir holding pid files and daemon logs. */
export const RUN_DIR_NAME = 'run'

/** Suffix of a service's pid file inside `run/`. */
export const PID_FILE_SUFFIX = '.pid'

/** Suffix of a service's daemon log inside `run/`. */
export const LOG_FILE_SUFFIX = '.log'

/**
 * How long `start` waits for a freshly spawned service to answer its probe
 * before calling the start failed. Generous: the first start of an install
 * opens (and possibly migrates) two SQLite databases before it listens.
 */
export const START_READY_TIMEOUT_MS = 15_000

/**
 * Deadline for one readiness/liveness probe. Short: the probe only asks "is
 * something answering on this port", and a slow answer during a poll loop is
 * indistinguishable from no answer for the manager's purposes.
 */
export const PROBE_TIMEOUT_MS = 2_000

/** Gap between readiness probes while `start` waits for a service to come up. */
export const PROBE_POLL_MS = 100

/** Gap between liveness checks while `stop` waits for a signalled process to die. */
export const STOP_POLL_MS = 50

/** Lines `mcpcut logs` prints when `--lines` is not given. */
export const LOG_TAIL_DEFAULT_LINES = 50

/**
 * Bytes read from the end of a log to satisfy a tail. Bounds the work of a
 * tail against a log nobody rotates (rotation is a later phase): a 2 GiB
 * `ui.log` must still cost one 64 KiB read.
 */
export const LOG_TAIL_MAX_BYTES = 64 * 1024

/** Schema version of the pid record written into `run/<service>.pid`. */
export const PID_RECORD_VERSION = 1

/**
 * Wildcard bind addresses and the loopback address a probe must use instead.
 *
 * A service bound to `0.0.0.0` or `::` is reachable on every interface, but
 * the wildcard itself is not a destination: `connect('0.0.0.0')` is not a
 * portable way to reach it. A concrete address is deliberately absent from
 * this map — a service bound to `10.0.0.5` does NOT listen on loopback, so
 * the probe has to dial the very address the service was given.
 *
 * A `Map` rather than an object literal: a plain record would answer lookups
 * for inherited keys like `constructor`, and a host string comes from a
 * config file.
 */
export const WILDCARD_PROBE_HOSTS: ReadonlyMap<string, string> = new Map([
  ['0.0.0.0', '127.0.0.1'],
  ['::', '::1'],
  ['::0', '::1'],
])

/** Path the `ui` readiness probe asks for — the login screen, same as the compose healthcheck. */
export const UI_PROBE_PATH = '/login'

/**
 * The supervisor value that hands `ui` and `serve` to something else —
 * compose, systemd, a platform runner (owner decision C7). The manager then
 * only ever reports; it never spawns and never signals.
 */
export const EXTERNAL_SUPERVISOR: Supervisor = 'external'

/**
 * Why `start` and `stop` refuse on Windows. Detaching here rests on POSIX
 * semantics all the way down — `setsid`, `kill(pid, 0)` for liveness, SIGTERM
 * then SIGKILL — and a half-working Windows path would be worse than an
 * honest refusal: the manager would report processes it cannot actually stop.
 */
export const WINDOWS_UNSUPPORTED_REASON =
  'mcpcut cannot run detached services on Windows: run `mcpcut ui` and `mcpcut serve` in the foreground, or use a Windows service'

/**
 * How long a stop waits for a process to disappear after SIGKILL before it
 * stops watching. SIGKILL cannot be caught, so anything still alive here is
 * in a state no signal reaches (uninterruptible I/O, or a zombie waiting to
 * be reaped) and waiting longer buys nothing.
 */
export const FORCED_STOP_SETTLE_MS = 2_000

/** Flags the manager passes to a service, spelled exactly as `ui`/`serve` parse them. */
export const FLAG_HOST = '--host'
export const FLAG_PORT = '--port'
export const FLAG_BEHIND_TLS = '--behind-tls'
export const FLAG_ALLOWED_HOST = '--allowed-host'
export const FLAG_ALLOWED_ORIGIN = '--allowed-origin'
export const FLAG_TRUSTED_PROXY_HEADER = '--trusted-proxy-header'
export const FLAG_POLICY = '--policy'
export const FLAG_FAIL_CLOSED = '--fail-closed'

/**
 * How long `start` waits for a child's `'error'` event when the spawn produced
 * no pid. The reason (an `ENOENT` on the node binary, an `EACCES` on the CLI)
 * arrives a tick later and is the ONLY diagnosis available — a process that
 * never started wrote nothing to its log.
 */
export const SPAWN_FAILURE_GRACE_MS = 1_000

/**
 * Credentials a daemon must never inherit.
 *
 * `MCP_ADMIN_TOKEN` attributes an ACTION to a human (ADR-0004) and
 * `MCP_AGENT_TOKEN` authenticates one agent to the plane — neither describes
 * a long-lived background process, and a token in one's environment is
 * readable for as long as it runs. The names are IMPORTED rather than
 * restated: a rename that missed a copy here would silently start leaking the
 * renamed one.
 */
export const DAEMON_ENV_STRIPPED_VARS: readonly string[] = [ADMIN_TOKEN_ENV_VAR, AGENT_TOKEN_ENV_VAR]

/**
 * Every group- and other- bit: the mask that answers "is this owner-only".
 *
 * It guards `run/` and the pid files inside it. Whoever can WRITE a pid file
 * chooses which pid a later `stop` signals, which is the sharp end; read
 * access is refused with it because the same directory holds the daemon logs,
 * and because "owner-only" is a rule an operator can check with one `ls`,
 * where "owner-writable, group-readable" is one they cannot.
 */
export const SHARED_ACCESS_MASK = 0o077

/** What `status` says about a pid file whose permissions make it untrustworthy. */
export const UNTRUSTED_PID_FILE_DETAIL =
  'pid file is not owner-only (mode/owner) — refusing to trust it'

/**
 * What `start` says when it lost the pid-file race to a winner that is not
 * actually up. Reporting `already-running` there would tell an operator the
 * service is serving when nothing answers on its port.
 */
export const LOST_RACE_NOT_UP_REASON = 'another start won the pid file but the service is not up'
