import {
  EXTERNAL_SUPERVISOR,
  LOST_RACE_NOT_UP_REASON,
  PID_RECORD_VERSION,
  PROBE_POLL_MS,
  SPAWN_FAILURE_GRACE_MS,
  WINDOWS_UNSUPPORTED_REASON,
  type ServiceName,
} from './constants.js'
import { readLogTail } from './log-tail.js'
import { sleep, terminateProcess } from './manager-signal.js'
import { openDaemonLog, prepareRunDir, spawnDaemon, type ChildExit, type DaemonHandle } from './manager-spawn.js'
import { statusOfService } from './manager-status.js'
import { bindOf, type ManagerContext, type ServiceStatus, type StartResult } from './manager-types.js'
import { logFilePathFor, pidFilePathFor } from './paths.js'
import { createPidFileExclusive, isProcessAlive, removePidFile, type PidRecord } from './pid-file.js'

/**
 * `mcpcut start <service>` (mcpcut phase 1, Task 11; owner decision
 * C2-revised): leave a service behind that outlives the terminal. The detach
 * itself lives in `manager-spawn.ts`; this file decides what to spawn, what
 * to refuse, and what to do about a child that never came up.
 *
 * The pid file can only be written after the spawn (the pid comes from it),
 * so a second `start` racing this one is caught by the exclusive create
 * instead of by a check: the loser terminates the child it just spawned and
 * reports the winner.
 *
 * Every path that abandons a child AWAITS its termination (review TS-H1). A
 * CLI has nothing after the promise it returns: an escalation scheduled on an
 * unref'd timer is a SIGKILL that never arrives, and the daemon it was meant
 * for then holds the port with its pid file already deleted.
 */
export async function startService(ctx: ManagerContext, service: ServiceName): Promise<StartResult> {
  const refusal = await refuseStart(ctx, service)
  if (refusal !== undefined) return refusal

  const logPath = logFilePathFor(ctx.dataDir, service)
  const prepared = await prepareRunDir(ctx.dataDir)
  if (prepared !== undefined) return { kind: 'failed', reason: prepared.reason, logTail: [] }

  const log = openDaemonLog(logPath)
  if (log.kind === 'failed') return { kind: 'failed', reason: log.reason, logTail: [] }

  const daemon = spawnDaemon(ctx, service, log.fd)
  if (daemon.pid === undefined) return await spawnFailure(daemon, logPath)

  return await claimAndAwait(ctx, service, daemon, daemon.pid, logPath)
}

/**
 * Writes the pid file and waits for the service, cleaning up after itself on
 * every exit — including a throw.
 *
 * The window between `spawnDaemon` and a written pid file is the dangerous
 * one (review TS-H2): the child is running and NOTHING on disk names it, so
 * an `EACCES` or `ENOSPC` from the create would otherwise leave a daemon
 * holding the port that no later `stop` could ever reach.
 */
async function claimAndAwait(
  ctx: ManagerContext,
  service: ServiceName,
  daemon: DaemonHandle,
  pid: number,
  logPath: string,
): Promise<StartResult> {
  const pidPath = pidFilePathFor(ctx.dataDir, service)
  const record = pidRecordOf(ctx, service, pid)

  let claim: 'created' | 'exists'
  try {
    claim = await createPidFileExclusive(pidPath, record)
  } catch (error: unknown) {
    await abandonChild(ctx, pid, pidPath)
    throw error
  }
  if (claim === 'exists') return await backOutOfLostRace(ctx, service, pid, logPath)

  try {
    return await awaitReadiness(ctx, daemon, record, logPath, pidPath)
  } catch (error: unknown) {
    await abandonChild(ctx, pid, pidPath)
    throw error
  }
}

/** Terminates the child we spawned, then drops the file naming it — in that order. */
async function abandonChild(ctx: ManagerContext, pid: number, pidPath: string): Promise<void> {
  await terminateProcess(pid, { escalationMs: ctx.killEscalationMs })
  await removePidFile(pidPath)
}

/**
 * Someone else won the pid file. Our child is a second copy nobody asked for,
 * so it goes — and only THEN do we ask what the winner actually is: reporting
 * `already-running` for a winner whose pid is dead would tell an operator the
 * service is up while nothing answers (review TS-M2).
 */
async function backOutOfLostRace(
  ctx: ManagerContext,
  service: ServiceName,
  pid: number,
  logPath: string,
): Promise<StartResult> {
  await terminateProcess(pid, { escalationMs: ctx.killEscalationMs })
  const status = await statusOfService(ctx, service)
  if (status.state === 'running' || status.state === 'starting') {
    return { kind: 'already-running', status }
  }
  return { kind: 'failed', reason: LOST_RACE_NOT_UP_REASON, logTail: await readLogTail(logPath) }
}

