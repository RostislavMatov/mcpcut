import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runServiceCommand, type ServiceCliOptions } from '../../src/cli/service-cmd.js'
import type { ServiceName } from '../../src/services/constants.js'
import type {
  ServiceManager,
  ServiceState,
  ServiceStatus,
  StartResult,
  StopResult,
} from '../../src/services/manager.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * `mcpcut start|stop|status|logs` (mcpcut phase 1, Task 12): the four commands
 * that stand between an operator and the service manager.
 *
 * Almost everything here runs against an INJECTED manager, because what this
 * layer owns is argv, ordering, exit codes and which stream a line lands on --
 * the manager's own behaviour is proven in `tests/services/manager.test.ts`.
 * The last describe closes the loop once with the real manager and the fake
 * service, so the wiring between the two is not taken on faith.
 */

const FAKE_SERVICE_PATH = fileURLToPath(new URL('../fixtures/fake-service.mjs', import.meta.url))

/** Generous enough for a node boot on a loaded CI box, short enough to fail fast. */
const READY_TIMEOUT_MS = 5_000
/** Short escalation so a stop in this suite never waits out the production grace period. */
const KILL_ESCALATION_MS = 400

const CONFIG_PATH = '/home/op/.mcpcut/config.json'
const DATA_DIR = '/tmp/mcpcut-service-cmd'

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  readonly out: () => string
  readonly err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function statusOf(
  service: ServiceName,
  state: ServiceState,
  extra: Partial<ServiceStatus> = {},
): ServiceStatus {
  return {
    service,
    state,
    host: '127.0.0.1',
    port: service === 'ui' ? 8091 : 8090,
    logPath: `${DATA_DIR}/run/${service}.log`,
    ...extra,
  }
}

interface ManagerCall {
  readonly verb: 'start' | 'stop' | 'status' | 'logs'
  readonly service: ServiceName
  readonly lines?: number
}

interface ManagerScript {
  readonly start?: Readonly<Partial<Record<ServiceName, StartResult>>>
  readonly stop?: Readonly<Partial<Record<ServiceName, StopResult>>>
  readonly status?: Readonly<Partial<Record<ServiceName, ServiceStatus>>>
  readonly logs?: Readonly<Partial<Record<ServiceName, readonly string[]>>>
}

type FakeManager = ServiceManager & { readonly calls: readonly ManagerCall[] }

/**
 * A manager of pre-recorded answers that also records what it was asked, in
 * order: the ordering guarantees (`ui` first on start, `serve` first on stop)
 * are only observable through the call log.
 */
function fakeManager(script: ManagerScript = {}): FakeManager {
  const calls: ManagerCall[] = []
  const answer = <T>(scripted: T | undefined, verb: string, service: ServiceName): T => {
    if (scripted === undefined) throw new Error(`fake manager: no ${verb} scripted for ${service}`)
    return scripted
  }
  return {
    calls,
    start: async (service) => {
      calls.push({ verb: 'start', service })
      return answer(script.start?.[service], 'start', service)
    },
    stop: async (service) => {
      calls.push({ verb: 'stop', service })
      return answer(script.stop?.[service], 'stop', service)
    },
    status: async (service) => {
      calls.push({ verb: 'status', service })
      return answer(script.status?.[service], 'status', service)
    },
    logs: async (service, lines) => {
      calls.push({ verb: 'logs', service, ...(lines !== undefined ? { lines } : {}) })
      return answer(script.logs?.[service], 'logs', service)
    },
  }
}

const okInstall: InstallConfigLoad = {
  kind: 'ok',
  path: CONFIG_PATH,
  config: defaultInstallConfig(DATA_DIR),
}

function withManager(manager: ServiceManager): ServiceCliOptions {
  return { install: okInstall, manager }
}

function servicesOf(calls: readonly ManagerCall[]): readonly ServiceName[] {
  return calls.map((call) => call.service)
}

