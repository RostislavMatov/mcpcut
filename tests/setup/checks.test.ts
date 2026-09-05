import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_DIR_MODE } from '../../src/config.js'
import { openStateDbShared } from '../../src/policy/store-backend.js'
import { checkBindExposure, checkPortFree } from '../../src/setup/bind-checks.js'
import {
  checkDataDir,
  checkDatabases,
  checkPolicy,
  checkRunDir,
  formatCheck,
} from '../../src/setup/checks.js'
import { RUN_DIR_NAME } from '../../src/services/constants.js'
import { WRITE_PROBE_FILE_NAME } from '../../src/setup/constants.js'
import { writeCorruptDatabase } from '../support/corrupt-db.js'

/**
 * The `setup` preflight (phase 1, task 13). Real directories, real sockets,
 * real databases: every one of these checks exists to answer a question about
 * the host the plane is about to run on, and a mocked filesystem or a mocked
 * socket would answer a question about the mock instead.
 */

let root: string
const openServers: Server[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpcut-checks-'))
})

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer))
  await rm(root, { recursive: true, force: true })
})

/** Binds an ephemeral port on `host` and registers the server for teardown. */
async function listenOn(host: string): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer()
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address')
  }
  return { server, port: address.port }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

/** A port nothing listens on: bound to learn the number, then released. */
async function freePort(host: string): Promise<number> {
  const { server, port } = await listenOn(host)
  await closeServer(server)
  return port
}

function modeOf(mode: number): number {
  return mode & 0o777
}

describe('checkDataDir', () => {
  test('creates a missing data directory owner-only and reports the mode it has', async () => {
    const dir = join(root, 'data')

    const result = await checkDataDir(dir)

    expect(result).toEqual({ name: 'data dir', level: 'ok', detail: `${dir} (0700)` })
    expect(modeOf((await stat(dir)).mode)).toBe(JOURNAL_DIR_MODE)
  })

  test('leaves no write probe behind after proving the directory is writable', async () => {
    const dir = join(root, 'data')

    await checkDataDir(dir)

    expect(await readdir(dir)).toEqual([])
    expect(await readdir(dir)).not.toContain(WRITE_PROBE_FILE_NAME)
  })

  test('warns, naming the actual mode, when an existing directory is readable by other accounts', async () => {
    const dir = join(root, 'loose')
    await mkdir(dir)
    await chmod(dir, 0o755)

    const result = await checkDataDir(dir)

    expect(result.level).toBe('warn')
    expect(result.detail).toContain('0755')
    expect(result.detail).toContain('0700')
    expect(result.detail).toContain(dir)
  })

  test('fails with the errno when the path cannot become a directory', async () => {
    const file = join(root, 'not-a-dir')
    await writeFile(file, 'x', 'utf8')

    const result = await checkDataDir(join(file, 'data'))

    expect(result.level).toBe('fail')
    expect(result.detail).toContain('ENOTDIR')
    expect(result.name).toBe('data dir')
  })

  test('never follows a planted write probe: the symlink target keeps its contents', async () => {
    const dir = join(root, 'data')
    await mkdir(dir, { mode: 0o700 })
    const victim = join(root, 'precious.txt')
    await writeFile(victim, 'keep me', 'utf8')
    await symlink(victim, join(dir, WRITE_PROBE_FILE_NAME))

    const result = await checkDataDir(dir)

    // An `open(..., 'wx')` refuses an existing name — including a symlink —
    // instead of truncating whatever it points at.
    expect(await readFile(victim, 'utf8')).toBe('keep me')
    expect(result.level).toBe('fail')
    expect(result.detail).toContain(WRITE_PROBE_FILE_NAME)
  })
})

describe('checkPortFree', () => {
  test('reports a port nothing listens on as free', async () => {
    const port = await freePort('127.0.0.1')

    const result = await checkPortFree('ui', '127.0.0.1', port)

    expect(result).toEqual({ name: 'ui bind', level: 'ok', detail: `127.0.0.1:${port} free` })
  })

  test("fails in the plane's own bind wording when the port is already taken", async () => {
    const { port } = await listenOn('127.0.0.1')

    const result = await checkPortFree('serve', '127.0.0.1', port)

    expect(result.name).toBe('serve bind')
    expect(result.level).toBe('fail')
    expect(result.detail).toContain('address already in use')
    expect(result.detail).toContain(`127.0.0.1:${port}`)
    expect(result.detail).not.toContain('\n')
  })

  test('treats port 0 as the ephemeral port and binds nothing to check it', async () => {
    const result = await checkPortFree('ui', '127.0.0.1', 0)

    expect(result).toEqual({ name: 'ui bind', level: 'ok', detail: 'ephemeral' })
  })

  test('gives up instead of hanging when the bind never answers', async () => {
    // `--ui-host <name>` makes `listen()` resolve DNS first, and a resolver
    // that never answers would otherwise stall the whole preflight.
    const stalling = (() => ({
      once: () => undefined,
      listen: () => undefined,
      close: (callback?: () => void) => callback?.(),
    })) as unknown as () => Server

    const result = await checkPortFree('ui', 'name.example', 8091, {
      timeoutMs: 20,
      createServer: stalling,
    })

    expect(result.level).toBe('fail')
    expect(result.detail).toContain('name.example:8091')
    expect(result.detail).toContain('20ms')
  })
})

/**
 * `<data dir>/run` holds the pid files and the daemon logs, and the manager
 * refuses to start a service when that directory is readable by other accounts
 * (SEC-H1). `setup` must surface the same condition first: an operator whose
 * `run/` is 0755 should learn it from the preflight, not from a start that
 * refuses minutes later.
 */
