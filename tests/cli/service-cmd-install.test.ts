import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runServiceCommand } from '../../src/cli/service-cmd.js'
import { RUN_DIR_NAME } from '../../src/services/constants.js'
import type { ServiceManagerDeps } from '../../src/services/manager.js'
import { DATA_DIR_ENV_VAR, SUPERVISOR_ENV_VAR } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'

/**
 * Where `mcpcut start|stop|status|logs` reads its install from: the data
 * directory the verbs act on, and the supervisor that decides whether they act
 * at all. Both are resolved from the environment and the config together, so
 * both are proven against the REAL manager — an injected one would prove only
 * that the fake was called.
 */

const FAKE_SERVICE_PATH = fileURLToPath(new URL('../fixtures/fake-service.mjs', import.meta.url))
const CONFIG_PATH = '/home/op/.mcpcut/config.json'
const READY_TIMEOUT_MS = 5_000

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

/**
 * Which data directory the four verbs act on (TS-H3 / SEC-M5).
 *
 * Everything else in the plane ranks `MCP_JOURNAL_DIR` above the config file;
 * these commands used to read `config.dataDir` alone. An operator with the
 * variable exported would then have `setup` prepare one directory while the
 * daemons served another — and the `ui` that came up in the second one would
 * bootstrap a second owner and print its token into `run/ui.log`.
 */
describe('the data directory the services are managed in', () => {
  let configDir: string
  let envDir: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mcpcut-service-cfg-'))
    envDir = await mkdtemp(join(tmpdir(), 'mcpcut-service-env-'))
  })

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true })
    await rm(envDir, { recursive: true, force: true })
  })

  /** Puts one line in `<dir>/run/ui.log`, the file `logs ui` prints from. */
  async function writeUiLog(dir: string, line: string): Promise<void> {
    await mkdir(join(dir, RUN_DIR_NAME), { recursive: true, mode: 0o700 })
    await writeFile(join(dir, RUN_DIR_NAME, 'ui.log'), `${line}\n`, 'utf8')
  }

  test('MCP_JOURNAL_DIR outranks the config, as it does everywhere else', async () => {
    await writeUiLog(configDir, 'from the config directory')
    await writeUiLog(envDir, 'from the environment directory')
    const io = fakeIo()

    const exitCode = await runServiceCommand('logs', ['ui'], io, {
      install: { kind: 'ok', path: CONFIG_PATH, config: defaultInstallConfig(configDir) },
      env: { [DATA_DIR_ENV_VAR]: envDir },
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('from the environment directory')
    expect(io.out()).not.toContain('from the config directory')
  })

  test('the config answers when nothing is exported', async () => {
    await writeUiLog(configDir, 'from the config directory')
    const io = fakeIo()

    await runServiceCommand('logs', ['ui'], io, {
      install: { kind: 'ok', path: CONFIG_PATH, config: defaultInstallConfig(configDir) },
      env: {},
    })

    expect(io.out()).toContain('from the config directory')
  })

  test('an explicit journalDir still outranks both', async () => {
    await writeUiLog(envDir, 'from the environment directory')
    await writeUiLog(configDir, 'from the config directory')
    const io = fakeIo()

    await runServiceCommand('logs', ['ui'], io, {
      install: { kind: 'ok', path: CONFIG_PATH, config: defaultInstallConfig(envDir) },
      env: { [DATA_DIR_ENV_VAR]: envDir },
      journalDir: configDir,
    })

    expect(io.out()).toContain('from the config directory')
  })
})

/**
 * `MCPCUT_SUPERVISOR` (SEC-M3): the variable was declared and documented from
 * the first wave and never read, so a container that set it still got a CLI
 * willing to spawn a second copy of every daemon compose already runs.
 */
describe('MCPCUT_SUPERVISOR', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-service-sup-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  function installFor(): InstallConfigLoad {
    return { kind: 'ok', path: CONFIG_PATH, config: defaultInstallConfig(dataDir) }
  }

  test('external turns start into a report, and nothing is spawned', async () => {
    const io = fakeIo()
    const spawned: string[] = []
    const recordingSpawn = ((command: string) => {
      spawned.push(command)
      throw new Error('nothing may be spawned under supervisor: external')
    }) as unknown as NonNullable<ServiceManagerDeps['spawn']>

    const exitCode = await runServiceCommand('start', [], io, {
      install: installFor(),
      env: { [SUPERVISOR_ENV_VAR]: 'external' },
      managerDeps: {
        spawn: recordingSpawn,
        cliPath: FAKE_SERVICE_PATH,
        readyTimeoutMs: READY_TIMEOUT_MS,
      },
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('external')
    expect(spawned).toEqual([])
  })

  test('a value outside the closed list refuses the command instead of guessing', async () => {
    const io = fakeIo()

    const exitCode = await runServiceCommand('status', [], io, {
      install: installFor(),
      env: { [SUPERVISOR_ENV_VAR]: 'systemd' },
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('MCPCUT_SUPERVISOR')
    expect(io.err()).toContain('systemd')
    expect(io.out()).toBe('')
  })
})
