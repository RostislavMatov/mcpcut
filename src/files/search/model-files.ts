import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SEARCH_MODEL_BASE_URL, SEARCH_MODEL_DIR_NAME, SEARCH_MODEL_FILES, type PinnedModelFile } from './constants.js'

/**
 * The pinned model files (ADR-0020 §6): downloaded once by `files setup
 * --search` from fixed URLs — a plain GET, no headers, no cookies — verified
 * by size and sha256, and only then renamed into place. Nothing else is ever
 * fetched at run time.
 */

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

export function modelDirOf(searchDir: string): string {
  return join(searchDir, 'models', SEARCH_MODEL_DIR_NAME)
}

export function modelFilePath(dir: string, file: PinnedModelFile): string {
  return join(dir, ...file.path.split('/'))
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function isFileValid(dir: string, file: PinnedModelFile, mode: 'size' | 'hash'): Promise<boolean> {
  const path = modelFilePath(dir, file)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size !== file.size) return false
    return mode === 'size' || (await sha256OfFile(path)) === file.sha256
  } catch {
    return false
  }
}

/** The pinned paths that are missing or wrong. `size` is a stat; `hash` also reads the file. */
export async function checkModelFiles(dir: string, mode: 'size' | 'hash', files: readonly PinnedModelFile[] = SEARCH_MODEL_FILES): Promise<string[]> {
  const checks = await Promise.all(files.map(async (file) => ({ file, ok: await isFileValid(dir, file, mode) })))
  return checks.filter((check) => !check.ok).map((check) => check.file.path)
}

export interface ModelFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: AsyncIterable<Uint8Array> | null
}

export type ModelFetch = (url: string, init: { redirect: 'follow'; signal: AbortSignal }) => Promise<ModelFetchResponse>

export interface DownloadProgress {
  readonly path: string
  readonly size: number
  readonly event: 'start' | 'done'
}

export interface DownloadOptions {
  readonly dir: string
  readonly fetch: ModelFetch
  readonly cli: string
  readonly onProgress?: (progress: DownloadProgress) => void
  readonly signal?: AbortSignal
  /** Only for tests: the pinned list to use instead of the real model. */
  readonly files?: readonly PinnedModelFile[]
}

/** The download failed; the message already says what to do. */
export class ModelDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelDownloadError'
  }
}

function networkMessage(path: string, reason: string, cli: string): string {
  return `could not download ${path} (${reason}): check the network; behind a proxy set \`NODE_USE_ENV_PROXY=1\` and \`HTTPS_PROXY\`, then run \`${cli} files setup --search\` again`
}

function mismatchMessage(path: string, cli: string): string {
  return `the downloaded ${path} does not match its pinned hash: run \`${cli} files setup --search\` again; if it repeats, the download is being altered on the way`
}

async function removeQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

async function streamToPart(body: AsyncIterable<Uint8Array>, part: string, file: PinnedModelFile, cli: string): Promise<string> {
  const handle = await open(part, 'wx', FILE_MODE)
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of body) {
      received += chunk.byteLength
      if (received > file.size) throw new ModelDownloadError(mismatchMessage(file.path, cli))
      hash.update(chunk)
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
  if (received !== file.size) throw new ModelDownloadError(mismatchMessage(file.path, cli))
  return hash.digest('hex')
}

async function downloadOne(file: PinnedModelFile, opts: DownloadOptions): Promise<void> {
  const target = modelFilePath(opts.dir, file)
  const part = `${target}.part`
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE })
  await removeQuietly(part)
  const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])])
  try {
    const response = await opts.fetch(`${SEARCH_MODEL_BASE_URL}/${file.path}`, { redirect: 'follow', signal })
    if (!response.ok || response.body === null) throw new ModelDownloadError(networkMessage(file.path, `HTTP ${response.status}`, opts.cli))
    const digest = await streamToPart(response.body, part, file, opts.cli)
    if (digest !== file.sha256) throw new ModelDownloadError(mismatchMessage(file.path, opts.cli))
    await chmod(part, FILE_MODE)
    await rename(part, target)
  } catch (error: unknown) {
    await removeQuietly(part)
    if (error instanceof ModelDownloadError) throw error
    throw new ModelDownloadError(networkMessage(file.path, error instanceof Error ? error.message : String(error), opts.cli))
  }
}

/** Fetches every pinned file that does not already pass the hash check, one after another. */
export async function downloadModelFiles(opts: DownloadOptions): Promise<void> {
  await mkdir(opts.dir, { recursive: true, mode: DIR_MODE })
  for (const file of opts.files ?? SEARCH_MODEL_FILES) {
    if (await isFileValid(opts.dir, file, 'hash')) continue
    opts.onProgress?.({ path: file.path, size: file.size, event: 'start' })
    await downloadOne(file, opts)
    opts.onProgress?.({ path: file.path, size: file.size, event: 'done' })
  }
}