/** The states in which `start` must not spawn anything, and what it says instead. */
async function refuseStart(ctx: ManagerContext, service: ServiceName): Promise<StartResult | undefined> {
  if (ctx.platform === 'win32') {
    return { kind: 'unsupported', reason: WINDOWS_UNSUPPORTED_REASON }
  }
  const status = await statusOfService(ctx, service)
  if (ctx.config.supervisor === EXTERNAL_SUPERVISOR || status.state === 'external') {
    return { kind: 'external', status }
  }
  if (status.state === 'running' || status.state === 'starting') {
    return { kind: 'already-running', status }
  }
  if (status.state === 'stale') {
    return await refuseOrClearStale(ctx, service, status)
  }
  return undefined
}

/**
 * `stale` has three causes, and only two of them are leftovers.
 *
 * When the pid is ALIVE the status already says "not signalling it — stop it
 * by hand": clearing that file and spawning a second copy would contradict
 * the manager's own advice, put two services on one port and orphan the first
 * (review TS-H4). A dead pid or an unreadable file is genuinely leftovers,
 * and clearing it is what makes the exclusive create below meaningful.
 */
async function refuseOrClearStale(
  ctx: ManagerContext,
  service: ServiceName,
  status: ServiceStatus,
): Promise<StartResult | undefined> {
  if (status.pid !== undefined && isProcessAlive(status.pid)) {
    return {
      kind: 'failed',
      reason: status.detail ?? `pid ${status.pid} is alive but not answering`,
      logTail: await readLogTail(logFilePathFor(ctx.dataDir, service)),
    }
  }
  await removePidFile(pidFilePathFor(ctx.dataDir, service))
  return undefined
}

/**
 * A spawn that produced no pid. `spawn` reports the reason asynchronously on
 * the child's `'error'` event, so the failure is worth the short wait: without
 * it the operator gets "it did not start" and no errno, since a process that
 * never ran left nothing in its log either.
 */
async function spawnFailure(daemon: DaemonHandle, logPath: string): Promise<StartResult> {
  const exit = await settledWithin(daemon.settled, SPAWN_FAILURE_GRACE_MS)
  return {
    kind: 'failed',
    reason: exit === undefined ? 'the service process was not spawned' : describeExit(exit),
    logTail: await readLogTail(logPath),
  }
}

/**
 * `promise`, or `undefined` if it has not settled within `ms`.
 *
 * The timer is REF'D (review TS-M3): it is bounded by
 * `SPAWN_FAILURE_GRACE_MS`, and at this point it is the only pending work
 * left — an unref'd one would let the CLI exit 0 without ever printing the
 * failure it was waiting to describe. It is cleared as soon as the promise
 * wins, so a fast answer costs nothing.
 */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function pidRecordOf(ctx: ManagerContext, service: ServiceName, pid: number): PidRecord {
  const bind = bindOf(ctx.config, service)
  return {
    version: PID_RECORD_VERSION,
    service,
    pid,
    host: bind.host,
    port: bind.port,
    startedAt: ctx.now().toISOString(),
  }
}

/**
 * Waits for the service to answer, and reports the two ways that can fail.
 *
 * The deadline is measured with real time, not `ctx.now()`: the injected
 * clock exists to stamp and judge records, and a frozen one must not be able
 * to turn this into an endless loop.
 */
async function awaitReadiness(
  ctx: ManagerContext,
  daemon: DaemonHandle,
  record: PidRecord,
  logPath: string,
  pidPath: string,
): Promise<StartResult> {
  const deadline = Date.now() + ctx.readyTimeoutMs
  for (;;) {
    if (await ctx.probe(record.service, record.host, record.port)) {
      return { kind: 'started', status: runningStatus(record, logPath) }
    }
    const exit = daemon.exit()
    if (exit !== undefined) {
      await removePidFile(pidPath)
      return { kind: 'failed', reason: describeExit(exit), logTail: await readLogTail(logPath) }
    }
    if (Date.now() >= deadline) {
      // Alive but silent: nothing an operator can use, and leaving it running
      // would hold the port against the next start. Awaited, then the file.
      await abandonChild(ctx, record.pid, pidPath)
      return {
        kind: 'failed',
        reason: `did not answer within ${ctx.readyTimeoutMs} ms`,
        logTail: await readLogTail(logPath),
      }
    }
    await sleep(PROBE_POLL_MS)
  }
}

function runningStatus(record: PidRecord, logPath: string): ServiceStatus {
  return {
    service: record.service,
    state: 'running',
    host: record.host,
    port: record.port,
    pid: record.pid,
    startedAt: record.startedAt,
    logPath,
  }
}

function describeExit(exit: ChildExit): string {
  if (exit.error !== undefined) return `could not be spawned: ${exit.error.message}`
  if (exit.signal !== null) return `was killed by ${exit.signal}`
  if (exit.code !== null) return `exited with code ${exit.code}`
  return 'exited'
}
