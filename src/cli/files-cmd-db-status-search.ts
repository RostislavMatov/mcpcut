import { checkModelFiles, modelDirOf } from '../files/search/model-files.js'
import { installedSearchPackageVersion, searchModulesDirOf } from '../files/search/runtime-loader.js'
import { ORT_PACKAGE_VERSION, TOKENIZERS_PACKAGE_VERSION } from '../files/search/constants.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'

/**
 * The «search» block of `files db status`: is the local runtime installed at
 * the pinned versions, and are the model files in place (a size check). Each
 * line says what to run when something is missing. Index counts are added next
 * to it by the index commands.
 */

export async function writeSearchStatus(io: AgentCliIo, modulesDir: string, cli: string): Promise<void> {
  const searchDir = searchModulesDirOf(modulesDir)
  const fix = `run \`${cli} files setup --search\``
  const [ort, tokenizers] = await Promise.all([
    installedSearchPackageVersion(searchDir, 'onnxruntime-node'),
    installedSearchPackageVersion(searchDir, '@huggingface/tokenizers'),
  ])
  const isRuntimeOk = ort === ORT_PACKAGE_VERSION && tokenizers === TOKENIZERS_PACKAGE_VERSION
  io.stdout.write(
    isRuntimeOk
      ? `search runtime: installed onnxruntime-node ${formatReadableField(ort)}, tokenizers ${formatReadableField(tokenizers)}\n`
      : `search runtime: not installed (${fix})\n`,
  )
  const missing = await checkModelFiles(modelDirOf(searchDir), 'size')
  io.stdout.write(missing.length === 0 ? 'search model: ok\n' : `search model: ${missing.length === 3 ? 'not installed' : `incomplete (${missing.join(', ')})`} (${fix})\n`)
}
