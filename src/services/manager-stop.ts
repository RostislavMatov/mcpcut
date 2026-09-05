import { EXTERNAL_SUPERVISOR, WINDOWS_UNSUPPORTED_REASON, type ServiceName } from './constants.js'
import { terminateProcess } from './manager-signal.js'
import { statusOfService } from './manager-status.js'
import { type ManagerContext, type ServiceStatus, type StopResult } from './manager-types.js'
import { pidFilePathFor } from './paths.js'
import { removePidFile } from './pid-file.js'

/**
 * `mcpcut stop <service>` (mcpcut phase 1, Task 11).
 *
 * What it will and will not signal follows the pid-reuse rule in
 * `manager-status.ts`: only a `running` or `starting` service — a live pid
 * that answers, or one still inside its readiness window — is signalled.
 * Every `stale` state is cleared rather than killed, because there the
 * evidence that the pid is ours has run out, and killing the wrong process is
 * the one mistake here that cannot be undone.
 */
export async function stopService(ctx: ManagerContext, service: ServiceName): Promise<StopResult> {
  if (ctx.platform === 'win32') {
    return { kind: 'unsupported', reason: WINDOWS_UNSUPPORTED_REASON }
  }
  if (ctx.config.supervisor === EXTERNAL_SUPERVISOR) {
    return { kind: 'external' }
  }

  const status = await statusOfService(ctx, service)
  const pidPath = pidFilePathFor(ctx.dataDir, service)

  if (status.state === 'external') {
    return { kind: 'external' }
  }
  if (status.state === 'stale') {
    await removePidFile(pidPath)
    return clearedResult(status)
  }
  if (status.pid === undefined) {
    // `stopped`: no pid file, nothing answering.
    return { kind: 'not-running' }
  }
  return await terminate(ctx, pidPath, status.pid)
}

/** A cleared pid file, carrying whatever the status knew about it. */
function clearedResult(status: ServiceStatus): StopResult {
  return {
    kind: 'stale-cleared',
    ...(status.pid !== undefined ? { pid: status.pid } : {}),
    ...(status.detail !== undefined ? { detail: status.detail } : {}),
  }
}

/** SIGTERM, wait, SIGKILL — then clear the pid file whichever way it went. */
async function terminate(ctx: ManagerContext, pidPath: string, pid: number): Promise<StopResult> {
  const outcome = await terminateProcess(pid, { escalationMs: ctx.killEscalationMs })
  // Cleared on both paths. On a refusal the process either died between the
  // status and the signal or is not ours to signal, and clearing is the honest
  // move in both cases: `status` then reports what is actually true — nothing
  // of ours here (and an `external` answer if the port is still busy).
  await removePidFile(pidPath)
  if (outcome.kind === 'refused') {
    return { kind: 'stale-cleared', pid, detail: outcome.detail }
  }
  return { kind: 'stopped', pid, forced: outcome.forced }
}
