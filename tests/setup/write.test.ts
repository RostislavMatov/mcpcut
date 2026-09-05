import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  INSTALL_CONFIG_DIR_MODE,
  INSTALL_CONFIG_FILE_MODE,
  INSTALL_CONFIG_VERSION,
} from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import { InstallConfigWriteRejectedError, writeInstallConfig } from '../../src/setup/write.js'

/**
 * Writing `~/.mcpcut/config.json` (phase 1, task 6). Real files: the whole
 * point of this module is the permissions and the atomicity, neither of which
 * a mocked fs can demonstrate.
 */

let home: string
let configPath: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mcpcut-write-'))
  configPath = join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function modeOf(mode: number): number {
  return mode & 0o777
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('writeInstallConfig', () => {
  test('writes the config as owner-only, pretty-printed and newline-terminated', async () => {
    const config = defaultInstallConfig('/var/lib/mcpcut')

    await writeInstallConfig(configPath, config)

    const text = await readFile(configPath, 'utf8')
    expect(JSON.parse(text)).toEqual(config)
    expect(text).toBe(`${JSON.stringify(config, null, 2)}\n`)
    expect(modeOf((await stat(configPath)).mode)).toBe(INSTALL_CONFIG_FILE_MODE)
  })

  test('creates the parent directory owner-only, so no other account can read the install layout', async () => {
    await writeInstallConfig(configPath, defaultInstallConfig('/var/lib/mcpcut'))

    expect(modeOf((await stat(join(home, CONFIG_DIR_NAME))).mode)).toBe(INSTALL_CONFIG_DIR_MODE)
  })

  test('replaces an existing config without leaving a temporary file behind', async () => {
    await writeInstallConfig(configPath, defaultInstallConfig('/first'))

    await writeInstallConfig(configPath, defaultInstallConfig('/second'))

    const entries = await readdir(join(home, CONFIG_DIR_NAME))
    expect(entries).toEqual([CONFIG_FILE_NAME])
    expect(JSON.parse(await readFile(configPath, 'utf8')).dataDir).toBe('/second')
    expect(modeOf((await stat(configPath)).mode)).toBe(INSTALL_CONFIG_FILE_MODE)
  })

  test('refuses a config the schema rejects and names the path and the problem', async () => {
    const invalid = { ...defaultInstallConfig('relative/path') } as InstallConfig

    await expect(writeInstallConfig(configPath, invalid)).rejects.toBeInstanceOf(
      InstallConfigWriteRejectedError,
    )
  })

  test('touches no disk when it refuses: no config, not even the directory', async () => {
    const invalid = { version: INSTALL_CONFIG_VERSION } as unknown as InstallConfig

    await expect(writeInstallConfig(configPath, invalid)).rejects.toThrow(/Refusing to write/)

    expect(await exists(configPath)).toBe(false)
    expect(await exists(join(home, CONFIG_DIR_NAME))).toBe(false)
  })

  test('carries the schema problems on the error, one line per issue', async () => {
    const invalid = { ...defaultInstallConfig('/ok'), token: 'mcpa_x' } as unknown as InstallConfig

    const error = await writeInstallConfig(configPath, invalid).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(InstallConfigWriteRejectedError)
    if (!(error instanceof InstallConfigWriteRejectedError)) return
    expect(error.problems).toContain('(root): unknown key "token"')
    expect(error.message).toContain(configPath)
  })
})