describe('mcpcut start', () => {
  test('starts both services, ui first, and exits 0 when each is up', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      start: {
        ui: { kind: 'started', status: statusOf('ui', 'running', { pid: 4242 }) },
        serve: { kind: 'already-running', status: statusOf('serve', 'running', { pid: 4243 }) },
      },
    })

    const exitCode = await runServiceCommand('start', [], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(servicesOf(manager.calls)).toEqual(['ui', 'serve'])
    expect(io.out()).toContain('ui:    started pid 4242')
    expect(io.out()).toContain('serve: already running pid 4243')
    expect(io.err()).toBe('')
  })

  test('starts only the named service when one is given', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      start: { serve: { kind: 'started', status: statusOf('serve', 'running', { pid: 7 }) } },
    })

    const exitCode = await runServiceCommand('start', ['serve'], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(servicesOf(manager.calls)).toEqual(['serve'])
    expect(io.out()).not.toContain('ui:')
  })

  test('exits 1 on a failed start and prints the reason with the log tail', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      start: {
        ui: {
          kind: 'failed',
          reason: 'exited with code 3 before answering',
          logTail: ['ui: refusing to start (FAKE_EXIT_CODE=3)'],
        },
        serve: { kind: 'started', status: statusOf('serve', 'running', { pid: 9 }) },
      },
    })

    const exitCode = await runServiceCommand('start', [], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(io.out()).toContain('exited with code 3 before answering')
    expect(io.out()).toContain('ui: refusing to start (FAKE_EXIT_CODE=3)')
    // A failed ui does not cancel serve: the operator asked for both.
    expect(servicesOf(manager.calls)).toEqual(['ui', 'serve'])
  })

  test('counts an externally supervised service as nothing to do (exit 0)', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      start: {
        ui: { kind: 'external', status: statusOf('ui', 'external') },
        serve: { kind: 'external', status: statusOf('serve', 'external') },
      },
    })

    const exitCode = await runServiceCommand('start', [], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('external')
  })

  test('exits 1 when the platform cannot run detached services', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      start: {
        ui: { kind: 'unsupported', reason: 'mcpcut cannot run detached services on Windows' },
        serve: { kind: 'unsupported', reason: 'mcpcut cannot run detached services on Windows' },
      },
    })

    const exitCode = await runServiceCommand('start', [], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(io.out()).toContain('unsupported')
  })
})

describe('mcpcut stop', () => {
  test('stops both services, serve first, and exits 0', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      stop: {
        serve: { kind: 'stopped', pid: 4243, forced: false },
        ui: { kind: 'not-running' },
      },
    })

    const exitCode = await runServiceCommand('stop', [], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(servicesOf(manager.calls)).toEqual(['serve', 'ui'])
    expect(io.out()).toContain('serve: stopped pid 4243')
    expect(io.out()).toContain('ui:    not running')
  })

  test('exits 1 when a stop is unsupported on this platform', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      stop: {
        serve: { kind: 'unsupported', reason: 'mcpcut cannot run detached services on Windows' },
        ui: { kind: 'unsupported', reason: 'mcpcut cannot run detached services on Windows' },
      },
    })

    const exitCode = await runServiceCommand('stop', [], io, withManager(manager))

    expect(exitCode).toBe(1)
  })

  test('reports a cleared stale pid file on stderr and still exits 0', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      stop: {
        ui: { kind: 'stale-cleared', pid: 111, detail: 'pid 111 is not running' },
        serve: { kind: 'not-running' },
      },
    })

    const exitCode = await runServiceCommand('stop', [], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('stale pid file cleared')
    expect(io.out()).not.toContain('stale pid file cleared')
  })
})

