import { availableParallelism } from 'node:os'
import { readFile } from 'node:fs/promises'
import { EMBED_DIMS, EMBED_MAX_THREADS, EMBED_MAX_TOKENS, PASSAGE_PREFIX, QUERY_PREFIX, SEARCH_MODEL_FILES, SEARCH_MODEL_ID } from './constants.js'
import { checkModelFiles, modelDirOf, modelFilePath } from './model-files.js'
import type { OrtSession, SearchRuntime } from './ort-types.js'
import { loadSearchRuntime, searchModulesDirOf, searchPlatformProblem } from './runtime-loader.js'
import { formatReadableField } from '../../journal/format.js'
import type { Embedder } from './types.js'

/**
 * The local embedder (ADR-0020 §6): onnxruntime-node and the pinned e5 model,
 * called directly. Text is cut to the model's context, mean-pooled over the
 * tokens and L2-normalized. One text at a time: batching measured no faster.
 */

export interface LocalEmbedderOptions {
  /** `<data dir>/modules` — the search runtime and model live under its `search` folder. */
  readonly modulesDir: string
  readonly threads?: number
  /** The CLI prefix for the setup line in errors; defaults to `mcpcut`. */
  readonly cli?: string
  /** Only for tests: replaces loading the native runtime. */
  readonly load?: (searchDir: string) => Promise<SearchRuntime>
}

/** The model files are not where `files setup --search` puts them. */
export class SearchModelMissingError extends Error {
  constructor(cli: string, missing: readonly string[]) {
    super(`the search model is incomplete (${missing.join(', ')}): run \`${cli} files setup --search\``)
    this.name = 'SearchModelMissingError'
  }
}

/** Keeps the first `max - 1` ids and the last one (the closing `</s>`) when the input is too long. */
export function truncateIds(ids: readonly number[], max: number): readonly number[] {
  if (ids.length <= max) return ids
  return [...ids.slice(0, max - 1), ids[ids.length - 1] as number]
}

/** Mean over `tokens` rows of `dims` numbers, then L2-normalized. */
export function meanPoolNormalize(data: ArrayLike<number | bigint>, tokens: number, dims: number): Float32Array {
  const vector = new Float32Array(dims)
  for (let token = 0; token < tokens; token++) {
    for (let d = 0; d < dims; d++) vector[d] = (vector[d] as number) + Number(data[token * dims + d])
  }
  let sumSquares = 0
  for (let d = 0; d < dims; d++) {
    const mean = (vector[d] as number) / tokens
    vector[d] = mean
    sumSquares += mean * mean
  }
  const norm = Math.sqrt(sumSquares)
  return norm === 0 ? vector : vector.map((value) => value / norm)
}

/** Half the cores, at least one, at most {@link EMBED_MAX_THREADS}. */
export function defaultThreads(cores: number = availableParallelism()): number {
  return Math.max(1, Math.min(EMBED_MAX_THREADS, Math.floor(cores / 2)))
}

/** A model file that does not parse, or a tokenizer that does not build, is a broken download: one fix. */
async function buildTokenizer(runtime: SearchRuntime, tokenizerFile: string, configFile: string, cli: string): Promise<InstanceType<SearchRuntime['Tokenizer']>> {
  try {
    return new runtime.Tokenizer(await readJson(tokenizerFile), await readJson(configFile))
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`the search model's tokenizer could not be loaded (${formatReadableField(cause)}): run \`${cli} files setup --search\` again`)
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function feedsOf(runtime: SearchRuntime, session: OrtSession, ids: readonly number[]) {
  const dims = [1, ids.length]
  const { Tensor } = runtime.ort
  const feeds: Record<string, InstanceType<typeof Tensor>> = {
    input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), dims),
    attention_mask: new Tensor('int64', new BigInt64Array(ids.length).fill(1n), dims),
  }
  if (session.inputNames.includes('token_type_ids')) feeds['token_type_ids'] = new Tensor('int64', new BigInt64Array(ids.length), dims)
  return feeds
}

async function embedWith(runtime: SearchRuntime, session: OrtSession, tokenizer: { encode(text: string): { ids: readonly number[] } }, text: string): Promise<Float32Array> {
  const ids = truncateIds(tokenizer.encode(text).ids, EMBED_MAX_TOKENS)
  const outputName = session.outputNames[0]
  if (outputName === undefined) throw new Error('the search model has no outputs: run `files setup --search` again')
  const output = (await session.run(feedsOf(runtime, session, ids)))[outputName]
  const dims = output?.dims
  if (output === undefined || dims === undefined || dims.length !== 3 || dims[0] !== 1 || dims[1] !== ids.length || dims[2] !== EMBED_DIMS) {
    throw new Error(`the search model returned an unexpected shape [${dims?.join(', ') ?? 'none'}] instead of [1, ${ids.length}, ${EMBED_DIMS}]: run \`files setup --search\` again`)
  }
  return meanPoolNormalize(output.data, ids.length, EMBED_DIMS)
}

export async function createLocalEmbedder(opts: LocalEmbedderOptions): Promise<Embedder> {
  const platformProblem = searchPlatformProblem(process.platform, process.arch)
  if (platformProblem !== null) throw new Error(platformProblem)
  const searchDir = searchModulesDirOf(opts.modulesDir)
  const runtime = await (opts.load ?? loadSearchRuntime)(searchDir)
  const modelDir = modelDirOf(searchDir)
  const missing = await checkModelFiles(modelDir, 'size')
  if (missing.length > 0) throw new SearchModelMissingError(opts.cli ?? 'mcpcut', missing)
  const [tokenizerFile, configFile, modelFile] = ['tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].map((path) => {
    const file = SEARCH_MODEL_FILES.find((candidate) => candidate.path === path)
    if (file === undefined) throw new Error(`pinned model file ${path} is not declared`)
    return modelFilePath(modelDir, file)
  }) as [string, string, string]
  const cli = opts.cli ?? 'mcpcut'
  const tokenizer = await buildTokenizer(runtime, tokenizerFile, configFile, cli)
  const session = await runtime.ort.InferenceSession.create(modelFile, {
    intraOpNumThreads: opts.threads ?? defaultThreads(),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  })

  let queue: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const run = (text: string): Promise<Float32Array> => {
    const next = queue.then(() => embedWith(runtime, session, tokenizer, text))
    queue = next.catch(() => undefined)
    return next
  }
  return {
    model: SEARCH_MODEL_ID,
    dims: EMBED_DIMS,
    embedPassage: (text) => run(`${PASSAGE_PREFIX}${text}`),
    embedQuery: (text) => run(`${QUERY_PREFIX}${text}`),
    close: () => {
      closing ??= queue.then(() => session.release())
      return closing
    },
  }
}
