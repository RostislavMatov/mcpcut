import { checkModelFiles, modelDirOf } from './model-files.js'
import { isSearchRuntimeInstalled, searchModulesDirOf } from './runtime-loader.js'

/**
 * `null` when the search runtime and the model files are in place under
 * `<modulesDir>/search` (versions and a size check, no hashing, no loading of
 * native code), else the one line that says what is missing and the command
 * that installs it.
 */
export async function searchRuntimeProblem(modulesDir: string, cli: string): Promise<string | null> {
  const searchDir = searchModulesDirOf(modulesDir)
  const fix = `run \`${cli} files setup --search\``
  if (!(await isSearchRuntimeInstalled(searchDir))) return `search by meaning is not installed: ${fix}`
  const missing = await checkModelFiles(modelDirOf(searchDir), 'size')
  if (missing.length > 0) return `the search model is incomplete (${missing.join(', ')}): ${fix}`
  return null
}