describe('checkRunDir', () => {
  test('reports a data directory with no run directory yet as fine', async () => {
    const result = await checkRunDir(root)

    expect(result).toEqual({
      name: 'run dir',
      level: 'ok',
      detail: 'not yet (created on first start)',
    })
  })

  test('reports an owner-only run directory with its path and mode', async () => {
    const runDir = join(root, RUN_DIR_NAME)
    await mkdir(runDir, { mode: 0o700 })

    const result = await checkRunDir(root)

    expect(result).toEqual({ name: 'run dir', level: 'ok', detail: `${runDir} (0700)` })
  })

  test('fails on a run directory other accounts can read, naming the path and the mode', async () => {
    const runDir = join(root, RUN_DIR_NAME)
    await mkdir(runDir, { mode: 0o700 })
    await chmod(runDir, 0o755)

    const result = await checkRunDir(root)

    expect(result.name).toBe('run dir')
    expect(result.level).toBe('fail')
    expect(result.detail).toContain(runDir)
    expect(result.detail).toContain('0755')
  })

  test('fails when the run directory belongs to another account', async () => {
    const runDir = join(root, RUN_DIR_NAME)
    await mkdir(runDir, { mode: 0o700 })
    const foreignUid = (process.getuid?.() ?? 0) + 1

    const result = await checkRunDir(root, () => foreignUid)

    expect(result.level).toBe('fail')
    expect(result.detail).toContain(runDir)
    expect(result.detail).toContain('another account')
  })
})

describe('checkDatabases', () => {
  test('reports a data directory with no databases as one that has none yet', async () => {
    const result = await checkDatabases(root)

    expect(result).toEqual({
      name: 'databases',
      level: 'ok',
      detail: 'none yet (created on first start)',
    })
    expect(await readdir(root)).toEqual([])
  })

  test('names the database it verified when the one present is healthy', async () => {
    await openStateDbShared(join(root, 'state.db'))

    const result = await checkDatabases(root)

    expect(result.level).toBe('ok')
    expect(result.detail).toContain('state.db')
    expect(result.detail).not.toContain('journal.db')
  })

  test('fails with the integrity error when a database on disk is damaged', async () => {
    await writeCorruptDatabase(join(root, 'state.db'))

    const result = await checkDatabases(root)

    expect(result.name).toBe('databases')
    expect(result.level).toBe('fail')
    expect(result.detail).toContain('state.db')
    expect(result.detail).toContain('integrity_check')
  })
})

describe('checkPolicy', () => {
  test('reports journaling-only when the data directory has no policy.json', async () => {
    const result = await checkPolicy(root)

    expect(result).toEqual({
      name: 'policy',
      level: 'ok',
      detail: 'no policy.json (journaling-only)',
    })
  })

  test('accepts a valid policy and names the file it validated', async () => {
    const path = join(root, 'policy.json')
    await writeFile(path, JSON.stringify({ version: 1 }), 'utf8')

    const result = await checkPolicy(root)

    expect(result).toEqual({ name: 'policy', level: 'ok', detail: `${path} valid` })
  })

  test("fails with the policy validator's own words when the document is not valid", async () => {
    await writeFile(join(root, 'policy.json'), JSON.stringify({}), 'utf8')

    const result = await checkPolicy(root)

    expect(result.name).toBe('policy')
    expect(result.level).toBe('fail')
    expect(result.detail).toContain('version')
    expect(result.detail).toContain(join(root, 'policy.json'))
    expect(result.detail).not.toContain('\n')
  })
})

describe('checkBindExposure', () => {
  test.each(['127.0.0.1', '::1', '[::1]', 'localhost', '127.0.0.53'])(
    'passes %s as a loopback-only bind',
    (host) => {
      const result = checkBindExposure('ui', host, false)

      expect(result).toEqual({
        name: 'ui exposure',
        level: 'ok',
        detail: `${host} loopback only`,
      })
    },
  )

  test('warns that serve on the wildcard address carries bearer tokens in clear', () => {
    const result = checkBindExposure('serve', '0.0.0.0', false)

    expect(result.name).toBe('serve exposure')
    expect(result.level).toBe('warn')
    expect(result.detail).toContain('serve binds 0.0.0.0')
    expect(result.detail).toContain('reachable from the network')
    expect(result.detail).toContain('bearer tokens')
    expect(result.detail).toContain('ADR-0004')
  })

  test('warns when the ui binds a routable address of the host', () => {
    const result = checkBindExposure('ui', '10.0.0.5', false)

    expect(result.level).toBe('warn')
    expect(result.detail).toContain('ui binds 10.0.0.5')
  })

  test('still warns with --behind-tls, because nothing here can see whether a proxy is really in front', () => {
    const result = checkBindExposure('ui', '0.0.0.0', true)

    expect(result.level).toBe('warn')
    expect(result.detail).toContain('TLS is declared')
    expect(result.detail).toContain('ADR-0004')
  })
})

describe('formatCheck', () => {
  test('renders one padded report line per check, as the setup transcript shows it', () => {
    const line = formatCheck({
      name: 'data dir',
      level: 'ok',
      detail: '/var/lib/mcpcut (0700)',
    })

    expect(line).toBe('check  data dir       ok   /var/lib/mcpcut (0700)')
  })

  test('keeps the detail column aligned for the longer names and levels', () => {
    const failed = formatCheck({ name: 'serve bind', level: 'fail', detail: 'taken' })
    const warned = formatCheck({ name: 'ui exposure', level: 'warn', detail: 'exposed' })
    // The longest name the report can produce: the column exists to fit it.
    const widest = formatCheck({ name: 'serve exposure', level: 'warn', detail: 'exposed' })

    expect(failed).toBe('check  serve bind     fail taken')
    expect(warned).toBe('check  ui exposure    warn exposed')
    expect(widest).toBe('check  serve exposure warn exposed')
  })
})
