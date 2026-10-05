/** Search by meaning in the file module (ADR-0020 §6, amendment 2026-10-05 phase 5): names, pins and limits, in one place. */

/** The local model: multilingual (Russian and English), 384 dimensions, int8. Pinned to one revision and per-file hashes. */
export const SEARCH_MODEL_REPO = 'Xenova/multilingual-e5-small'
export const SEARCH_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
/** Stored next to every vector: a different model means the file is embedded again. */
export const SEARCH_MODEL_ID = `${SEARCH_MODEL_REPO}@${SEARCH_MODEL_REVISION.slice(0, 7)}`
/** The folder under `<modules>/search/models` that holds the pinned files. */
export const SEARCH_MODEL_DIR_NAME = `multilingual-e5-small-${SEARCH_MODEL_REVISION.slice(0, 7)}`
export const SEARCH_MODEL_BASE_URL = `https://huggingface.co/${SEARCH_MODEL_REPO}/resolve/${SEARCH_MODEL_REVISION}`

export interface PinnedModelFile {
  /** Relative to the model folder and to the revision URL; always `/`-separated. */
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export const SEARCH_MODEL_FILES: readonly PinnedModelFile[] = [
  { path: 'onnx/model_quantized.onnx', size: 118_308_185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
  { path: 'tokenizer.json', size: 17_082_730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { path: 'tokenizer_config.json', size: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
]

export const EMBED_DIMS = 384
/** The model's context; longer input is cut, keeping the closing special token. */
export const EMBED_MAX_TOKENS = 512
/** e5 models are trained with these prefixes: a query and a passage are embedded differently. */
export const QUERY_PREFIX = 'query: '
export const PASSAGE_PREFIX = 'passage: '

/** The runtime packages `files setup --search` installs from a pinned lockfile. */
export const ORT_PACKAGE_VERSION = '1.30.0'
export const TOKENIZERS_PACKAGE_VERSION = '0.2.0'
/** `<data dir>/modules/search`: the runtime tree and the model, apart from the Postgres client. */
export const SEARCH_MODULES_DIR_NAME = 'search'
/** `platform-arch` pairs onnxruntime-node 1.30.0 ships a native build for (no Intel macOS). */
export const SEARCH_PLATFORMS: readonly string[] = ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']
/** At most this many inference threads, and never more than half the cores. */
export const EMBED_MAX_THREADS = 4

/** What is indexed. */
export const INDEX_MAX_FILE_BYTES = 512 * 1024
export const CHUNK_MAX_CHARS = 1000
export const CHUNK_MAX_PER_FILE = 600
export const INDEX_RULES_MAX = 200
export const INDEX_RULES_FILE_NAME = 'files-index.json'
/** Folder names whose whole subtree is never indexed. */
export const INDEX_SKIP_DIR_NAMES: readonly string[] = ['.git', '.hg', '.svn', 'node_modules', '.ssh', '.gnupg', '.aws']
/** Time one `serve` round may spend embedding; the rest waits for the next minute. */
export const INDEX_SERVE_BUDGET_MS = 20_000

/** `search_files`. */
export const SEARCH_DEFAULT_LIMIT = 5
export const SEARCH_MAX_LIMIT = 20
export const SEARCH_QUERY_MAX_CHARS = 1000
export const SNIPPET_MAX_CHARS = 600
/** Rows fetched per result asked for, so the run-time rights check can drop some and still fill the answer. */
export const SEARCH_OVERFETCH = 4

/** First 8 bytes of sha256('mcpcut:files:index') as a signed bigint. */
export const INDEX_LOCK_KEY = '-6514132781421794227'
/** Search migrations are versioned from here, apart from the core schema's versions. */
export const SEARCH_MIGRATION_BASE = 1000
