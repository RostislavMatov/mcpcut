import { type ServiceName } from './constants.js'
import { readLogTail } from './log-tail.js'
import { startService } from './manager-start.js'
import { statusOfService } from './manager-status.js'
import { stopService } from './manager-stop.js'
import { managerContextOf, type ServiceManager, type ServiceManagerDeps } from './manager-types.js'
import { logFilePathFor } from './paths.js'

/**
 * The service manager (mcpcut phase 1, Task 11; ADR-0012) — the API `mcpcut
 * start|stop|status|logs` and `setup --start` are built on.
 *
 * This file is the seam and nothing else: the three verbs live in
 * `manager-start.ts`, `manager-stop.ts` and `manager-status.ts`, which is
 * where the reasoning behind each of them is written down (in particular the
 * pid-reuse rule, in `manager-status.ts`). Rendering lives in `format.ts`, so
 * nothing here knows what a terminal is.
 */
export {
  type ManagerContext,
  type ServiceManager,
  type ServiceManagerDeps,
  type ServiceState,
  type ServiceStatus,
  type StartResult,
  type StopResult,
} from './manager-types.js'
export { detachedSpawnOptions } from './manager-spawn.js'

/** Binds one install's data directory and config to the four verbs. */
export function createServiceManager(deps: ServiceManagerDeps): ServiceManager {
  const ctx = managerContextOf(deps)
  return {
    start: (service: ServiceName) => startService(ctx, service),
    stop: (service: ServiceName) => stopService(ctx, service),
    status: (service: ServiceName) => statusOfService(ctx, service),
    logs: (service: ServiceName, lines?: number) => readLogTail(logFilePathFor(ctx.dataDir, service), lines),
  }
}
