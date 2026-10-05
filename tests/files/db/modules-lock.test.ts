import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PG_PACKAGE_VERSION } from '../../../src/files/db/constants.js'
import { MODULES_PACKAGE_JSON, MODULES_PACKAGE_LOCK } from '../../../src/files/db/modules-lock.js'

describe('the pinned client tree', () => {
  test('lock, constant and devDependency agree on the pg version', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    expect(MODULES_PACKAGE_LOCK.packages['node_modules/pg'].version).toBe(PG_PACKAGE_VERSION)
    expect(manifest.devDependencies['pg']).toBe(PG_PACKAGE_VERSION)
    expect(MODULES_PACKAGE_JSON.dependencies.pg).toBe(PG_PACKAGE_VERSION)
  })

  test('every locked package carries an integrity hash', () => {
    const entries = Object.entries(MODULES_PACKAGE_LOCK.packages).filter(([name]) => name !== '')
    expect(entries.length).toBeGreaterThan(1)
    for (const [name, entry] of entries) {
      expect(entry, name).toHaveProperty('integrity')
      expect((entry as { integrity: string }).integrity, name).toMatch(/^sha512-/)
    }
  })

  test('the root entry asks for exactly the pinned pg', () => {
    expect(MODULES_PACKAGE_LOCK.packages[''].dependencies).toEqual({ pg: PG_PACKAGE_VERSION })
  })
})
