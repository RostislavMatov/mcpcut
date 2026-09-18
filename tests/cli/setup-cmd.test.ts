import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootstrapTokenPathFor } from '../../src/admin/bootstrap-file.js'
import { ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runSetupCommand } from '../../src/cli/setup-cmd.js'
import type { SetupArgs } from '../../src/cli/setup-args.js'
import { TOKEN_ONCE_NOTICE, TOKEN_STDOUT_REDIRECT_WARNING } from '../../src/cli/ui-constants.js'
import { SIGNING_KEY_FILENAME, SIGNING_PUB_FILENAME } from '../../src/journal/signing.js'
import { createServiceManager } from '../../src/services/manager.js'
import {
  CHECK_NAME_COLUMN,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DATA_DIR_ENV_VAR,
} from '../../src/setup/constants.js'
import { installConfigSchema } from '../../src/setup/schema.js'
import { valuesOf } from '../../src/tui/form.js'
import { setupArgvOf, WIZARD_FIELD, wizardScreenOf } from '../../src/tui/wizard-fields.js'
import { VAULT_KEY_FILE_NAME } from '../../src/vault/constants.js'

/**
 * `mcpcut setup --yes` (phase 1, Task 14): the one command that turns a bare
 * host into an install — a config on disk, a prepared data directory, a
 * vault, a signing key and an owner whose token is printed once.
 *
 * Real filesystem throughout, and a real `fake-service.mjs` for `--start`.
 * The two properties worth proving here cannot be mocked: that a refused run
 * leaves NOTHING behind (owner decision: the checks come before the write),
 * and that a second run over its own output is a no-op rather than a second
 * owner (C6 — the token exists exactly once).
 */

const FAKE_SERVICE_PATH = fileURLToPath(new URL('../fixtures/fake-service.mjs', import.meta.url))

/** Long enough for a node boot on a loaded box; the manager's own default is far longer. */
const READY_TIMEOUT_MS = 5_000
/** A probe against a socket that accepts and never answers costs its full timeout. */
const SLOW_PROBE_TEST_TIMEOUT_MS = 20_000

const cleanups: Array<() => Promise<void>> = []

let home: string
let dataDir: string
/**
 * The environment every run sees: empty. `installConfigPath` then resolves to
 * `<home>/.mcpcut/config.json`, `MCP_ADMIN_TOKEN` cannot leak in from the
 * developer's shell, and a spawned daemon inherits nothing of the machine.
 */
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mcpcut-setup-home-'))
  dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-setup-data-'))
  env = {}
  onDispose(() => rm(home, { recursive: true, force: true }))
  onDispose(() => rm(dataDir, { recursive: true, force: true }))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

