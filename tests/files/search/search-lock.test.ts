import { describe, expect, test } from 'vitest'
import { ORT_PACKAGE_VERSION, TOKENIZERS_PACKAGE_VERSION } from '../../../src/files/search/constants.js'
import { SEARCH_MODULES_PACKAGE_JSON, SEARCH_MODULES_PACKAGE_LOCK } from '../../../src/files/search/search-lock.js'

type LockEntry = { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean }
const entries = Object.entries(SEARCH_MODULES_PACKAGE_LOCK.packages as Record<string, LockEntry>).filter(([name]) => name !== '')

describe('the pinned search runtime tree', () => {
  test('lock and package.json agree with the version constants', () => {
    const packages = SEARCH_MODULES_PACKAGE_LOCK.packages
    expect(packages['node_modules/onnxruntime-node'].version).toBe(ORT_PACKAGE_VERSION)
    expect(packages['node_modules/@huggingface/tokenizers'].version).toBe(TOKENIZERS_PACKAGE_VERSION)
    expect(SEARCH_MODULES_PACKAGE_JSON.dependencies).toEqual({
      'onnxruntime-node': ORT_PACKAGE_VERSION,
      '@huggingface/tokenizers': TOKENIZERS_PACKAGE_VERSION,
    })
    expect(packages[''].dependencies).toEqual({
      'onnxruntime-node': ORT_PACKAGE_VERSION,
      '@huggingface/tokenizers': TOKENIZERS_PACKAGE_VERSION,
    })
  })

  test('every package is resolved on the npm registry and carries a sha512 integrity', () => {
    expect(entries.length).toBeGreaterThan(2)
    for (const [name, entry] of entries) {
      expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//)
      expect(entry.integrity, name).toMatch(/^sha512-/)
    }
  })

  test('only onnxruntime-node declares an install script', () => {
    const withScripts = entries.filter(([, entry]) => entry.hasInstallScript === true).map(([name]) => name)
    expect(withScripts).toEqual(['node_modules/onnxruntime-node'])
  })
})
