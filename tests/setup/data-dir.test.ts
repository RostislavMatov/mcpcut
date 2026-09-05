import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CONFIG_PATH_ENV_VAR,
  DATA_DIR_ENV_VAR,
  DEFAULT_DATA_DIR_NAME,
  INSTALL_CONFIG_VERSION,
} from '../../src/setup/constants.js'
import { describeDataDirProblem, resolveDataDir } from '../../src/setup/data-dir.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * Resolving the data directory (phase 1, task 4) — the decision `src/config.ts`
 * makes once, at import, for every command in the process. Its three sources
 * are ranked `MCP_JOURNAL_DIR` > install config > `~/.mcp-journal`, and a
 * config that cannot be read is reported as a value rather than thrown, so the
 * dispatcher can refuse with an explanation instead of the process dying
 * before any command exists.
 */

const CONFIG_PATH = '/home/op/.mcpcut/config.json'

function configFor(dataDir: string): InstallConfig {
  return {
    version: INSTALL_CONFIG_VERSION,
    dataDir,
    ui: { host: '127.0.0.1', port: 8091 },
    serve: { host: '127.0.0.1', port: 8090 },
  }
}

function okLoad(dataDir: string): InstallConfigLoad {
  return { kind: 'ok', path: CONFIG_PATH, config: configFor(dataDir) }
}

function invalidLoad(problems: readonly string[]): InstallConfigLoad {
  return { kind: 'invalid', path: CONFIG_PATH, problems }
}

const ABSENT_LOAD: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }

describe('resolveDataDir', () => {
  test('MCP_JOURNAL_DIR outranks the config file', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: '/srv/from-env' },
      home: '/home/op',
      load: okLoad('/srv/from-config'),
    })

    expect(resolution.dataDir).toBe('/srv/from-env')
    expect(resolution.source).toBe('env')
  })

  test('an empty MCP_JOURNAL_DIR counts as not set, like every other env seam', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: '' },
      home: '/home/op',
      load: okLoad('/srv/from-config'),
    })

    expect(resolution.dataDir).toBe('/srv/from-config')
    expect(resolution.source).toBe('config')
  })

  test('a relative MCP_JOURNAL_DIR is refused, never resolved against the working directory', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: 'plane-data' },
      home: '/home/op',
      load: ABSENT_LOAD,
    })

    // Resolving it against the cwd would put every command in a different,
    // empty, policy-less directory depending on where it was typed.
    expect(resolution.dataDir).toBe(join('/home/op', DEFAULT_DATA_DIR_NAME))
    expect(isAbsolute(resolution.dataDir)).toBe(true)
    expect(resolution.source).toBe('default')
    expect(resolution.problem).toEqual([
      `${DATA_DIR_ENV_VAR} must be an absolute path (got "plane-data")`,
    ])
  })

  test('a relative MCP_JOURNAL_DIR reports the config faults it found as well', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: './plane-data' },
      home: '/home/op',
      load: invalidLoad(['(root): the file does not parse as JSON']),
    })

    expect(resolution.problem).toEqual([
      `${DATA_DIR_ENV_VAR} must be an absolute path (got "./plane-data")`,
      '(root): the file does not parse as JSON',
    ])
  })

  test('the config file outranks the default when nothing is exported', () => {
    const resolution = resolveDataDir({ env: {}, home: '/home/op', load: okLoad('/var/lib/mcpcut') })

    expect(resolution.dataDir).toBe('/var/lib/mcpcut')
    expect(resolution.source).toBe('config')
    expect(resolution.configPath).toBe(CONFIG_PATH)
  })

  test('no config file at all leaves the historical ~/.mcp-journal in place', () => {
    const resolution = resolveDataDir({ env: {}, home: '/home/op', load: ABSENT_LOAD })

    expect(resolution.dataDir).toBe(join('/home/op', DEFAULT_DATA_DIR_NAME))
    expect(resolution.source).toBe('default')
    expect(resolution.problem).toBeUndefined()
  })

  test('an unusable config falls back to the default and reports every problem', () => {
    const resolution = resolveDataDir({
      env: {},
      home: '/home/op',
      load: invalidLoad(['dataDir: dataDir must be an absolute path', 'ui: unknown key "token"']),
    })

    expect(resolution.dataDir).toBe(join('/home/op', DEFAULT_DATA_DIR_NAME))
    expect(resolution.source).toBe('default')
    expect(resolution.problem).toEqual([
      'dataDir: dataDir must be an absolute path',
      'ui: unknown key "token"',
    ])
  })

  test('an unusable config is still reported when MCP_JOURNAL_DIR answers the question', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: '/srv/from-env' },
      home: '/home/op',
      load: invalidLoad(['(root): the file does not parse as JSON']),
    })

    expect(resolution.dataDir).toBe('/srv/from-env')
    expect(resolution.source).toBe('env')
    expect(resolution.problem).toEqual(['(root): the file does not parse as JSON'])
  })

  test('a config the caller did not pre-load is read from disk, and a missing one is not an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcpcut-data-dir-'))
    try {
      const resolution = resolveDataDir({ env: {}, home })

      expect(resolution.dataDir).toBe(join(home, DEFAULT_DATA_DIR_NAME))
      expect(resolution.source).toBe('default')
      expect(resolution.configPath).toBe(join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('describeDataDirProblem', () => {
  test('says nothing when the config is usable', () => {
    expect(describeDataDirProblem(resolveDataDir({ env: {}, home: '/home/op', load: ABSENT_LOAD }))).toBeUndefined()
  })

  test('an environment fault points at the variable, not at a config file that may be fine', () => {
    const resolution = resolveDataDir({
      env: { [DATA_DIR_ENV_VAR]: 'plane-data' },
      home: '/home/op',
      load: ABSENT_LOAD,
    })

    const message = describeDataDirProblem(resolution)

    expect(message).toBe(
      `mcpcut: ${DATA_DIR_ENV_VAR} is not usable:\n` +
        `  ${DATA_DIR_ENV_VAR} must be an absolute path (got "plane-data")\n` +
        `Export an absolute path, or unset ${DATA_DIR_ENV_VAR} and let the install config ` +
        `${CONFIG_PATH} answer instead.\n`,
    )
  })

  test('names the config path, lists every problem and says how to get out of it', () => {
    const resolution = resolveDataDir({
      env: {},
      home: '/home/op',
      load: invalidLoad(['dataDir: dataDir must be an absolute path', 'ui: unknown key "token"']),
    })

    const message = describeDataDirProblem(resolution)

    expect(message).toBe(
      `mcpcut: install config ${CONFIG_PATH} is unusable:\n` +
        '  dataDir: dataDir must be an absolute path\n' +
        '  ui: unknown key "token"\n' +
        `Fix or remove it, or point ${CONFIG_PATH_ENV_VAR} at another file. ` +
        '"mcpcut setup --yes --force" rewrites it.\n',
    )
  })
})

/** The one guarantee the resolver owes the rest of the plane: it never throws. */
describe('resolveDataDir: faults are values', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpcut-data-dir-fault-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('a config that cannot be parsed yields a problem instead of an exception', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, CONFIG_DIR_NAME), { recursive: true })
    await writeFile(join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME), '{ not json', 'utf8')

    const resolution = resolveDataDir({ env: {}, home })

    expect(resolution.source).toBe('default')
    expect(describeDataDirProblem(resolution)).toContain('install config')
  })
})