function onDispose(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
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

/** A port nothing holds: bind an ephemeral one, learn its number, give it back. */
async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * Holds `port` for the duration of one test, so a bind check has something to
 * trip over. Every accepted socket is destroyed on the way out: the UI probe
 * opens one and never gets an answer, and `net.Server#close` waits for open
 * connections — a cleanup that only called `close` would hang the suite.
 */
async function holdPort(port: number): Promise<void> {
  const sockets: Socket[] = []
  const server = createNetServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  onDispose(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
}

/**
 * The name column of one report row. Sliced by width, not split on runs of
 * spaces: `serve exposure` fills the column exactly and leaves a single space
 * before its level, which a whitespace split would swallow the level into.
 */
function checkNameOf(line: string): string {
  const prefix = 'check  '
  return line.slice(prefix.length, prefix.length + CHECK_NAME_COLUMN).trim()
}

function configPathOf(): string {
  return join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}

async function readConfig(): Promise<unknown> {
  return JSON.parse(await readFile(configPathOf(), 'utf8'))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The flags every green run needs: a data directory and two ports nobody holds. */
async function fullRunArgs(extra: readonly string[] = []): Promise<string[]> {
  return [
    '--yes',
    '--data-dir',
    dataDir,
    '--ui-port',
    String(await freePort()),
    '--serve-port',
    String(await freePort()),
    ...extra,
  ]
}

describe('setup without --yes', () => {
  test('refuses outside a terminal, naming both ways forward, and prints the synopsis', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand([], io, { env, home, isTty: false })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('needs a terminal')
    expect(io.err()).toContain('mcpcut setup --yes')
    expect(io.out()).toBe('')
    expect(await exists(configPathOf())).toBe(false)
  })

  test('refuses on a terminal too when no wizard was wired in', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand([], io, { env, home, isTty: true })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('needs a terminal')
    expect(await exists(configPathOf())).toBe(false)
  })

  test('on a terminal it hands the parsed flags to the wizard and answers with its code', async () => {
    const io = fakeIo()
    const asked: SetupArgs[] = []

    const exitCode = await runSetupCommand(['--ui-port', '18091'], io, {
      env,
      home,
      isTty: true,
      wizard: async (args) => {
        asked.push(args)
        return 5
      },
    })

    expect(exitCode).toBe(5)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ yes: false, uiPort: 18091 })
    expect(io.err()).toBe('')
    expect(await exists(configPathOf())).toBe(false)
  })

  test('refuses a malformed invocation before it asks anything of the host', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(['--yes', '--nope'], io, { env, home })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--nope')
    expect(await exists(configPathOf())).toBe(false)
  })
})

describe('setup --yes: the first run of an install', () => {
  test('writes a 0600 config, prepares the data dir, and mints one owner whose token is printed once', async () => {
    const io = fakeIo()
    const args = await fullRunArgs(['--admin', 'owner'])

    const exitCode = await runSetupCommand(args, io, { env, home })

    expect(io.err()).toBe('')
    expect(exitCode).toBe(0)

    // The config, exactly as the schema will read it back.
    const mode = (await stat(configPathOf())).mode & 0o777
    expect(mode).toBe(0o600)
    const written = installConfigSchema.parse(await readConfig())
    expect(written.dataDir).toBe(dataDir)
    expect(written.ui.host).toBe('127.0.0.1')
    expect(String(written.ui.port)).toBe(args[args.indexOf('--ui-port') + 1])
    expect(String(written.serve.port)).toBe(args[args.indexOf('--serve-port') + 1])
    expect(io.out()).toContain(`setup: config written to ${configPathOf()}`)

    // Every secret-bearing artefact of an install exists after one command.
    expect(await exists(join(dataDir, VAULT_KEY_FILE_NAME))).toBe(true)
    expect(await exists(join(dataDir, SIGNING_KEY_FILENAME))).toBe(true)
    expect(await exists(join(dataDir, SIGNING_PUB_FILENAME))).toBe(true)

    const admins = await createAdminStore({ journalDir: dataDir }).listAdmins()
    expect(admins.map((admin) => [admin.name, admin.role])).toEqual([['owner', 'owner']])

    // C6: the token reaches a human on stdout, once, with both notices — and
    // never a daemon log, because the owner exists before any daemon does.
    expect(io.out()).toMatch(new RegExp(`token: ${ADMIN_TOKEN_PREFIX}`))
    expect(io.out()).toContain(TOKEN_ONCE_NOTICE)
    expect(io.out()).toContain(TOKEN_STDOUT_REDIRECT_WARNING)
  })

  test('prints the whole preflight, in order, before it writes anything', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, { env, home })

    expect(exitCode).toBe(0)
    const checkLines = io
      .out()
      .split('\n')
      .filter((line) => line.startsWith('check  '))
    expect(checkLines.map(checkNameOf)).toEqual([
      'data dir',
      'run dir',
      'ui bind',
      'serve bind',
      'databases',
      'policy',
      'ui exposure',
      'serve exposure',
    ])
    // The report precedes the write, so a refusal can never have written one.
    const out = io.out()
    expect(out.indexOf('check  serve exposure')).toBeLessThan(out.indexOf('setup: config written'))
  })

  test('names the vault key and the signing key it created', async () => {
    const io = fakeIo()

    await runSetupCommand(await fullRunArgs(), io, { env, home })

    expect(io.out()).toContain(`vault: initialized ${join(dataDir, VAULT_KEY_FILE_NAME)}`)
    expect(io.out()).toContain(`Signing key written to: ${join(dataDir, SIGNING_KEY_FILENAME)}`)
    expect(io.out()).toContain('-----BEGIN PUBLIC KEY-----')
  })

  test('defaults the owner name when --admin is not given', async () => {
    const io = fakeIo()

    await runSetupCommand(await fullRunArgs(), io, { env, home })

    const admins = await createAdminStore({ journalDir: dataDir }).listAdmins()
    expect(admins.map((admin) => admin.name)).toEqual(['owner'])
  })

  test('resolves a relative --data-dir against the working directory, never the home', async () => {
    const io = fakeIo()
    const args = ['--yes', '--data-dir', 'plane-data', '--ui-port', String(await freePort()), '--serve-port', String(await freePort())]

    const exitCode = await runSetupCommand(args, io, { env, home, cwd: home })

    expect(exitCode).toBe(0)
    const written = installConfigSchema.parse(await readConfig())
    expect(written.dataDir).toBe(join(home, 'plane-data'))
    expect(await exists(join(home, 'plane-data', VAULT_KEY_FILE_NAME))).toBe(true)
  })

  test('warns about a bind reachable from the network and still completes', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--ui-host', '0.0.0.0']), io, {
      env,
      home,
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('check  ui exposure    warn')
    expect(io.out()).toContain('reachable from the network')
    expect(io.out()).toContain('setup: config written to')
  })
})