describe('mcpcut status', () => {
  test('prints the table and exits 1 while one service is down', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      status: {
        ui: statusOf('ui', 'running', { pid: 4242, startedAt: '2026-09-04T09:12:03.000Z' }),
        serve: statusOf('serve', 'stopped'),
      },
    })

    const exitCode = await runServiceCommand('status', [], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(servicesOf(manager.calls)).toEqual(['ui', 'serve'])
    expect(io.out()).toContain('ui     running')
    expect(io.out()).toContain('serve  stopped')
    expect(io.out()).toContain('since 2026-09-04T09:12:03Z')
  })

  test('exits 0 when every service runs', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      status: {
        ui: statusOf('ui', 'running', { pid: 1 }),
        serve: statusOf('serve', 'running', { pid: 2 }),
      },
    })

    const exitCode = await runServiceCommand('status', [], io, withManager(manager))

    expect(exitCode).toBe(0)
  })

  test('--json prints one parsable document with keys sorted at every level', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      status: {
        ui: statusOf('ui', 'running', { pid: 1 }),
        serve: statusOf('serve', 'running', { pid: 2 }),
      },
    })

    const exitCode = await runServiceCommand('status', ['--json'], io, withManager(manager))

    expect(exitCode).toBe(0)
    const parsed: unknown = JSON.parse(io.out())
    expect(Array.isArray(parsed)).toBe(true)
    const rows = parsed as readonly Record<string, unknown>[]
    expect(rows.map((row) => row['service'])).toEqual(['ui', 'serve'])
    const keys = Object.keys(rows[0] ?? {})
    expect(keys).toEqual([...keys].sort())
  })

  test('refuses a positional service name rather than silently ignoring it', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('status', ['ui'], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain('status')
  })
})

describe('mcpcut logs', () => {
  test('passes --lines through and prints the tail as plain lines', async () => {
    const io = fakeIo()
    const manager = fakeManager({ logs: { ui: ['first', 'second', 'third'] } })

    const exitCode = await runServiceCommand('logs', ['ui', '--lines', '3'], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(manager.calls).toEqual([{ verb: 'logs', service: 'ui', lines: 3 }])
    expect(io.out()).toBe('first\nsecond\nthird\n')
  })

  test('prints nothing for an empty log and still exits 0', async () => {
    const io = fakeIo()
    const manager = fakeManager({ logs: { serve: [] } })

    const exitCode = await runServiceCommand('logs', ['serve'], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('')
  })

  test('requires a service name and prints the usage when it is missing', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('logs', [], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain('Usage:')
    expect(io.err()).toContain('logs <ui|serve>')
  })

  test('refuses a --lines value that is not a positive whole number', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('logs', ['ui', '--lines', 'abc'], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain('Invalid --lines "abc"')
  })

  test('refuses --lines 0, which would ask for a tail of nothing', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('logs', ['ui', '--lines', '0'], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
  })
})

describe('an unknown service name', () => {
  test('is refused by name, without touching the manager', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('start', ['proxy'], io, withManager(manager))

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain('Unknown service "proxy": expected ui or serve.')
  })
})

/**
 * Without a config there is no data directory to manage services in, and no
 * bind addresses to probe. Falling back to `$HOME` would start daemons in a
 * plane the operator did not configure, so every verb refuses and says how to
 * get one.
 */
describe('an install with no config', () => {
  const absent: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }

  test('refuses to start, naming the missing path and the setup command', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('start', [], io, { install: absent, manager })

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain('Refusing to start services')
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('mcpcut setup --yes')
    expect(io.out()).toBe('')
  })

  test('refuses to stop and to read logs for the same reason', async () => {
    const stopIo = fakeIo()
    const logsIo = fakeIo()
    const manager = fakeManager()

    const stopCode = await runServiceCommand('stop', [], stopIo, { install: absent, manager })
    const logsCode = await runServiceCommand('logs', ['ui'], logsIo, { install: absent, manager })

    expect(stopCode).toBe(1)
    expect(logsCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(stopIo.err()).toContain('Refusing to stop services')
    expect(logsIo.err()).toContain(CONFIG_PATH)
  })

  test('status states the fact instead of refusing, and exits 1', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('status', [], io, { install: absent, manager })

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toBe(`status: no install config at ${CONFIG_PATH}\n`)
  })
})

