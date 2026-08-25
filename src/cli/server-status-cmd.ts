import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { roleSatisfies, type Role } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import { INVENTORY_FILE_NAME, listAllQuarantined, type QuarantinedEntry } from '../policy/inventory.js'
import { PROBE_TIMEOUT_MS, STATUS_STALE_AFTER_MS } from '../probe/constants.js'
import { UnknownServerError, type RunProbeFn } from '../probe/orchestrator.js'
import type { ProbeInitiator, ServerStatus } from '../probe/status-schema.js'
import { createRegistryStore } from '../registry/store.js'
import { createVaultStore } from '../vault/store.js'
import { adminFromEnv } from './admin-token.js'
import { composeProbeChain, type ProbeChain } from './probe-wiring.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'
import { statusCellOf, statusLineOf } from './server-status-format.js'

/**
 * The probe side of the `server` commands (M5.5 п.1, Task 8; ADR-0008):
 * `server refresh` itself, plus the helpers `server-cmd.ts` calls so that
 * `list` probes stale servers concurrently under the shared deadline, `show`
 * probes one stale server synchronously, and `add` auto-probes right after
 * registration. Split out of `server-cmd.ts` for the file-size budget; the
 * chain itself is the shared `composeProbeChain` (`probe-wiring.ts`) — the
 * same composition the admin UI runs.
 *
 * Attribution: `MCP_ADMIN_TOKEN` → named admin (`admin-token.ts`, shared with
 * `policy set`). For the lazy/registration triggers the token is OPTIONAL — it buys a name
 * in the probe record, it gates nothing (list/show/add keep working without
 * it). `refresh` REQUIRES it with role ≥ operator: the same threshold
 * `src/ui/authz.ts` puts on `POST /servers/refresh`, so the CLI cannot be
 * used to step around the UI's role table (ADR-0004 lesson).
 */

