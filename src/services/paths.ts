import { join } from 'node:path'
import { LOG_FILE_SUFFIX, PID_FILE_SUFFIX, RUN_DIR_NAME, type ServiceName } from './constants.js'

/**
 * Where a managed service's runtime bookkeeping lives, derived from the data
 * directory alone (mcpcut phase 1, Task 7).
 *
 * Every path is a pure function of `(dataDir, service)` so that the manager,
 * the CLI and the tests all name the same file without passing paths around:
 * "which log does `mcpcut logs ui` print" has exactly one answer, computed
 * the same way everywhere.
 */

/** The `run/` directory holding pid files and daemon logs for one install. */
export function runDirFor(dataDir: string): string {
  return join(dataDir, RUN_DIR_NAME)
}

/** Pid file of one service — the durable link between a `start` and its detached child. */
export function pidFilePathFor(dataDir: string, service: ServiceName): string {
  return join(runDirFor(dataDir), `${service}${PID_FILE_SUFFIX}`)
}

/** Log file of one service — the daemon's stdout and stderr, appended across restarts. */
export function logFilePathFor(dataDir: string, service: ServiceName): string {
  return join(runDirFor(dataDir), `${service}${LOG_FILE_SUFFIX}`)
}