describe('setup --yes: the overlay rule', () => {
  test('a rerun keeps every setting it was not asked about', async () => {
    const args = await fullRunArgs(['--behind-tls'])
    expect(await runSetupCommand(args, fakeIo(), { env, home })).toBe(0)

    const io = fakeIo()
    const exitCode = await runSetupCommand(['--yes', '--ui-port', String(await freePort())], io, {
      env,
      home,
    })

    expect(exitCode).toBe(0)
    const written = installConfigSchema.parse(await readConfig())
    // Neither the data dir nor the TLS claim was mentioned this time; both survive.
    expect(written.dataDir).toBe(dataDir)
    expect(written.ui.behindTls).toBe(true)
    expect(String(written.serve.port)).toBe(args[args.indexOf('--serve-port') + 1])
  })

  test('a rerun with --no-behind-tls writes the false that takes the claim back', async () => {
    // Arrange: an install that once claimed TLS in front of it.
    expect(await runSetupCommand(await fullRunArgs(['--behind-tls']), fakeIo(), { env, home })).toBe(0)
    expect(installConfigSchema.parse(await readConfig()).ui.behindTls).toBe(true)

    // Act: the claim is withdrawn from the CLI, not by hand-editing the file.
    const io = fakeIo()
    const exitCode = await runSetupCommand(['--yes', '--no-behind-tls'], io, { env, home })

    // Assert
    expect(exitCode).toBe(0)
    expect(installConfigSchema.parse(await readConfig()).ui.behindTls).toBe(false)
  })

  test('writes probeHost from its flags, and the wizard\'s full-argv rerun keeps it', async () => {
    expect(
      await runSetupCommand(
        await fullRunArgs(['--ui-probe-host', 'ui', '--serve-probe-host', 'serve']),
        fakeIo(),
        { env, home },
      ),
    ).toBe(0)
    expect(installConfigSchema.parse(await readConfig()).serve.probeHost).toBe('serve')

    // The wizard never asks about probeHost: its argv states every field it
    // does ask about and relies on the overlay for the rest.
    const config = installConfigSchema.parse(await readConfig())
    const form = wizardScreenOf({ mode: 'edit', configPath: configPathOf(), config }).form
    const values = { ...valuesOf(form), [WIZARD_FIELD.admin]: 'owner' }
    // `setupArgvOf` starts with the command word; `runSetupCommand` takes what follows it.
    const wizardArgv = setupArgvOf(values).slice(1)
    const exitCode = await runSetupCommand(wizardArgv, fakeIo(), { env, home })

    expect(exitCode).toBe(0)
    const written = installConfigSchema.parse(await readConfig())
    expect(written.ui.probeHost).toBe('ui')
    expect(written.serve.probeHost).toBe('serve')
  })

  test('honours an injected config load and an injected config path', async () => {
    const elsewhere = join(home, 'somewhere', 'install.json')
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, {
      env,
      home,
      configPath: elsewhere,
      install: { kind: 'absent', path: elsewhere },
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(`setup: config written to ${elsewhere}`)
    expect(await exists(elsewhere)).toBe(true)
    expect(await exists(configPathOf())).toBe(false)
  })
})

describe('setup --yes: a config the schema refuses', () => {
  test('refuses an empty host, names the field, and writes nothing', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--ui-host', '']), io, { env, home })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('ui.host')
    expect(io.out()).toBe('')
    expect(await exists(configPathOf())).toBe(false)
  })
})

