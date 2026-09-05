import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CONFIG_PATH_ENV_VAR,
  INSTALL_CONFIG_VERSION,
  MAX_CONFIG_BYTES,
} from '../../src/setup/constants.js'
import { installConfigPath } from '../../src/setup/config-path.js'
import { loadInstallConfigSync } from '../../src/setup/load.js'

/**
 * Reading `~/.mcpcut/config.json` (phase 1, task 3). Real files in a tmpdir:
 * this loader runs while `src/config.ts` evaluates, so its failure modes —
 * a missing file, an unreadable one, a truncated one — are the difference
 * between "the plane starts with the old defaults" and "no command runs".
 */

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mcpcut-load-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function configPathIn(dir: string): string {
  return join(dir, CONFIG_FILE_NAME)
}

function validConfigText(dataDir: string): string {
  return JSON.stringify({
    version: INSTALL_CONFIG_VERSION,
    dataDir,
    ui: { host: '127.0.0.1', port: 8091 },
    serve: { host: '127.0.0.1', port: 8090 },
  })
}

/** A `Stats`-shaped answer for the stat seam: only `isFile()` and `size` are read. */
function regularFileStat(size = 32): { isFile(): boolean; readonly size: number } {
  return { isFile: () => true, size }
}

describe('installConfigPath', () => {
  test('defaults to ~/.mcpcut/config.json', () => {
    expect(installConfigPath({}, '/home/op')).toBe(join('/home/op', CONFIG_DIR_NAME, CONFIG_FILE_NAME))
  })

  test('honours a non-empty MCPCUT_CONFIG', () => {
    expect(installConfigPath({ [CONFIG_PATH_ENV_VAR]: '/etc/mcpcut.json' }, '/home/op')).toBe('/etc/mcpcut.json')
  })

  test('treats an empty MCPCUT_CONFIG as not set, like every other env seam', () => {
    expect(installConfigPath({ [CONFIG_PATH_ENV_VAR]: '' }, '/home/op')).toBe(
      join('/home/op', CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    )
  })
})

describe('loadInstallConfigSync', () => {
  test('reports a missing file as absent and names the path it looked at', () => {
    const path = configPathIn(home)

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load).toEqual({ kind: 'absent', path })
  })

  test('reports a path whose parent is a file as absent, not as a fault', async () => {
    const file = join(home, 'not-a-dir')
    await writeFile(file, 'x', 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: join(file, 'config.json') } })

    expect(load.kind).toBe('absent')
  })

  test('parses a valid config and hands back the data directory it names', async () => {
    const path = configPathIn(home)
    await writeFile(path, validConfigText('/var/lib/mcpcut'), 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return
    expect(load.config.dataDir).toBe('/var/lib/mcpcut')
    expect(load.path).toBe(path)
  })

  test('finds the config under the home directory when MCPCUT_CONFIG is empty', async () => {
    const dir = join(home, CONFIG_DIR_NAME)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(configPathIn(dir), validConfigText('/var/lib/mcpcut'), 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: '' }, home })

    expect(load.kind).toBe('ok')
  })

  test('refuses a file that is not valid JSON and says so without quoting its contents', async () => {
    const path = configPathIn(home)
    await writeFile(path, '{ "dataDir": ', 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems[0]).toMatch(/^\(root\): not valid JSON: /)
  })

  test('never echoes the broken file contents back at the operator', async () => {
    const path = configPathIn(home)
    await writeFile(path, '{ "token": "mcpa_supersecret" ', 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems.join('\n')).not.toContain('mcpa_')
  })

  test('refuses a config with an unknown key and names the key', async () => {
    const path = configPathIn(home)
    await writeFile(path, JSON.stringify({ ...JSON.parse(validConfigText('/d')), token: 'mcpa_x' }), 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems).toContain('(root): unknown key "token"')
  })

  test('refuses a config larger than the byte bound before parsing it', async () => {
    const path = configPathIn(home)
    await writeFile(path, `${' '.repeat(MAX_CONFIG_BYTES + 1)}{}`, 'utf8')

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems.join('\n')).toContain(String(MAX_CONFIG_BYTES))
  })

  test('reports an unreadable file as invalid, carrying the errno, never as absent', () => {
    const path = configPathIn(home)

    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: path },
      statSync: () => regularFileStat(),
      readFileSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems).toEqual(['EACCES: permission denied'])
  })

  test('reports a read failure with no errno as invalid too', () => {
    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: configPathIn(home) },
      statSync: () => regularFileStat(),
      readFileSync: () => {
        throw new Error('nope')
      },
    })

    expect(load.kind).toBe('invalid')
  })
})

/**
 * The stat that runs BEFORE the read (TS-M4 / SEC-L1). `MCPCUT_CONFIG` names a
 * path an operator (or whoever can write their environment) chooses, and
 * `readFileSync` on a FIFO blocks forever — at IMPORT time, in every command
 * of the process. A size bound enforced only after the whole file is in memory
 * is likewise a bound on nothing.
 */
describe('loadInstallConfigSync: the file is inspected before it is read', () => {
  test('refuses a path that is not a regular file without ever reading it', () => {
    let reads = 0

    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: configPathIn(home) },
      statSync: () => ({ isFile: () => false, size: 0 }),
      readFileSync: () => {
        reads += 1
        return '{}'
      },
    })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems).toEqual(['(root): not a regular file'])
    // The whole point: a FIFO is never opened, so nothing can block on it.
    expect(reads).toBe(0)
  })

  test('refuses an over-large file from its stat, before reading a byte', () => {
    let reads = 0

    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: configPathIn(home) },
      statSync: () => regularFileStat(MAX_CONFIG_BYTES + 1),
      readFileSync: () => {
        reads += 1
        return '{}'
      },
    })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems.join('\n')).toContain(String(MAX_CONFIG_BYTES))
    expect(reads).toBe(0)
  })

  test('a directory at the config path is a fault, not a missing config', async () => {
    const path = configPathIn(home)
    await mkdir(path, { recursive: true })

    const load = loadInstallConfigSync({ env: { [CONFIG_PATH_ENV_VAR]: path } })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems).toEqual(['(root): not a regular file'])
  })

  test('a missing file is still absent, whichever call notices it first', () => {
    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: join(home, 'nowhere', 'config.json') },
    })

    expect(load.kind).toBe('absent')
  })

  test('a stat failure that is not ENOENT is reported with its errno', () => {
    const load = loadInstallConfigSync({
      env: { [CONFIG_PATH_ENV_VAR]: configPathIn(home) },
      statSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    })

    expect(load.kind).toBe('invalid')
    if (load.kind !== 'invalid') return
    expect(load.problems).toEqual(['EACCES: permission denied'])
  })
})
