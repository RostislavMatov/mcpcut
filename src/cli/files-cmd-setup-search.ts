import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { readDbUrl } from '../files/db/db-url.js'
import { createRootsStore } from '../files/roots-store.js'
import { SEARCH_MODEL_FILES, ORT_PACKAGE_VERSION } from '../files/search/constants.js'
import { createLocalEmbedder } from '../files/search/embedder.js'
import { checkModelFiles, downloadModelFiles, modelDirOf, type ModelFetch } from '../files/search/model-files.js'
import { isSearchRuntimeInstalled, searchModulesDirOf, searchPlatformProblem } from '../files/search/runtime-loader.js'
import { SEARCH_MODULES_PACKAGE_JSON, SEARCH_MODULES_PACKAGE_LOCK } from '../files/search/search-lock.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import type { FilesCliOptions } from './files-cmd.js'
import { MODULES_DIR_MODE, npmInvocationOf, spawnNpm } from './files-npm.js'
import { shellArg } from './next-step.js'

/**
 * The search half of `mcpcut files setup --search` (ADR-0020 §7): the pinned
 * onnxruntime-node and tokenizer tree from a lockfile that ships inside
 * mcpcut, then the pinned model by size and sha256, then a smoke embedding.
 * The Postgres client part has already run when this starts.
 */

export interface SetupSearchContext {
  readonly cli: string
  readonly modulesDir: string
}

const EMBED_SMOKE_TEXT = 'test'
const BYTES_PER_MB = 1_000_000

function sizeLabel(bytes: number): string {
  return bytes < BYTES_PER_MB ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${Math.round(bytes / BYTES_PER_MB)} MB`
}

async function writeSearchPinnedFiles(searchDir: string): Promise<void> {
  await mkdir(searchDir, { recursive: true, mode: MODULES_DIR_MODE })
  await chmod(searchDir, MODULES_DIR_MODE)
  await writeFile(join(searchDir, 'package.json'), `${JSON.stringify(SEARCH_MODULES_PACKAGE_JSON, null, 2)}\n`)
  await writeFile(join(searchDir, 'package-lock.json'), `${JSON.stringify(SEARCH_MODULES_PACKAGE_LOCK, null, 2)}\n`)
}

function errorText(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}

/** Installs the runtime tree when it is not already at the pins; returns an exit code on failure, else undefined. */
async function ensureRuntimeTree(io: AgentCliIo, opts: FilesCliOptions, searchDir: string, cli: string): Promise<number | undefined> {
  if (await isSearchRuntimeInstalled(searchDir)) {
    io.stdout.write(`search runtime onnxruntime-node ${ORT_PACKAGE_VERSION} is already installed in ${formatReadableField(searchDir)}\n`)
    return undefined
  }
  const retry = `check your network and run \`${cli} files setup --search\` again`
  await writeSearchPinnedFiles(searchDir)
  io.stdout.write(`installing the search runtime onnxruntime-node ${ORT_PACKAGE_VERSION} into ${formatReadableField(searchDir)}\n`)
  const runNpm = opts.db?.runNpm ?? spawnNpm
  const code = await runNpm(npmInvocationOf(searchDir, opts.db?.platform ?? process.platform)).catch((error: unknown) => {
    io.stderr.write(`could not run npm (${errorText(error)}): install Node.js with npm, then run \`${cli} files setup --search\` again\n`)
    return undefined
  })
  if (code === undefined) return 1
  if (code !== 0) {
    io.stderr.write(`npm exited with code ${code}: ${retry}\n`)
    return 1
  }
  if (!(await isSearchRuntimeInstalled(searchDir))) {
    io.stderr.write(`npm finished but the runtime is not at the pinned versions: ${retry}\n`)
    return 1
  }
  return undefined
}

async function downloadModel(io: AgentCliIo, opts: FilesCliOptions, searchDir: string, cli: string): Promise<number | undefined> {
  const dir = modelDirOf(searchDir)
  const files = opts.db?.modelFiles ?? SEARCH_MODEL_FILES
  if ((await checkModelFiles(dir, 'hash', files)).length === 0) {
    io.stdout.write('the search model is already in place and verified\n')
    return undefined
  }
  let isLineOpen = false
  try {
    await downloadModelFiles({
      dir,
      cli,
      files,
      fetch: opts.db?.fetch ?? (fetch as unknown as ModelFetch),
      onProgress: (progress) => {
        isLineOpen = progress.event === 'start'
        io.stdout.write(progress.event === 'start' ? `downloading ${progress.path} (${sizeLabel(progress.size)})… ` : 'ok\n')
      },
    })
  } catch (error: unknown) {
    if (isLineOpen) io.stdout.write('failed\n')
    io.stderr.write(`${errorText(error)}\n`)
    return 1
  }
  return undefined
}

async function smokeEmbed(io: AgentCliIo, opts: FilesCliOptions, ctx: SetupSearchContext): Promise<number | undefined> {
  const create = opts.db?.createEmbedder ?? ((args: { modulesDir: string; cli: string }) => createLocalEmbedder(args))
  try {
    const embedder = await create({ modulesDir: ctx.modulesDir, cli: ctx.cli })
    try {
      const vector = await embedder.embedQuery(EMBED_SMOKE_TEXT)
      if (vector.length !== embedder.dims) throw new Error(`the model returned ${vector.length} numbers instead of ${embedder.dims}`)
    } finally {
      await embedder.close()
    }
  } catch (error: unknown) {
    io.stderr.write(`the search runtime was installed but a test embedding failed (${errorText(error)}): run \`${ctx.cli} files setup --search\` again\n`)
    return 1
  }
  return undefined
}

/** The one step that fits the state: Postgres, then a folder, then the index. */
async function nextStep(opts: FilesCliOptions, cli: string): Promise<string> {
  const journalDir = opts.journalDir
  const dbState = await readDbUrl({ journalDir: journalDir ?? JOURNAL_DIR, cli })
  if (dbState.status !== 'on') return `Next: ${cli} files db init\n`
  const roots = await createRootsStore(journalDir !== undefined ? { journalDir } : {}).list()
  const first = roots[0]
  return first === undefined ? `Next: ${cli} files root add <folder>\n` : `Next: ${cli} files index on ${shellArg(first.path)}\n`
}

export async function runSetupSearch(io: AgentCliIo, opts: FilesCliOptions, ctx: SetupSearchContext): Promise<number> {
  const { cli, modulesDir } = ctx
  const problem = searchPlatformProblem(opts.db?.platform ?? process.platform, opts.db?.arch ?? process.arch)
  if (problem !== null) {
    io.stderr.write(`${problem}\n`)
    return 1
  }
  const searchDir = searchModulesDirOf(modulesDir)
  const failure = (await ensureRuntimeTree(io, opts, searchDir, cli)) ?? (await downloadModel(io, opts, searchDir, cli)) ?? (await smokeEmbed(io, opts, ctx))
  if (failure !== undefined) return failure
  const totalMb = Math.round(SEARCH_MODEL_FILES.reduce((sum, file) => sum + file.size, 0) / BYTES_PER_MB)
  io.stdout.write(`installed search by meaning: onnxruntime-node ${ORT_PACKAGE_VERSION}, model multilingual-e5-small (${totalMb} MB) in ${formatReadableField(searchDir)}\n`)
  io.stderr.write(await nextStep(opts, cli))
  return 0
}