describe('setup --yes: an admin name the store refuses', () => {
  test('refuses it the way "admin add" would, and creates nothing', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--admin', 'Not A Name']), io, {
      env,
      home,
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('invalid admin name')
    expect(await createAdminStore({ journalDir: dataDir }).listAdmins()).toEqual([])
  })
})

describe('setup --yes: a second run over its own output', () => {
  test('is idempotent: no second owner, no second key, and the config is rewritten cleanly', async () => {
    const first = fakeIo()
    const args = await fullRunArgs(['--admin', 'owner'])
    expect(await runSetupCommand(args, first, { env, home })).toBe(0)

    const second = fakeIo()
    const exitCode = await runSetupCommand(args, second, { env, home })

    expect(exitCode).toBe(0)
    expect(second.out()).toContain('vault: already initialized')
    expect(second.out()).toContain('signing key: already present')
    expect(second.out()).toContain('admin: 1 admin(s) exist, none created')
    expect(second.out()).not.toContain(`token: ${ADMIN_TOKEN_PREFIX}`)
    expect(second.err()).toBe('')

    const admins = await createAdminStore({ journalDir: dataDir }).listAdmins()
    expect(admins).toHaveLength(1)
    expect(await exists(configPathOf())).toBe(true)
  })
})

describe('setup --yes: a check that fails', () => {
  test(
    'refuses on an occupied port and leaves no config, no vault and no admin behind',
    async () => {
      const uiPort = await freePort()
      await holdPort(uiPort)
      const io = fakeIo()

      const exitCode = await runSetupCommand(
        ['--yes', '--data-dir', dataDir, '--ui-port', String(uiPort), '--serve-port', String(await freePort())],
        io,
        { env, home },
      )

      expect(exitCode).toBe(1)
      expect(io.out()).toContain('check  ui bind')
      expect(io.out()).toMatch(/check {2}ui bind {8}fail/)
      expect(io.out()).not.toContain('setup: config written')
      expect(await exists(configPathOf())).toBe(false)
      expect(await exists(join(dataDir, VAULT_KEY_FILE_NAME))).toBe(false)
      expect(await exists(join(dataDir, SIGNING_KEY_FILENAME))).toBe(false)
      expect(await createAdminStore({ journalDir: dataDir }).listAdmins()).toEqual([])
    },
    SLOW_PROBE_TEST_TIMEOUT_MS,
  )
})

describe('setup --yes: an install config this build cannot read', () => {
  async function writeBrokenConfig(): Promise<void> {
    await mkdir(join(home, CONFIG_DIR_NAME), { recursive: true, mode: 0o700 })
    await writeFile(configPathOf(), '{', 'utf8')
  }

  test('refuses without --force and lists what is wrong with the file', async () => {
    await writeBrokenConfig()
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, { env, home })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(configPathOf())
    expect(io.err()).toContain('not valid JSON')
    expect(io.err()).toContain('--force')
    expect(await readFile(configPathOf(), 'utf8')).toBe('{')
  })

  test('rewrites it with --force', async () => {
    await writeBrokenConfig()
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--force']), io, { env, home })

    expect(exitCode).toBe(0)
    const written = installConfigSchema.parse(await readConfig())
    expect(written.dataDir).toBe(dataDir)
  })
})

