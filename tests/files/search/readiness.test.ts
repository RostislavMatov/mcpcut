import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ORT_PACKAGE_VERSION, SEARCH_MODEL_FILES, TOKENIZERS_PACKAGE_VERSION } from '../../../src/files/search/constants.js'
import { modelDirOf, modelFilePath } from '../../../src/files/search/model-files.js'
import { searchRuntimeProblem } from '../../../src/files/search/readiness.js'

let modulesDir: string
beforeEach(async () => {
  modulesDir = await mkdtemp(join(tmpdir(), 'mcpcut-readiness-'))
})
afterEach(async () => {
  await rm(modulesDir, { recursive: true, force: true })
})

async function installPackage(name: string, version: string): Promise<void> {
  const dir = join(modulesDir, 'search', 'node_modules', ...name.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

async function installModel(skip?: string): Promise<void> {
  for (const file of SEARCH_MODEL_FILES) {
    if (file.path === skip) continue
    const path = modelFilePath(modelDirOf(join(modulesDir, 'search')), file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '')
    await truncate(path, file.size)
  }
}

describe('searchRuntimeProblem', () => {
  test('nothing installed: names the setup command', async () => {
    expect(await searchRuntimeProblem(modulesDir, 'mcpcut')).toBe('search by meaning is not installed: run `mcpcut files setup --search`')
  })

  test('a runtime at the wrong version counts as not installed', async () => {
    await installPackage('onnxruntime-node', '1.0.0')
    await installPackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION)
    await installModel()
    expect(await searchRuntimeProblem(modulesDir, 'mcpcut')).toContain('not installed')
  })

  test('runtime without the model names the missing files', async () => {
    await installPackage('onnxruntime-node', ORT_PACKAGE_VERSION)
    await installPackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION)
    await installModel('tokenizer.json')
    expect(await searchRuntimeProblem(modulesDir, 'npx mcpcut')).toBe('the search model is incomplete (tokenizer.json): run `npx mcpcut files setup --search`')
  })

  test('everything in place: null', async () => {
    await installPackage('onnxruntime-node', ORT_PACKAGE_VERSION)
    await installPackage('@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION)
    await installModel()
    expect(await searchRuntimeProblem(modulesDir, 'mcpcut')).toBeNull()
  })
})
