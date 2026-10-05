import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ORT_PACKAGE_VERSION, TOKENIZERS_PACKAGE_VERSION } from '../../../src/files/search/constants.js'
import {
  loadSearchRuntime,
  searchMissingMessage,
  SearchModuleMissingError,
  searchModulesDirOf,
  searchPlatformProblem,
} from '../../../src/files/search/runtime-loader.js'

let searchDir: string

beforeEach(async () => {
  searchDir = await mkdtemp(join(tmpdir(), 'mcpcut-search-loader-'))
  await writeFile(join(searchDir, 'package.json'), '{"name":"x"}')
})
afterEach(async () => {
  await rm(searchDir, { recursive: true, force: true })
})

async function fakePackage(name: string, version: string, main: string): Promise<void> {
  const dir = join(searchDir, 'node_modules', ...name.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  await writeFile(join(dir, 'index.js'), main)
}

describe('searchModulesDirOf', () => {
  test('is the search folder of the modules folder', () => {
    expect(searchModulesDirOf('/d/modules')).toBe(join('/d/modules', 'search'))
  })
})

describe('searchPlatformProblem', () => {
  test.each([['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']])('%s-%s is supported', (platform, arch) => {
    expect(searchPlatformProblem(platform as NodeJS.Platform, arch)).toBeNull()
  })

  test('Intel macOS is refused with one line that says the rest still works', () => {
    expect(searchPlatformProblem('darwin', 'x64')).toBe(
      'search by meaning needs macOS on Apple silicon, Linux or Windows (x64 or arm64): the local model runtime has no build for darwin-x64; everything else in the file module works',
    )
  })
})

describe('loadSearchRuntime', () => {
  test('a missing package is SearchModuleMissingError', async () => {
    await expect(loadSearchRuntime(searchDir)).rejects.toBeInstanceOf(SearchModuleMissingError)
  })

  test('a version that differs from the pin is refused as missing', async () => {
    await fakePackage('onnxruntime-node', '1.0.0', 'module.exports = {}')
    await fakePackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION, 'module.exports = { Tokenizer: class {} }')
    await expect(loadSearchRuntime(searchDir)).rejects.toBeInstanceOf(SearchModuleMissingError)
  })

  test('loads both packages at the pinned versions', async () => {
    await fakePackage('onnxruntime-node', ORT_PACKAGE_VERSION, 'module.exports = { InferenceSession: {}, Tensor: class {} }')
    await fakePackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION, 'module.exports = { Tokenizer: class {} }')
    const runtime = await loadSearchRuntime(searchDir)
    expect(typeof runtime.Tokenizer).toBe('function')
    expect(runtime.ort.Tensor).toBeDefined()
  })

  test('a package that does not export what we call is an error that names the fix', async () => {
    await fakePackage('onnxruntime-node', ORT_PACKAGE_VERSION, 'module.exports = {}')
    await fakePackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION, 'module.exports = {}')
    await expect(loadSearchRuntime(searchDir)).rejects.toThrow(/files setup --search/)
  })
})

describe('searchMissingMessage', () => {
  test('names the install command', () => {
    expect(searchMissingMessage('mcpcut')).toBe('search by meaning is not installed: run `mcpcut files setup --search`')
  })
})
