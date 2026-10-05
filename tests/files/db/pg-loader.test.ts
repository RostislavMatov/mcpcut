import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FilesDbModuleMissingError, loadPg, modulesDirOf } from '../../../src/files/db/pg-loader.js'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mcpcut-pg-loader-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('modulesDirOf', () => {
  test('lives inside the data directory', () => {
    expect(modulesDirOf('/data/x')).toBe(join('/data/x', 'modules'))
  })
})

describe('loadPg', () => {
  test('loads the pinned client from the repo root (the devDependency)', async () => {
    const pg = await loadPg(process.cwd())
    expect(typeof pg.Pool).toBe('function')
  })

  test('a folder without pg raises the missing-module error', async () => {
    await expect(loadPg(join(base, 'modules'))).rejects.toBeInstanceOf(FilesDbModuleMissingError)
  })

  test('a fake pg without a Pool is a clear error', async () => {
    const dir = join(base, 'modules')
    const pgDir = join(dir, 'node_modules', 'pg')
    await mkdir(pgDir, { recursive: true })
    await writeFile(join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0', main: 'index.js' }))
    await writeFile(join(pgDir, 'index.js'), 'module.exports = { nothing: true }\n')
    await expect(loadPg(dir)).rejects.toThrow(/does not export a Pool/)
  })

  test('a fake pg with a Pool is returned', async () => {
    const dir = join(base, 'modules')
    const pgDir = join(dir, 'node_modules', 'pg')
    await mkdir(pgDir, { recursive: true })
    await writeFile(join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0', main: 'index.js' }))
    await writeFile(join(pgDir, 'index.js'), 'module.exports = { Pool: class {} }\n')
    expect(typeof (await loadPg(dir)).Pool).toBe('function')
  })
})