describe('an install whose config is unusable', () => {
  const invalid: InstallConfigLoad = {
    kind: 'invalid',
    path: CONFIG_PATH,
    problems: ['dataDir: dataDir must be an absolute path', 'ui: unknown key "token"'],
  }

  test('refuses and lists every problem, without touching the manager', async () => {
    const io = fakeIo()
    const manager = fakeManager()

    const exitCode = await runServiceCommand('start', [], io, { install: invalid, manager })

    expect(exitCode).toBe(1)
    expect(manager.calls).toEqual([])
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('dataDir: dataDir must be an absolute path')
    expect(io.err()).toContain('ui: unknown key "token"')
  })
})

/**
 * A daemon log is written by whatever the service printed, which includes
 * anything an upstream MCP server made it print (SEC-M6). Echoed raw into a
 * terminal, a line carrying C0 or ANSI can erase the lines above it — the
 * operator would be reading a forged tail.
 */
describe('mcpcut logs: the tail is screened before it reaches the terminal', () => {
  test('an ANSI erase sequence in a log line is not echoed raw', async () => {
    const io = fakeIo()
    const manager = fakeManager({
      logs: { ui: ['\u001b[2Kui: everything is fine'] },
    })

    const exitCode = await runServiceCommand('logs', ['ui'], io, withManager(manager))

    expect(exitCode).toBe(0)
    expect(io.out()).not.toContain('\u001b[2K')
    expect(io.out()).toContain('ui: everything is fine')
  })
})

/**
 * One pass over the real manager: the command builds it from the install
 * config, a service comes up, `status` sees it and `stop` takes it down. The
 * fake service stands in for `ui` (the suite runs from source, so there is no
 * `dist/cli.js` to point at).
 */
describe('the commands against the real manager', () => {
  const cleanups: Array<() => Promise<void>> = []
  let dataDir: string
  let config: InstallConfig

  /** A port nothing holds: bind an ephemeral one, learn its number, give it back. */
  async function freePort(): Promise<number> {
    const server = createNetServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-service-cmd-'))
    const base = defaultInstallConfig(dataDir)
    config = {
      ...base,
      ui: { ...base.ui, port: await freePort() },
      serve: { ...base.serve, port: await freePort() },
    }
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch(() => undefined)
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  function realOptions(): ServiceCliOptions {
    return {
      install: { kind: 'ok', path: join(dataDir, 'config.json'), config },
      journalDir: dataDir,
      managerDeps: {
        cliPath: FAKE_SERVICE_PATH,
        readyTimeoutMs: READY_TIMEOUT_MS,
        killEscalationMs: KILL_ESCALATION_MS,
      },
    }
  }

  test('start ui leaves a service that status sees and stop takes down', async () => {
    const opts = realOptions()
    // Registered before the start, so a failed assertion below still stops the daemon.
    cleanups.push(async () => {
      await runServiceCommand('stop', ['ui'], fakeIo(), opts)
    })

    const startIo = fakeIo()
    const startCode = await runServiceCommand('start', ['ui'], startIo, opts)
    expect(startCode).toBe(0)
    expect(startIo.out()).toContain('ui:    started pid')

    const statusIo = fakeIo()
    // 1, not 0: `serve` was never started, and status speaks for both.
    expect(await runServiceCommand('status', [], statusIo, opts)).toBe(1)
    expect(statusIo.out()).toContain('ui     running')

    const logsIo = fakeIo()
    expect(await runServiceCommand('logs', ['ui', '--lines', '5'], logsIo, opts)).toBe(0)
    expect(logsIo.out()).toContain('listening on')

    const stopIo = fakeIo()
    expect(await runServiceCommand('stop', ['ui'], stopIo, opts)).toBe(0)
    expect(stopIo.out()).toContain('ui:    stopped pid')

    const afterIo = fakeIo()
    expect(await runServiceCommand('status', [], afterIo, opts)).toBe(1)
    expect(afterIo.out()).toContain('ui     stopped')
  })
})
