import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ORT_PACKAGE_VERSION, SEARCH_MODULES_DIR_NAME, SEARCH_PLATFORMS, TOKENIZERS_PACKAGE_VERSION } from './constants.js'
import type { OrtModule, SearchRuntime, TokenizerConstructor } from './ort-types.js'

/**
 * Loads the search runtime at run time from `<modules>/search` (ADR-0020 §7):
 * onnxruntime-node and the tokenizer are not dependencies of mcpcut,
 * `files setup --search` installs a pinned tree next to the data.
 */

export function searchModulesDirOf(modulesDir: string): string {
  return join(modulesDir, SEARCH_MODULES_DIR_NAME)
}

/** A runtime package is not installed, or not at the pinned version. The caller words the next step. */
export class SearchModuleMissingError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'SearchModuleMissingError'
  }
}

export function searchMissingMessage(cli: string): string {
  return `search by meaning is not installed: run \`${cli} files setup --search\``
}

/** `null` when the local runtime has a native build for this machine, else the one line that says so. */
export function searchPlatformProblem(platform: NodeJS.Platform, arch: string): string | null {
  if (SEARCH_PLATFORMS.includes(`${platform}-${arch}`)) return null
  return `search by meaning needs macOS on Apple silicon, Linux or Windows (x64 or arm64): the local model runtime has no build for ${platform}-${arch}; everything else in the file module works`
}

/** The installed version of one package, or undefined when it is not there. */
export async function installedSearchPackageVersion(searchDir: string, name: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(searchDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Both runtime packages installed at exactly the pinned versions. */
export async function isSearchRuntimeInstalled(searchDir: string): Promise<boolean> {
  const [ort, tokenizers] = await Promise.all([
    installedSearchPackageVersion(searchDir, 'onnxruntime-node'),
    installedSearchPackageVersion(searchDir, '@huggingface/tokenizers'),
  ])
  return ort === ORT_PACKAGE_VERSION && tokenizers === TOKENIZERS_PACKAGE_VERSION
}

async function importPinned(searchDir: string, name: string, version: string): Promise<Record<string, unknown>> {
  if ((await installedSearchPackageVersion(searchDir, name)) !== version) {
    throw new SearchModuleMissingError(`${name} ${version} is not installed in ${searchDir}`)
  }
  let resolved: string
  try {
    resolved = createRequire(join(searchDir, 'package.json')).resolve(name)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') throw new SearchModuleMissingError(`${name} cannot be resolved in ${searchDir}`)
    throw error
  }
  const loaded = (await import(pathToFileURL(resolved).href)) as Record<string, unknown> & { default?: Record<string, unknown> }
  return { ...loaded, ...(loaded.default ?? {}) }
}

export async function loadSearchRuntime(searchDir: string): Promise<SearchRuntime> {
  const ort = await importPinned(searchDir, 'onnxruntime-node', ORT_PACKAGE_VERSION)
  const tokenizers = await importPinned(searchDir, '@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION)
  if (ort['InferenceSession'] === undefined || typeof ort['Tensor'] !== 'function') {
    throw new Error(`onnxruntime-node in ${searchDir} does not export what mcpcut needs: run \`mcpcut files setup --search\` again`)
  }
  if (typeof tokenizers['Tokenizer'] !== 'function') {
    throw new Error(`@huggingface/tokenizers in ${searchDir} does not export a Tokenizer: run \`mcpcut files setup --search\` again`)
  }
  return { ort: ort as unknown as OrtModule, Tokenizer: tokenizers['Tokenizer'] as TokenizerConstructor }
}
