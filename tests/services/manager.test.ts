import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../../src/config.js'
import {
  PID_RECORD_VERSION,
  SPAWN_FAILURE_GRACE_MS,
  type ServiceName,
} from '../../src/services/constants.js'
import {
  createServiceManager,
  detachedSpawnOptions,
  type ServiceManager,
  type ServiceManagerDeps,
} from '../../src/services/manager.js'
import { isProcessAlive, readPidFile, type PidRecord } from '../../src/services/pid-file.js'
import { logFilePathFor, pidFilePathFor, runDirFor } from '../../src/services/paths.js'
import { probeService } from '../../src/services/probe.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * The service manager (mcpcut phase 1, Task 11): what stands between `mcpcut
 * start` and a process that outlives the terminal.
 *
 * Real processes throughout — `tests/fixtures/fake-service.mjs` speaks the
 * argv of the real `ui`/`serve` and shows the same daemon manners. A manager
 * proven only against a mocked `spawn` would have proven nothing about the
 * two properties that matter: that the child survives its parent, and that a
 * stop reaches it.
 */

const FAKE_SERVICE_PATH = fileURLToPath(new URL('../fixtures/fake-service.mjs', import.meta.url))
const START_AND_EXIT_PATH = fileURLToPath(new URL('../fixtures/start-and-exit.mjs', import.meta.url))

/** Generous enough for a node boot on a loaded CI box, short enough to fail fast. */
const READY_TIMEOUT_MS = 5_000
/** Short escalation so the SIGKILL test does not wait out the production grace period. */
const KILL_ESCALATION_MS = 400
/** Deadline for the polling helpers below. */
const WAIT_DEADLINE_MS = 10_000
const WAIT_POLL_MS = 20
/** Slack for a setTimeout that a loaded box may fire a hair early. */
const TIMER_TOLERANCE_MS = 50

const cleanups: Array<() => Promise<void>> = []

let dataDir: string
let config: InstallConfig

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

function onDispose(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(WAIT_POLL_MS)
  }
}

/** A port nothing holds: bind an ephemeral one, learn its number, give it back. */
async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-manager-'))
  onDispose(() => rm(dataDir, { recursive: true, force: true }))
  const base = defaultInstallConfig(dataDir)
  config = {
    ...base,
    ui: { ...base.ui, port: await freePort() },
    serve: { ...base.serve, port: await freePort() },
  }
})

/** Every child a test spawned, so nothing survives the file. */
const spawnedChildren: ChildProcess[] = []

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.pid !== undefined && !child.killed) child.kill('SIGKILL')
  }
})

/**
 * The real `spawn`, with a hook that runs first. `beforeSpawn` is how the
 * pid-file race is staged: it plants a record in exactly the window the
 * manager's exclusive create exists to close.
 */
function trackingSpawn(beforeSpawn?: () => void): typeof spawn {
  const wrapped = (command: string, args: readonly string[], options: object): ChildProcess => {
    beforeSpawn?.()
    const child = spawn(command, args as string[], options)
    spawnedChildren.push(child)
    return child
  }
  return wrapped as unknown as typeof spawn
}

/** A `spawn` that fails the test if the manager reaches for it. */
const refusingSpawn = ((): never => {
  throw new Error('spawn must not be called')
}) as unknown as typeof spawn

function makeManager(overrides: Partial<ServiceManagerDeps> = {}): ServiceManager {
  return createServiceManager({
    dataDir,
    config,
    cliPath: FAKE_SERVICE_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    killEscalationMs: KILL_ESCALATION_MS,
    spawn: trackingSpawn(),
    ...overrides,
  })
}

function bindOf(service: ServiceName): { readonly host: string; readonly port: number } {
  return service === 'ui' ? config.ui : config.serve
}

/**
 * Writes a pid file behind the manager's back, the way a crashed run leaves
 * one. Synchronous on purpose: the race test plants it from inside a `spawn`
 * hook, where an awaited write would land after the window it is staging.
 */
function plantPidFile(service: ServiceName, pid: number, startedAt?: string): void {
  mkdirSync(runDirFor(dataDir), { recursive: true, mode: JOURNAL_DIR_MODE })
  const bind = bindOf(service)
  const record: PidRecord = {
    version: PID_RECORD_VERSION,
    service,
    pid,
    host: bind.host,
    port: bind.port,
    startedAt: startedAt ?? new Date().toISOString(),
  }
  writeFileSync(pidFilePathFor(dataDir, service), `${JSON.stringify(record)}\n`, {
    mode: JOURNAL_FILE_MODE,
  })
}

/** A process that is alive and answers nothing — the pid-reuse stand-in. */
async function startIdleProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  spawnedChildren.push(child)
  await once(child, 'spawn')
  const pid = child.pid
  if (pid === undefined) throw new Error('idle helper did not spawn')
  return pid
}

/** A pid that is certainly gone: a process that has already exited. */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  const pid = child.pid
  if (pid === undefined) throw new Error('short-lived helper did not spawn')
  return pid
}

/** An HTTP server answering `/login`, standing in for a service mcpcut did not start. */
async function startForeignUi(port: number): Promise<void> {
  const server: HttpServer = createHttpServer((req, res) => {
    res.writeHead(req.url === '/login' ? 200 : 404)
    res.end()
  })
  onDispose(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
}

async function pidFileMode(service: ServiceName): Promise<number> {
  return (await stat(pidFilePathFor(dataDir, service))).mode & 0o777
}

describe('start and status', () => {
  test('starts a service, records it in a 0600 pid file and reports it running', async () => {
    const manager = makeManager()

    const started = await manager.start('ui')

    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    expect(started.status.state).toBe('running')
    expect(started.status.port).toBe(config.ui.port)
    expect(started.status.logPath).toBe(logFilePathFor(dataDir, 'ui'))
    expect(await pidFileMode('ui')).toBe(JOURNAL_FILE_MODE)

    const status = await manager.status('ui')
    expect(status.state).toBe('running')
    expect(status.pid).toBe(started.status.pid)
    expect(status.startedAt).toBeDefined()

    await manager.stop('ui')
  })

  test('does not start a second copy of a service that already answers', async () => {
    const manager = makeManager()
    await manager.start('ui')

    const again = await manager.start('ui')

    expect(again.kind).toBe('already-running')
    if (again.kind !== 'already-running') return
    expect(again.status.state).toBe('running')

    await manager.stop('ui')
  })

  test('starts serve, whose readiness is an accepted connection rather than a 2xx', async () => {
    const manager = makeManager()

    const started = await manager.start('serve')

    expect(started.kind).toBe('started')
    expect((await manager.status('serve')).state).toBe('running')

    await manager.stop('serve')
  })

  test('reports a service answering with no pid file as external and never spawns one', async () => {
    await startForeignUi(config.ui.port)
    const manager = makeManager({ spawn: refusingSpawn })

    const status = await manager.status('ui')
    const started = await manager.start('ui')

    expect(status.state).toBe('external')
    expect(started.kind).toBe('external')
  })

  test('leaves the services alone when the install hands them to another supervisor', async () => {
    const manager = makeManager({
      config: { ...config, supervisor: 'external' },
      spawn: refusingSpawn,
    })

    const started = await manager.start('ui')

    expect(started.kind).toBe('external')
  })

  test('refuses to start on Windows, where a detached daemon is not implemented', async () => {
    const manager = makeManager({ platform: 'win32', spawn: refusingSpawn })

    const started = await manager.start('ui')
    const stopped = await manager.stop('ui')

    expect(started.kind).toBe('unsupported')
    if (started.kind !== 'unsupported') return
    expect(started.reason).toContain('Windows')
    expect(stopped.kind).toBe('unsupported')
  })

  test('answers with defaults alone: no cli path, no clock, no spawn seam', async () => {
    const manager = createServiceManager({ dataDir, config })

    const status = await manager.status('serve')

    expect(status.state).toBe('stopped')
    expect(status.logPath).toBe(logFilePathFor(dataDir, 'serve'))
  })

  test('passes the configured surface to the child as flags, so ps shows the real thing', async () => {
    const argvSeen: string[][] = []
    const recordingSpawn = ((command: string, args: readonly string[], options: object): ChildProcess => {
      argvSeen.push([...args])
      const child = spawn(command, args as string[], options)
      spawnedChildren.push(child)
      return child
    }) as unknown as typeof spawn
    const manager = makeManager({
      spawn: recordingSpawn,
      config: {
        ...config,
        ui: {
          ...config.ui,
          behindTls: true,
          allowedHosts: ['console.example', 'console2.example'],
          allowedOrigins: ['https://console.example'],
          trustedProxyHeader: 'x-forwarded-for',
        },
      },
    })

    await manager.start('ui')

    expect(argvSeen[0]).toEqual([
      FAKE_SERVICE_PATH,
      'ui',
      '--host',
      config.ui.host,
      '--port',
      String(config.ui.port),
      '--behind-tls',
      '--allowed-host',
      'console.example',
      '--allowed-host',
      'console2.example',
      '--allowed-origin',
      'https://console.example',
      '--trusted-proxy-header',
      'x-forwarded-for',
    ])

    await manager.stop('ui')
  })

  test('passes serve its policy path and fail-closed switch as flags', async () => {
    const argvSeen: string[][] = []
    const recordingSpawn = ((command: string, args: readonly string[], options: object): ChildProcess => {
      argvSeen.push([...args])
      const child = spawn(command, args as string[], options)
      spawnedChildren.push(child)
      return child
    }) as unknown as typeof spawn
    const manager = makeManager({
      spawn: recordingSpawn,
      config: {
        ...config,
        serve: {
          ...config.serve,
          policy: '/etc/mcpcut/policy.json',
          failClosed: true,
          allowedOrigins: ['https://agent.example'],
          allowedHosts: ['agent.example'],
        },
      },
    })

    await manager.start('serve')

    expect(argvSeen[0]?.slice(6)).toEqual([
      '--policy',
      '/etc/mcpcut/policy.json',
      '--fail-closed',
      '--allowed-origin',
      'https://agent.example',
      '--allowed-host',
      'agent.example',
    ])

    await manager.stop('serve')
  })
})

describe('failed starts', () => {
  test('reports the exit code and the log tail when the service dies at once', async () => {
    const manager = makeManager({ env: { ...process.env, FAKE_EXIT_CODE: '3' } })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('3')
    expect(started.logTail.join('\n')).toContain('FAKE_EXIT_CODE=3')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
  })

  test('gives up on a service that never answers and leaves no child behind', async () => {
    const manager = makeManager({
      env: { ...process.env, FAKE_SLOW_START_MS: '60000' },
      readyTimeoutMs: 300,
    })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('did not answer within 300 ms')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')

    const child = spawnedChildren.at(-1)
    const pid = child?.pid
    if (pid === undefined) throw new Error('no child was spawned')
    await waitUntil(() => !isProcessAlive(pid), 'the abandoned child to be gone')
  })

  test('backs out of a lost pid-file race and terminates the child it had already spawned', async () => {
    const foreignPid = await startIdleProcess()
    // Planted in the window between the spawn and the pid write — the very
    // race `createPidFileExclusive` exists to lose safely.
    const manager = makeManager({
      spawn: trackingSpawn(() => {
        plantPidFile('ui', foreignPid)
      }),
      // Slow start so our child cannot bind the port before we abandon it.
      env: { ...process.env, FAKE_SLOW_START_MS: '30000' },
    })

    const started = await manager.start('ui')

    expect(started.kind).toBe('already-running')
    if (started.kind !== 'already-running') return
    // Never `—`: the loser reports the WINNER's pid, which it can only do by
    // re-reading the status after backing out.
    expect(started.status.pid).toBe(foreignPid)
    const child = spawnedChildren.at(-1)
    const pid = child?.pid
    if (pid === undefined) throw new Error('no child was spawned')
    await waitUntil(() => !isProcessAlive(pid), 'our own child to be terminated')
    // The planted record is the winner's: backing out must not delete it.
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('ok')
  })
})

describe('start over leftovers', () => {
  test('clears a stale pid file and starts the service anyway', async () => {
    plantPidFile('ui', await reapedPid())
    const manager = makeManager()

    const started = await manager.start('ui')

    expect(started.kind).toBe('started')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('ok')

    await manager.stop('ui')
  })

  test('reports a spawn that never produced a process, with the reason node gave', async () => {
    const manager = makeManager({ execPath: join(dataDir, 'no-such-node') })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('could not be spawned')
    expect(started.reason).toContain('ENOENT')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
  })

  test('refuses to write a pid file for a child that has no pid', async () => {
    const pidless = {
      pid: undefined,
      on: () => pidless,
      once: () => pidless,
      unref: () => pidless,
      kill: () => true,
    }
    const manager = makeManager({ spawn: (() => pidless) as unknown as typeof spawn })

    const before = Date.now()
    const started = await manager.start('ui')
    const elapsed = Date.now() - before

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('was not spawned')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
    // The grace period is WAITED OUT rather than abandoned: an unref'd timer
    // here was the only pending work, so the CLI could exit 0 saying nothing.
    expect(elapsed).toBeGreaterThanOrEqual(SPAWN_FAILURE_GRACE_MS - TIMER_TOLERANCE_MS)
  })
})

describe('stop', () => {
  test('stops a running service, removes the pid file and frees the port', async () => {
    const manager = makeManager()
    const started = await manager.start('ui')
    if (started.kind !== 'started') throw new Error('start failed')

    const stopped = await manager.stop('ui')

    expect(stopped.kind).toBe('stopped')
    if (stopped.kind !== 'stopped') return
    expect(stopped.pid).toBe(started.status.pid)
    expect(stopped.forced).toBe(false)
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
    expect(await probeService('ui', config.ui.host, config.ui.port)).toBe(false)
    expect((await manager.status('ui')).state).toBe('stopped')
  })

  test('escalates to SIGKILL when the service ignores SIGTERM', async () => {
    const manager = makeManager({ env: { ...process.env, FAKE_IGNORE_SIGTERM: '1' } })
    await manager.start('ui')

    const stopped = await manager.stop('ui')

    expect(stopped.kind).toBe('stopped')
    if (stopped.kind !== 'stopped') return
    expect(stopped.forced).toBe(true)
    await waitUntil(() => !isProcessAlive(stopped.pid), 'the killed service to be gone')
  })

  test('reports nothing to stop when there is no pid file and nothing answers', async () => {
    const manager = makeManager({ spawn: refusingSpawn })

    expect((await manager.stop('serve')).kind).toBe('not-running')
  })

  test('refuses to claim a stop of a service it does not manage', async () => {
    await startForeignUi(config.ui.port)
    const manager = makeManager({ spawn: refusingSpawn })

    expect((await manager.stop('ui')).kind).toBe('external')
  })

  test('signals nothing when the install hands its services to another supervisor', async () => {
    const manager = makeManager({ config: { ...config, supervisor: 'external' }, spawn: refusingSpawn })

    expect((await manager.stop('ui')).kind).toBe('external')
  })

  test('clears the pid file when the process dies between the liveness check and the signal', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(child, 'spawn')
    const pid = child.pid
    if (pid === undefined) throw new Error('idle helper did not spawn')
    plantPidFile('ui', pid)
    // The probe is where the service dies: `status` has already found the pid
    // alive, so the stop that follows signals a pid that is gone.
    const probe = (async () => {
      child.kill('SIGKILL')
      await once(child, 'exit')
      return true
    }) as typeof probeService
    const manager = makeManager({ spawn: refusingSpawn, probe })

    const stopped = await manager.stop('ui')

    expect(stopped.kind).toBe('stale-cleared')
    if (stopped.kind !== 'stale-cleared') return
    expect(stopped.pid).toBe(pid)
    expect(stopped.detail).toContain('already gone')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
  })
})

describe('stale pid files', () => {
  test('calls a pid file whose process is gone stale and clears it on stop', async () => {
    plantPidFile('ui', await reapedPid())
    const manager = makeManager({ spawn: refusingSpawn })

    const status = await manager.status('ui')
    const stopped = await manager.stop('ui')

    expect(status.state).toBe('stale')
    expect(status.detail).toBeDefined()
    expect(stopped.kind).toBe('stale-cleared')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
  })

  test('calls an unreadable pid file stale and clears it on stop', async () => {
    mkdirSync(runDirFor(dataDir), { recursive: true, mode: JOURNAL_DIR_MODE })
    await writeFile(pidFilePathFor(dataDir, 'serve'), 'not json at all\n', { mode: JOURNAL_FILE_MODE })
    const manager = makeManager({ spawn: refusingSpawn })

    const status = await manager.status('serve')
    const stopped = await manager.stop('serve')

    expect(status.state).toBe('stale')
    expect(status.detail).toContain('not valid JSON')
    expect(stopped.kind).toBe('stale-cleared')
    if (stopped.kind !== 'stale-cleared') return
    expect(stopped.pid).toBeUndefined()
  })

  test('treats a young pid that has not answered yet as starting, not as stale', async () => {
    plantPidFile('ui', await startIdleProcess())
    const manager = makeManager({ spawn: refusingSpawn })

    expect((await manager.status('ui')).state).toBe('starting')
  })

  test('refuses to signal an old live pid that does not answer: it may be someone else now', async () => {
    const foreignPid = await startIdleProcess()
    const startedAt = new Date('2026-09-04T09:12:03.000Z')
    plantPidFile('ui', foreignPid, startedAt.toISOString())
    // A clock well past the readiness window: whatever holds this pid now, it
    // is not a service still coming up.
    const manager = makeManager({
      spawn: refusingSpawn,
      now: () => new Date(startedAt.getTime() + READY_TIMEOUT_MS * 10),
    })

    const status = await manager.status('ui')
    const stopped = await manager.stop('ui')

    expect(status.state).toBe('stale')
    expect(status.detail).toContain('not signalling it')
    expect(stopped.kind).toBe('stale-cleared')
    if (stopped.kind !== 'stale-cleared') return
    expect(stopped.pid).toBe(foreignPid)
    expect(stopped.detail).toContain('not signalling it')
    // The point of the rule: the foreign process is untouched.
    expect(isProcessAlive(foreignPid)).toBe(true)
  })
})

describe('logs', () => {
  test('prints the tail of the daemon log a start produced', async () => {
    const manager = makeManager()
    await manager.start('ui')

    const lines = await manager.logs('ui')

    expect(lines.join('\n')).toContain('listening on')

    await manager.stop('ui')
  })

  test('returns nothing for a service that has never run', async () => {
    expect(await makeManager({ spawn: refusingSpawn }).logs('serve')).toEqual([])
  })
})

describe('detachedSpawnOptions', () => {
  test('never hands a credential to a daemon: neither the owner nor an agent token', () => {
    const options = detachedSpawnOptions(
      7,
      { MCP_ADMIN_TOKEN: 'mcpa_secret', MCP_AGENT_TOKEN: 'mcpt_secret', PATH: '/usr/bin' },
      '/data',
    )

    expect(options.env).toEqual({ PATH: '/usr/bin', MCP_JOURNAL_DIR: '/data' })
  })

  test('binds the daemon to the data dir it was started for, overriding the ambient one', () => {
    // Otherwise the child resolves a DIFFERENT install than the one whose
    // `run/` holds its pid file: the manager would be reporting on one plane
    // and the daemon serving another.
    const options = detachedSpawnOptions(
      7,
      { MCPCUT_CONFIG: '/home/op/.mcpcut/config.json', MCP_JOURNAL_DIR: '/var/lib/elsewhere' },
      '/data',
    )

    expect(options.env).toEqual({
      MCPCUT_CONFIG: '/home/op/.mcpcut/config.json',
      MCP_JOURNAL_DIR: '/data',
    })
  })

  test('detaches the child and sends both its streams to the log file descriptor', () => {
    const options = detachedSpawnOptions(7, {}, '/data')

    expect(options.detached).toBe(true)
    expect(options.stdio).toEqual(['ignore', 7, 7])
    expect(options.cwd).toBe('/data')
  })
})

describe('detached survival', () => {
  test('a service outlives the process that started it', async () => {
    const logPath = join(dataDir, 'detached.log')
    const port = config.ui.port
    const driver = spawn(
      process.execPath,
      [START_AND_EXIT_PATH, FAKE_SERVICE_PATH, logPath, 'ui', '127.0.0.1', String(port)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let stdout = ''
    driver.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    const [code] = (await once(driver, 'exit')) as [number | null]
    expect(code).toBe(0)

    const pid = Number(stdout.trim())
    expect(Number.isInteger(pid)).toBe(true)
    onDispose(async () => {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    })

    // The parent is gone; the service it left behind still answers.
    await waitUntil(() => probeService('ui', '127.0.0.1', port), 'the orphaned service to answer')
    expect(isProcessAlive(pid)).toBe(true)

    process.kill(pid, 'SIGTERM')
    await waitUntil(() => !isProcessAlive(pid), 'the orphaned service to stop')
  })
})

/** Root ignores mode bits, so a permission test proves nothing there. */
const isRoot = process.getuid?.() === 0

describe('a start that gives up takes its child with it', () => {
  test('a service that ignores SIGTERM is gone by the time the readiness timeout resolves', async () => {
    // Arrange: a child that never answers and never obeys SIGTERM. The
    // escalation used to be an unref'd timer, so the CLI exited first and the
    // daemon simply stayed — holding the port against every later start.
    const manager = makeManager({
      env: { ...process.env, FAKE_SLOW_START_MS: '60000', FAKE_IGNORE_SIGTERM: '1' },
      readyTimeoutMs: 300,
      killEscalationMs: 200,
    })

    // Act
    const started = await manager.start('ui')

    // Assert: immediately, not after a wait — the promise is what carries the
    // guarantee, because nothing runs after it in a CLI.
    const pid = spawnedChildren.at(-1)?.pid
    if (pid === undefined) throw new Error('no child was spawned')
    expect(isProcessAlive(pid)).toBe(false)
    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('did not answer within 300 ms')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
  })

  test.skipIf(isRoot)(
    'terminates the child and leaves no pid file when the pid write itself fails',
    async () => {
      // Arrange: the run directory turns read-only in the window between the
      // spawn and the exclusive create, which is exactly where an EACCES,
      // ENOSPC or EIO would land in production.
      const runDir = runDirFor(dataDir)
      mkdirSync(runDir, { recursive: true, mode: JOURNAL_DIR_MODE })
      onDispose(() => chmod(runDir, JOURNAL_DIR_MODE))
      const manager = makeManager({
        spawn: trackingSpawn(() => {
          chmodSync(runDir, 0o500)
        }),
        env: { ...process.env, FAKE_SLOW_START_MS: '30000' },
      })

      // Act
      await expect(manager.start('ui')).rejects.toThrow()

      // Assert
      await chmod(runDir, JOURNAL_DIR_MODE)
      const pid = spawnedChildren.at(-1)?.pid
      if (pid === undefined) throw new Error('no child was spawned')
      expect(isProcessAlive(pid)).toBe(false)
      expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('absent')
    },
  )

  test('reports a lost race honestly when the winner is not actually up', async () => {
    // The winner's pid is already dead: calling that `already-running` and
    // exiting 0 would tell an operator the service is up when nothing is.
    const deadPid = await reapedPid()
    const manager = makeManager({
      spawn: trackingSpawn(() => {
        plantPidFile('ui', deadPid)
      }),
      env: { ...process.env, FAKE_SLOW_START_MS: '30000' },
    })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('another start won the pid file')
    const pid = spawnedChildren.at(-1)?.pid
    if (pid === undefined) throw new Error('no child was spawned')
    expect(isProcessAlive(pid)).toBe(false)
  })
})

describe('start refuses where clearing the pid file would orphan a process', () => {
  test('does not clear the pid file of a live but silent service, nor spawn a second copy', async () => {
    // The `stale` state has three causes, and this is the one where the pid is
    // ALIVE: the status text already says "stop it by hand", so clearing the
    // file and starting a duplicate contradicts the manager's own advice.
    const foreignPid = await startIdleProcess()
    const startedAt = new Date('2026-09-04T09:12:03.000Z')
    plantPidFile('ui', foreignPid, startedAt.toISOString())
    const manager = makeManager({
      spawn: refusingSpawn,
      now: () => new Date(startedAt.getTime() + READY_TIMEOUT_MS * 10),
    })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('not signalling it')
    expect((await readPidFile(pidFilePathFor(dataDir, 'ui'))).kind).toBe('ok')
    expect(isProcessAlive(foreignPid)).toBe(true)
  })

  test('still clears a pid file whose process is gone and starts the service', async () => {
    plantPidFile('ui', await reapedPid())
    const manager = makeManager()

    expect((await manager.start('ui')).kind).toBe('started')

    await manager.stop('ui')
  })
})

describe('a clock that moved backwards', () => {
  test('calls a record stamped in the future stale rather than forever starting', async () => {
    // A VM restore or an NTP step back makes `now - startedAt` negative, which
    // is LESS than the readiness window — so a one-sided comparison read every
    // live pid as `starting` for good, and `stop` would then signal it.
    const foreignPid = await startIdleProcess()
    const startedAt = new Date('2026-09-04T09:12:03.000Z')
    plantPidFile('ui', foreignPid, startedAt.toISOString())
    const manager = makeManager({
      spawn: refusingSpawn,
      now: () => new Date(startedAt.getTime() - READY_TIMEOUT_MS * 10),
    })

    const status = await manager.status('ui')
    const stopped = await manager.stop('ui')

    expect(status.state).toBe('stale')
    expect(status.detail).toContain('2026-09-04T09:12:03.000Z')
    expect(stopped.kind).toBe('stale-cleared')
    // The point of the rule: a foreign process is cleared from the file, never
    // signalled.
    expect(isProcessAlive(foreignPid)).toBe(true)
  })
})

describe('the run directory, the log and the pid file are owner-only or nothing', () => {
  test.skipIf(isRoot)('distrusts a pid file that is not owner-only, and clears it on stop', async () => {
    const foreignPid = await startIdleProcess()
    plantPidFile('ui', foreignPid)
    await chmod(pidFilePathFor(dataDir, 'ui'), 0o644)
    const manager = makeManager({ spawn: refusingSpawn })

    const status = await manager.status('ui')
    const stopped = await manager.stop('ui')

    expect(status.state).toBe('stale')
    expect(status.detail).toContain('owner-only')
    expect(stopped.kind).toBe('stale-cleared')
    expect(isProcessAlive(foreignPid)).toBe(true)
  })

  test.skipIf(isRoot)('refuses to start into a group- or world-accessible run directory', async () => {
    // Anyone who can write `run/` can plant a pid file and steer a later
    // `stop` at a pid of their choosing.
    const runDir = runDirFor(dataDir)
    mkdirSync(runDir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await chmod(runDir, 0o755)
    onDispose(() => chmod(runDir, JOURNAL_DIR_MODE))
    const manager = makeManager({ spawn: refusingSpawn })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain('run directory')
    expect(started.reason).toContain('755')
  })

  test('refuses to start when the log path is a symlink, rather than writing through it', async () => {
    // `O_NOFOLLOW`: a symlink planted at `run/ui.log` would otherwise let a
    // daemon append attacker-chosen bytes to any file this user can write.
    const runDir = runDirFor(dataDir)
    mkdirSync(runDir, { recursive: true, mode: JOURNAL_DIR_MODE })
    const target = join(dataDir, 'elsewhere.log')
    await writeFile(target, '', { mode: JOURNAL_FILE_MODE })
    symlinkSync(target, logFilePathFor(dataDir, 'ui'))
    const manager = makeManager({ spawn: refusingSpawn })

    const started = await manager.start('ui')

    expect(started.kind).toBe('failed')
    if (started.kind !== 'failed') return
    expect(started.reason).toContain(logFilePathFor(dataDir, 'ui'))
    expect(await readFile(target, 'utf8')).toBe('')
  })

  test('tightens a log an earlier run left world-readable', async () => {
    const runDir = runDirFor(dataDir)
    mkdirSync(runDir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await writeFile(logFilePathFor(dataDir, 'ui'), '', { mode: 0o644 })
    const manager = makeManager()

    await manager.start('ui')

    expect((await stat(logFilePathFor(dataDir, 'ui'))).mode & 0o777).toBe(JOURNAL_FILE_MODE)

    await manager.stop('ui')
  })
})
