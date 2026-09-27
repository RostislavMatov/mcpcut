import { z } from 'zod'
import type { DockerClient } from './docker.js'
import { ProvisionerError } from './errors.js'
import { TENANT_CLI, TENANT_USER } from './templates.js'
import { ADMIN_EXEC_TIMEOUT_MS, READY_TIMEOUT_MS } from './timeouts.js'

/**
 * The two things the provisioner asks a running install, by `docker exec`
 * (plan `tenant-orchestrator`, Task 4, O7):
 *
 *  - "are you up?" — `mcpcut status --json`, until both `ui` and `serve`
 *    answer on their ports. Inside a tenant container the services run under
 *    `docker/tenant-run.sh` with `supervisor: external`, so there is no pid
 *    file and a service that answers reads `external` (and `status` exits 1,
 *    which is why its exit code is not consulted); `running` is accepted too,
 *    so the check survives a future image that keeps pid files.
 *  - "mint an owner token" — `admin add <name> --role owner --json` on the
 *    first create, `admin rotate <name> --recover --json` after. The one
 *    stdout line is the contract; it is parsed strictly and its token goes
 *    back to the caller only. No error here quotes stdout or stderr.
 */

export { ADMIN_EXEC_TIMEOUT_MS, READY_TIMEOUT_MS } from './timeouts.js'
export const READY_POLL_MS = 1_000
export const STATUS_EXEC_TIMEOUT_MS = 10_000

const TENANT_HOME = '/home/node'
const READY_STATES: ReadonlySet<string> = new Set(['running', 'external'])
const REQUIRED_SERVICES: readonly string[] = ['ui', 'serve']
/** `mcpa_` + base64url of the CSPRNG bytes (`src/admin/constants.ts`). */
const OWNER_TOKEN_PATTERN = /^mcpa_[A-Za-z0-9_-]{16,256}$/

const StatusAnswer = z.array(z.object({ service: z.string(), state: z.string() }))
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

/** True when `stdout` is a `status --json` document naming both services as up. */
export function isReadyStatus(stdout: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return false
  }
  const answer = StatusAnswer.safeParse(parsed)
  if (!answer.success) return false
  return REQUIRED_SERVICES.every((service) =>
    answer.data.some((entry) => entry.service === service && READY_STATES.has(entry.state)),
  )
}

/** Polls `status --json` until both services are up, or fails with `not-ready` at the deadline. */
export async function waitUntilReady(docker: DockerClient, container: string, options: ReadinessOptions = {}): Promise<void> {
  const clock = options.clock ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? READY_POLL_MS
  const deadline = clock() + timeoutMs
  for (;;) {
    const remaining = deadline - clock()
    const execTimeoutMs = Math.max(1, Math.min(options.execTimeoutMs ?? STATUS_EXEC_TIMEOUT_MS, remaining))
    if (await answersReady(docker, container, execTimeoutMs)) return
    if (clock() + pollMs >= deadline) {
      throw new ProvisionerError('not-ready', `the install did not come up within ${Math.round(timeoutMs / 1000)} s`)
    }
    await sleep(pollMs)
  }
}

async function answersReady(docker: DockerClient, container: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await docker.exec(container, [...TENANT_CLI, 'status', '--json'], execOptions(timeoutMs))
    // The document decides, not the exit code: `status` exits 1 unless every
    // service is `running`, and inside a tenant container a service that is
    // up reads `external` (no pid file under `supervisor: external`).
    return !result.truncated.stdout && isReadyStatus(result.stdout)
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

function execOptions(timeoutMs: number): { user: string; env: Record<string, string>; timeoutMs: number } {
  return { user: TENANT_USER, env: { HOME: TENANT_HOME }, timeoutMs }
}