describe('setup --yes --no-admin', () => {
  test('creates no admin and warns that the first ui start will write a token file', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--no-admin']), io, { env, home })

    expect(exitCode).toBe(0)
    expect(await createAdminStore({ journalDir: dataDir }).listAdmins()).toEqual([])
    expect(io.out()).not.toContain(`token: ${ADMIN_TOKEN_PREFIX}`)
    // Phase 6 (F6): the warning names the one-time token file, not the daemon log.
    expect(io.err()).toContain(bootstrapTokenPathFor(dataDir))
    expect(io.err()).not.toContain(join(dataDir, 'run', 'ui.log'))
    expect(io.err()).toContain('owner')
  })
})

/**
 * `MCP_JOURNAL_DIR` outranks the config for every other command (TS-H3 /
 * SEC-M5). `setup` cannot honour it and cannot ignore it: honouring it would
 * write a config whose `dataDir` the operator did not ask for, ignoring it
 * would prepare one directory while every later command uses another — vault,
 * signing key and owner in one plane, daemons serving a second one, and a `ui`
 * bootstrapping its own owner into `run/ui.log`. So it refuses.
 */
describe('setup --yes with MCP_JOURNAL_DIR exported', () => {
  test('refuses when the variable and the config disagree, naming both paths', async () => {
    const io = fakeIo()
    const exported = join(home, 'elsewhere')

    const exitCode = await runSetupCommand(await fullRunArgs(), io, {
      env: { [DATA_DIR_ENV_VAR]: exported },
      home,
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(exported)
    expect(io.err()).toContain(dataDir)
    expect(io.err()).toContain(`unset ${DATA_DIR_ENV_VAR}`)
    expect(io.err()).toContain(`--data-dir ${exported}`)
    // Refused before the first check: nothing on the host was touched.
    expect(io.out()).toBe('')
    expect(await exists(configPathOf())).toBe(false)
  })

  test('proceeds when the variable names the very directory the config will carry', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, {
      env: { [DATA_DIR_ENV_VAR]: dataDir },
      home,
    })

    expect(exitCode).toBe(0)
    expect(io.err()).toBe('')
    expect(installConfigSchema.parse(await readConfig()).dataDir).toBe(dataDir)
  })

  test('an empty variable is not a value and does not refuse anything', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, {
      env: { [DATA_DIR_ENV_VAR]: '' },
      home,
    })

    expect(exitCode).toBe(0)
  })
})

/**
 * The preflight reports `run/` because the manager refuses to start a service
 * when that directory is not owner-only (SEC-H1). Learning it from `setup` is
 * the difference between one refusal and two.
 */
describe('setup --yes: the run directory row', () => {
  test('fails the preflight on a run directory other accounts can read', async () => {
    const runDir = join(dataDir, 'run')
    await mkdir(runDir, { recursive: true })
    await chmod(runDir, 0o755)
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, { env, home })

    expect(exitCode).toBe(1)
    expect(io.out()).toMatch(/check {2}run dir {8}fail/)
    expect(io.out()).toContain('0755')
    expect(io.out()).not.toContain('setup: config written')
    expect(await exists(configPathOf())).toBe(false)
  })
})

/**
 * Faults of the host, not of the plane (LOW 2). `setup` writes files in three
 * places; an errno from any of them is an operator's situation and gets a
 * line, the boundary `service-cmd.ts` already draws.
 */
