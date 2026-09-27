import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach } from 'vitest'
import { createDockerClient, type DockerClient } from '../../../hub/src/provisioner/docker.js'
import {
  createProvisionerService,
  type ProvisionerService,
  type ProvisionerServiceOptions,
} from '../../../hub/src/provisioner/service.js'
import { startFakeDocker, type ExecScript, type FakeContainer, type FakeDocker } from '../fake-docker.js'

/**
 * A provisioner over the fake Docker Engine (plan `tenant-orchestrator`,
 * Task 4). The fake answers `docker exec` the way a tenant install would: the
 * readiness probe (`node -e`, `READY_PROBE_SCRIPT`) prints both services up,
 * `admin add|rotate … --json` prints the one-line contract with a fresh
 * `mcpa_` token. A test can replace any answer with `answer(...)`.
 */

export const CADDY = 'caddy'
export const FAST_READINESS = { timeoutMs: 300, pollMs: 5, execTimeoutMs: 200 } as const

export type ExecKind = 'ready' | 'admin-add' | 'admin-rotate' | 'stat' | 'other'

export type ExecOverride = (argv: readonly string[], container: FakeContainer) => ExecScript | undefined

export interface ProvisionerContext {
  fake(): FakeDocker
  docker(): DockerClient
  service(): ProvisionerService
  serviceWith(options: Partial<ProvisionerServiceOptions>): ProvisionerService
  /** Every owner token the fake install minted, newest last. */
  tokens(): readonly string[]
  logs(): readonly string[]
  /** Scripts the next exec answers; the first override that returns a script wins. */
  answer(override: ExecOverride): void
  /** argv of every exec, in order. */
  execs(): readonly (readonly string[])[]
}

export function execKindOf(argv: readonly string[]): ExecKind {
  if (argv[0] === 'stat') return 'stat'
  if (argv[0] === 'node' && argv[1] === '-e') return 'ready'
  const command = argv.slice(2).join(' ')
  if (command.startsWith('admin add ')) return 'admin-add'
  if (command.startsWith('admin rotate ')) return 'admin-rotate'
  return 'other'
}

/** The mtime (epoch seconds) the fake install reports for `journal.db` and `state.db`. */
export const FAKE_ACTIVITY_S = Date.parse('2026-09-20T08:00:00.000Z') / 1000

/** What the readiness probe script prints once both services answer. */
export const READY_STATUS = JSON.stringify({ ui: true, serve: true })

export function useProvisioner(): ProvisionerContext {
  let fake: FakeDocker | undefined
  let docker: DockerClient | undefined
  let service: ProvisionerService | undefined
  let tokens: string[] = []
  let logs: string[] = []
  let overrides: ExecOverride[] = []
  let execs: (readonly string[])[] = []

  const current = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`${what} is not running`)
    return value
  }
  const make = (options: Partial<ProvisionerServiceOptions>): ProvisionerService =>
    createProvisionerService({
      docker: current(docker, 'docker client'),
      image: 'mcpcut-tenant:local',
      publicDomain: 'mcpcut.com',
      caddyContainer: CADDY,
      readiness: FAST_READINESS,
      log: (line) => logs.push(line),
      ...options,
    })

  beforeEach(async () => {
    tokens = []
    logs = []
    overrides = []
    execs = []
    fake = await startFakeDocker()
    fake.onExec((container, argv) => {
      execs.push(argv)
      for (const override of overrides) {
        const script = override(argv, container)
        if (script !== undefined) return script
      }
      return defaultAnswer(argv, tokens)
    })
    docker = createDockerClient({ socketPath: fake.socketPath })
    const caddy = await docker.createContainer(CADDY, { Image: 'caddy:2' })
    await docker.startContainer(caddy.id)
    service = make({})
  })
  afterEach(async () => {
    docker?.close()
    await fake?.close()
    fake = undefined
    docker = undefined
    service = undefined
  })

  return {
    fake: () => current(fake, 'fake docker'),
    docker: () => current(docker, 'docker client'),
    service: () => current(service, 'service'),
    serviceWith: make,
    tokens: () => [...tokens],
    logs: () => [...logs],
    answer: (override) => {
      overrides = [...overrides, override]
    },
    execs: () => [...execs],
  }
}

function defaultAnswer(argv: readonly string[], tokens: string[]): ExecScript {
  const kind = execKindOf(argv)
  // What the real readiness probe prints once both services answer; it always exits 0.
  if (kind === 'ready') return { exitCode: 0, stdout: `${READY_STATUS}\n` }
  if (kind === 'admin-add' || kind === 'admin-rotate') {
    const token = `mcpa_${randomBytes(24).toString('base64url')}`
    tokens.push(token)
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ admin: argv[4], role: 'owner', token })}\n`,
      stderr: 'This token is shown once.\n',
    }
  }
  if (kind === 'stat') return statAnswer(argv)
  return { exitCode: 127, stderr: 'unknown command\n' }
}

/**
 * What GNU `stat -c %Y` does over a fresh install's data directory: a line per
 * file that exists (`journal.db`, `state.db`), a complaint on stderr for each
 * `-wal` that does not, and exit code 1 because one was missing.
 */
function statAnswer(argv: readonly string[]): ExecScript {
  const files = argv.slice(3)
  const present = files.filter((file) => !file.endsWith('-wal'))
  const missing = files.filter((file) => file.endsWith('-wal'))
  return {
    exitCode: missing.length === 0 ? 0 : 1,
    stdout: present.map(() => `${FAKE_ACTIVITY_S}\n`).join(''),
    stderr: missing.map((file) => `stat: cannot statx '${file}': No such file or directory\n`).join(''),
  }
}

/** The tenant's objects the fake holds, by kind — the caddy container is not a tenant's. */
export function tenantObjects(fake: FakeDocker): { containers: string[]; networks: string[]; volumes: string[] } {
  return {
    containers: fake.containers().map((c) => c.name).filter((name) => name !== CADDY),
    networks: fake.networks().map((n) => n.name),
    volumes: fake.volumes().map((v) => v.name),
  }
}

export async function errorOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw new Error(`expected an Error, got ${String(error)}`)
  }
  throw new Error('expected the call to fail')
}