/** Probe seams of the `server` commands; production uses the defaults. */
export interface ServerProbeOptions {
  /** Engine seam; defaults to the real probe engine bound to the vault. */
  readonly runProbe?: RunProbeFn
  /** Staleness horizon override. Defaults to `STATUS_STALE_AFTER_MS`. */
  readonly staleAfterMs?: number
  /** Shared wall-clock deadline `server list` waits for its stale-server probes. */
  readonly listDeadlineMs?: number
  /** Clock in epoch ms. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** Minimum role to force a probe — mirrors the `POST /servers/refresh` row in `src/ui/authz.ts`. */
export const SERVER_REFRESH_MIN_ROLE: Role = 'operator'

/**
 * Slack added to the probe timeout for `server list`'s shared deadline: the
 * command PRINTS its table after about ONE probe timeout for however many
 * stale servers there are (cap-limited, ADR-0008), never N× — servers still
 * probing when the deadline fires print their stored (stale/probing) state
 * instead.
 *
 * The guarantee is scoped to the printed output, not process exit: probes
 * still in flight past the deadline are not cancelled (their results land in
 * the status store and journal), so with more stale servers than the cap the
 * OS process can outlive the table by further probe timeouts. Repeated
 * invocations (cron) are bounded cross-process by the `probing` CAS marker
 * (`PROBING_MARKER_FRESH_FOR_MS`): a server already being probed is not
 * probed again until the marker expires. Cancellation of abandoned probes —
 * backlog (ROADMAP, M5.5 п.1 ревью).
 */
const LIST_DEADLINE_SLACK_MS = 500

const REFRESH_USAGE = `Usage:
  server refresh <name>   Force a probe of one server, re-shooting tools/list
                          (personal admin token via ${ADMIN_TOKEN_ENV_VAR}, role ${SERVER_REFRESH_MIN_ROLE}+)
`

const REFRESH_MISSING_TOKEN_MESSAGE =
  `Refusing to refresh: no admin token. Set ${ADMIN_TOKEN_ENV_VAR} to your personal admin token ` +
  `(role "${SERVER_REFRESH_MIN_ROLE}" or higher) so the probe records which admin forced it.\n` +
  `Get one with: mcp-journal admin add <name> --role ${SERVER_REFRESH_MIN_ROLE}   (existing admin: mcp-journal admin rotate <name>)\n`

const REFRESH_UNKNOWN_TOKEN_MESSAGE =
  `Refusing to refresh: ${ADMIN_TOKEN_ENV_VAR} does not match any active admin — it may have been ` +
  `rotated, or the admin removed.\n` +
  `Check "mcp-journal admin list", then: mcp-journal admin rotate <name>\n`

const REFRESH_INSUFFICIENT_ROLE_MESSAGE =
  `Refusing to refresh: this admin token's role may not force a probe ` +
  `(role "${SERVER_REFRESH_MIN_ROLE}" or higher is required, the same rule the admin UI applies ` +
  `to POST /servers/refresh).\n` +
  `An owner can change it with: mcp-journal admin role <name> ${SERVER_REFRESH_MIN_ROLE}\n`

function refreshStoreUnreadableMessage(detail: string): string {
  return (
    `Refusing to refresh: the admin store could not be read, so the probe could not be ` +
    `attributed to a human.\n${formatReadableField(detail)}\n` +
    `Check the file named above, then: mcp-journal admin list\n`
  )
}

const DEFAULT_IO: ServerCliIo = { stdout: process.stdout, stderr: process.stderr }

function journalDirOf(opts: ServerCliOptions): string {
  return opts.journalDir ?? JOURNAL_DIR
}

function nowOf(opts: ServerCliOptions): number {
  return (opts.probes?.now ?? Date.now)()
}

function staleAfterMsOf(opts: ServerCliOptions): number {
  return opts.probes?.staleAfterMs ?? STATUS_STALE_AFTER_MS
}

/** Builds the standard probe chain for one command invocation. */
function composeServerProbes(io: ServerCliIo, opts: ServerCliOptions): ProbeChain {
  const journalDir = journalDirOf(opts)
  const probes = opts.probes ?? {}
  const warn = (line: string): void => {
    io.stderr.write(`${line}\n`)
  }
  return composeProbeChain({
    journalDir,
    inventoryStorePath: join(journalDir, INVENTORY_FILE_NAME),
    registry: createRegistryStore(journalDir),
    // Built lazily: the vault is only touched when a probe dereferences a `vault:` value.
    readSecretValues: (names) => createVaultStore({ journalDir, warn }).readSecretValues(names),
    onDiagnostic: (line) => io.stderr.write(line),
    onError: (error) =>
      io.stderr.write(`[probe] ${error instanceof Error ? error.message : String(error)}\n`),
    ...(probes.runProbe !== undefined ? { runProbe: probes.runProbe } : {}),
    ...(probes.staleAfterMs !== undefined ? { staleAfterMs: probes.staleAfterMs } : {}),
    ...(probes.now !== undefined ? { now: probes.now } : {}),
  })
}

/** The lazy/registration initiator: attributed when a valid token is around, silent otherwise. */
async function initiatorOf(
  opts: ServerCliOptions,
  trigger: ProbeInitiator['trigger'],
): Promise<ProbeInitiator> {
  const resolved = await adminFromEnv(opts)
  return {
    trigger,
    ...(resolved.kind === 'ok' ? { adminName: resolved.name } : {}),
  }
}

/** The refresh admin: fail-closed with an operator-facing hint on every refusal. */
async function resolveRefreshAdmin(io: ServerCliIo, opts: ServerCliOptions): Promise<string | undefined> {
  const resolved = await adminFromEnv(opts)
  if (resolved.kind === 'missing') {
    io.stderr.write(REFRESH_MISSING_TOKEN_MESSAGE)
    return undefined
  }
  if (resolved.kind === 'unknown') {
    io.stderr.write(REFRESH_UNKNOWN_TOKEN_MESSAGE)
    return undefined
  }
  if (resolved.kind === 'unreadable') {
    io.stderr.write(refreshStoreUnreadableMessage(resolved.detail))
    return undefined
  }
  if (!roleSatisfies(resolved.role, SERVER_REFRESH_MIN_ROLE)) {
    io.stderr.write(REFRESH_INSUFFICIENT_ROLE_MESSAGE)
    return undefined
  }
  return resolved.name
}

/** Awaits `work` or the shared deadline, whichever settles first; the timer never holds the loop. */
async function raceListDeadline(work: Promise<void>, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs)
    timer.unref()
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `server list` support: ensures every stale server is being probed
 * (concurrently, cap-limited), waits at most the shared deadline, then
 * returns one STATUS cell per name in the given order.
 */
export async function probeListStatusCells(
  names: readonly string[],
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<readonly string[]> {
  const chain = composeServerProbes(io, opts)
  const deadlineMs = opts.probes?.listDeadlineMs ?? PROBE_TIMEOUT_MS + LIST_DEADLINE_SLACK_MS
  await raceListDeadline(chain.orchestrator.ensureFresh(names, await initiatorOf(opts, 'lazy')), deadlineMs)
  const stored = await chain.statusStore.listStatuses()
  const nowMs = nowOf(opts)
  const staleAfterMs = staleAfterMsOf(opts)
  return Promise.all(
    names.map(async (name) =>
      statusCellOf(
        Object.hasOwn(stored, name) ? stored[name] : undefined,
        await chain.activity.lastSuccessfulActivity(name),
        nowMs,
        staleAfterMs,
      ),
    ),
  )
}

/** `server show` support: probes a stale server synchronously, then prints one status line. */
export async function printProbedStatus(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  const chain = composeServerProbes(io, opts)
  await chain.orchestrator.ensureFresh([name], await initiatorOf(opts, 'lazy'))
  const status = await chain.statusStore.getStatus(name)
  const activity = await chain.activity.lastSuccessfulActivity(name)
  io.stdout.write(`status: ${statusLineOf(status, activity, nowOf(opts), staleAfterMsOf(opts))}\n`)
}

/**
 * `server add` support (O8): one forced probe right after the registry write,
 * with registration attribution. A probe that cannot even start is reported,
 * never fatal — the server IS registered either way.
 */
export async function printRegistrationProbe(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  const chain = composeServerProbes(io, opts)
  try {
    const status = await chain.orchestrator.probeNow(name, await initiatorOf(opts, 'registration'))
    io.stdout.write(`probe: ${statusLineOf(status, null, nowOf(opts), staleAfterMsOf(opts))}\n`)
  } catch (error: unknown) {
    io.stderr.write(
      `probe failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/** Quarantine snapshot keys for one server: name@hash, so a CHANGED entry counts as new too. */
async function quarantineKeysOf(storePath: string, serverName: string): Promise<ReadonlySet<string>> {
  const entries = await listAllQuarantined(storePath)
  return new Set(
    entries
      .filter((entry) => entry.serverName === serverName)
      .map((entry) => `${entry.toolName}@${entry.shortHash}`),
  )
}

async function newlyQuarantined(
  storePath: string,
  serverName: string,
  before: ReadonlySet<string>,
): Promise<readonly QuarantinedEntry[]> {
  const entries = await listAllQuarantined(storePath)
  return entries.filter(
    (entry) =>
      entry.serverName === serverName && !before.has(`${entry.toolName}@${entry.shortHash}`),
  )
}

/**
 * `server refresh <name>`: forced probe with `tools/list`, operator+ only.
 * Prints the outcome and every quarantine entry the probe produced.
 * Exit 0 when the server is alive, 1 otherwise.
 */
export async function runServerRefresh(
  args: string[],
  io: ServerCliIo = DEFAULT_IO,
  opts: ServerCliOptions = {},
): Promise<number> {
  const name = parseRefreshName(args)
  if (name === undefined) {
    io.stderr.write(REFRESH_USAGE)
    return 1
  }
  const adminName = await resolveRefreshAdmin(io, opts)
  if (adminName === undefined) {
    return 1
  }

  const storePath = join(journalDirOf(opts), INVENTORY_FILE_NAME)
  const before = await quarantineKeysOf(storePath, name)
  const chain = composeServerProbes(io, opts)
  let status: ServerStatus
  try {
    status = await chain.orchestrator.probeNow(name, { trigger: 'refresh', adminName })
  } catch (error: unknown) {
    if (error instanceof UnknownServerError) {
      io.stderr.write(`unknown server "${formatReadableField(name)}"\n`)
      return 1
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  io.stdout.write(
    `refresh "${formatReadableField(name)}": ${statusLineOf(status, null, nowOf(opts), staleAfterMsOf(opts))}\n`,
  )
  for (const entry of await newlyQuarantined(storePath, name, before)) {
    io.stdout.write(`quarantined: ${formatReadableField(entry.toolName)} (${entry.state})\n`)
  }
  return status.status === 'alive' ? 0 : 1
}

/** The single `<name>` positional of `server refresh`; `undefined` on any shape error. */
function parseRefreshName(args: string[]): string | undefined {
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true })
    return parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  } catch {
    return undefined
  }
}
