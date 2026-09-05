import { type ServiceName } from './constants.js'
import { bindOf, type ManagerContext, type ServiceStatus } from './manager-types.js'
import { logFilePathFor, pidFilePathFor } from './paths.js'
import { isProcessAlive, readPidFile, type PidRecord } from './pid-file.js'

/**
 * "Is this service running?" — the one question the whole manager rests on
 * (mcpcut phase 1, Task 11).
 *
 * THE PID-REUSE RULE (ADR-0012, and the mitigation the plan's risk table
 * names): a live pid is NOT proof that the service is ours. Pids are reused,
 * and a data directory outlives reboots, so a pid file written last week can
 * name a process that is now someone's editor. A service therefore counts as
 * `running` only when the pid is alive AND something answers on the port it
 * was started on. The three remaining combinations are:
 *
 *   - alive, silent, and the record is younger than the readiness window ->
 *     `starting`. A service that is still opening (and possibly migrating)
 *     its databases is exactly this, and calling it stale would have `start`
 *     spawn a second copy on the same port. The window has BOTH ends (review
 *     SEC-H2a): a record stamped in the future — a clock stepped back, a VM
 *     restored from a snapshot — is not a young service, and a one-sided
 *     comparison would read every live pid as `starting` forever and let
 *     `stop` signal it.
 *   - alive, silent, and older than that -> `stale`, with a detail saying so.
 *     This is the case a `stop` must NOT signal: the evidence that the pid is
 *     ours has expired, and killing the wrong pid is unrecoverable where
 *     leaving a stale file is merely untidy.
 *   - not alive -> `stale`. Nothing to signal; the file is leftovers.
 *
 * A pid file we cannot read is `stale` too: an operator can clear it, and no
 * other branch could act on a record that does not parse.
 */
export async function statusOfService(ctx: ManagerContext, service: ServiceName): Promise<ServiceStatus> {
  const bind = bindOf(ctx.config, service)
  const logPath = logFilePathFor(ctx.dataDir, service)
  const read = await readPidFile(pidFilePathFor(ctx.dataDir, service))

  if (read.kind === 'corrupt') {
    return {
      service,
      state: 'stale',
      host: bind.host,
      port: bind.port,
      logPath,
      detail: `pid file is unusable: ${read.detail}`,
    }
  }
  if (read.kind === 'absent') {
    // Nothing of ours, but the port may still be busy: compose, systemd or an
    // operator's own shell. Reporting that as `stopped` would invite a start
    // that could only fail on EADDRINUSE.
    const answering = await ctx.probe(service, bind.host, bind.port)
    return {
      service,
      state: answering ? 'external' : 'stopped',
      host: bind.host,
      port: bind.port,
      logPath,
      ...(answering ? { detail: externalDetail(bind.host, bind.port) } : {}),
    }
  }
  return await recordedStatus(ctx, read.record, logPath)
}

/** The status of a service that has a readable pid file — where the rule above lives. */
async function recordedStatus(
  ctx: ManagerContext,
  record: PidRecord,
  logPath: string,
): Promise<ServiceStatus> {
  // The record's own host and port, not the config's: the process was started
  // with these, and an edited config must not send the probe elsewhere.
  const base = {
    service: record.service,
    host: record.host,
    port: record.port,
    pid: record.pid,
    startedAt: record.startedAt,
    logPath,
  } as const

  if (!isProcessAlive(record.pid)) {
    return { ...base, state: 'stale', detail: `pid ${record.pid} is not running: the pid file is leftovers` }
  }
  if (await ctx.probe(record.service, record.host, record.port)) {
    return { ...base, state: 'running' }
  }
  const age = ageOfRecord(ctx, record.startedAt)
  if (age !== undefined && age < 0) {
    return { ...base, state: 'stale', detail: futureStampDetail(record) }
  }
  if (age !== undefined && age < ctx.readyTimeoutMs) {
    return { ...base, state: 'starting' }
  }
  return { ...base, state: 'stale', detail: pidReuseDetail(record) }
}

/**
 * How long ago the record was stamped, or `undefined` when the stamp does not
 * parse — which falls through to `stale`, the conservative side of the rule.
 */
function ageOfRecord(ctx: ManagerContext, startedAt: string): number | undefined {
  const stamped = Date.parse(startedAt)
  return Number.isNaN(stamped) ? undefined : ctx.now().getTime() - stamped
}

/** The refusal an operator reads when a record claims to have started later than now. */
function futureStampDetail(record: PidRecord): string {
  return (
    `pid ${record.pid} is alive but its record is stamped in the future (${record.startedAt}); ` +
    'the clock moved back — not trusting the readiness window, and not signalling it'
  )
}

/** The refusal an operator reads when the evidence that a pid is ours has run out. */
function pidReuseDetail(record: PidRecord): string {
  return (
    `pid ${record.pid} is alive but not answering on ${record.host}:${record.port}; ` +
    'not signalling it (the pid may belong to another process) — stop it by hand if it is ours'
  )
}

function externalDetail(host: string, port: number): string {
  return `something answers on ${host}:${port} but mcpcut has no pid file for it`
}