describe('setup --yes: a host fault while writing', () => {
  test('reports an errno as a line instead of a stack trace', async () => {
    const notADirectory = join(home, 'not-a-dir')
    await writeFile(notADirectory, 'x', 'utf8')
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(), io, {
      env,
      home,
      configPath: join(notADirectory, 'config.json'),
      install: { kind: 'absent', path: join(notADirectory, 'config.json') },
    })

    expect(exitCode).toBe(1)
    // `setup: <errno>: <what the platform said>` — one line, and never twice
    // the same code. (A regular file where the config directory should be is
    // EEXIST from `mkdir`, not ENOTDIR: the fault is the name, not the path.)
    expect(io.err()).toMatch(/^setup: EEXIST: file already exists/m)
    expect(io.err()).not.toContain('    at ')
  })
})

describe('setup --yes --start', () => {
  test('starts both services and reports each of them', async () => {
    const io = fakeIo()
    const args = await fullRunArgs(['--start'])

    const exitCode = await runSetupCommand(args, io, {
      env,
      home,
      managerDeps: { cliPath: FAKE_SERVICE_PATH, readyTimeoutMs: READY_TIMEOUT_MS },
    })

    // Registered before the assertions: a green start leaves two detached
    // processes behind, and a failing assertion must not leak them.
    onDispose(async () => {
      const config = installConfigSchema.parse(JSON.parse(await readFile(configPathOf(), 'utf8')))
      const manager = createServiceManager({
        dataDir: config.dataDir,
        config,
        env,
        cliPath: FAKE_SERVICE_PATH,
      })
      await manager.stop('ui')
      await manager.stop('serve')
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/ui: {4}started pid \d+ on http:\/\/127\.0\.0\.1:\d+/)
    expect(io.out()).toMatch(/serve: started pid \d+ on http:\/\/127\.0\.0\.1:\d+/)
  })

  test('exits 1 when the platform cannot run detached services at all', async () => {
    const io = fakeIo()

    const exitCode = await runSetupCommand(await fullRunArgs(['--start']), io, {
      env,
      home,
      managerDeps: { platform: 'win32' },
    })

    // `unsupported` is not `failed`, but it is just as much "the services the
    // operator asked for are not running" — `service-cmd.ts` counts it so too.
    expect(exitCode).toBe(1)
    expect(io.out()).toContain('unsupported')
  })

  test('starts nothing when the install hands its services to another supervisor', async () => {
    const io = fakeIo()
    const spawned: string[] = []
    const recordingSpawn = ((command: string) => {
      spawned.push(command)
      throw new Error('setup must not spawn under supervisor: external')
    }) as unknown as Parameters<typeof createServiceManager>[0]['spawn']

    const exitCode = await runSetupCommand(
      await fullRunArgs(['--start', '--supervisor', 'external']),
      io,
      { env, home, ...(recordingSpawn !== undefined ? { managerDeps: { spawn: recordingSpawn } } : {}) },
    )

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('services: managed externally (supervisor: external), not started')
    expect(spawned).toEqual([])
    const written = installConfigSchema.parse(await readConfig())
    expect(written.supervisor).toBe('external')
  })

  test('a rerun while the services are up reports their ports as already running, not as a clash', async () => {
    const args = await fullRunArgs(['--start'])
    const managerDeps = { cliPath: FAKE_SERVICE_PATH, readyTimeoutMs: READY_TIMEOUT_MS }
    onDispose(async () => {
      const config = installConfigSchema.parse(JSON.parse(await readFile(configPathOf(), 'utf8')))
      const manager = createServiceManager({ dataDir: config.dataDir, config, env, cliPath: FAKE_SERVICE_PATH })
      await manager.stop('ui')
      await manager.stop('serve')
    })
    expect(await runSetupCommand(args, fakeIo(), { env, home, managerDeps })).toBe(0)

    const io = fakeIo()
    const exitCode = await runSetupCommand(args, io, { env, home, managerDeps })

    // The install's own daemons hold those ports; a bind check that called
    // that a conflict would make every rerun on a live install fail.
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('(already running)')
    expect(io.out()).not.toMatch(/check {2}(ui|serve) bind\s+fail/)
    expect(io.out()).toContain('already running pid')
  })
})
