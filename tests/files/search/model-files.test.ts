import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SEARCH_MODEL_BASE_URL, SEARCH_MODEL_DIR_NAME, type PinnedModelFile } from '../../../src/files/search/constants.js'
import {
  checkModelFiles,
  downloadModelFiles,
  modelDirOf,
  ModelDownloadError,
  type ModelFetch,
} from '../../../src/files/search/model-files.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-model-files-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const BIG = Buffer.from('a'.repeat(1000))
const SMALL = Buffer.from('{"k":1}')
const digest = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
const FILES: readonly PinnedModelFile[] = [
  { path: 'onnx/model.bin', size: BIG.length, sha256: digest(BIG) },
  { path: 'tokenizer.json', size: SMALL.length, sha256: digest(SMALL) },
]
const CONTENT: Record<string, Buffer> = { 'onnx/model.bin': BIG, 'tokenizer.json': SMALL }

function streamOf(buf: Buffer): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield buf.subarray(0, buf.length / 2)
    yield buf.subarray(buf.length / 2)
  })()
}

function okFetch(calls: string[], override: Partial<Record<string, Buffer>> = {}): ModelFetch {
  return async (url, init) => {
    calls.push(url)
    expect(init.redirect).toBe('follow')
    expect(Object.keys(init).sort()).toEqual(['redirect', 'signal'])
    const path = url.slice(SEARCH_MODEL_BASE_URL.length + 1)
    return { ok: true, status: 200, body: streamOf(override[path] ?? CONTENT[path]!) }
  }
}

describe('modelDirOf', () => {
  test('sits under models in the search folder', () => {
    expect(modelDirOf('/s')).toBe(join('/s', 'models', SEARCH_MODEL_DIR_NAME))
  })
})

describe('checkModelFiles', () => {
  test('reports missing, wrong-sized and non-regular files; hash mode also catches same-size changes', async () => {
    await mkdir(join(dir, 'onnx'))
    await writeFile(join(dir, 'onnx/model.bin'), Buffer.from('b'.repeat(1000)))
    expect(await checkModelFiles(dir, 'size', FILES)).toEqual(['tokenizer.json'])
    expect(await checkModelFiles(dir, 'hash', FILES)).toEqual(['onnx/model.bin', 'tokenizer.json'])
    await rm(join(dir, 'onnx/model.bin'))
    await writeFile(join(dir, 'real.json'), SMALL)
    await symlink(join(dir, 'real.json'), join(dir, 'tokenizer.json'))
    expect(await checkModelFiles(dir, 'size', FILES)).toEqual(['onnx/model.bin', 'tokenizer.json'])
  })
})

describe('downloadModelFiles', () => {
  test('downloads, verifies and renames into place with private modes, reporting progress', async () => {
    const calls: string[] = []
    const events: string[] = []
    await downloadModelFiles({ dir, fetch: okFetch(calls), cli: 'mcpcut', files: FILES, onProgress: (p) => events.push(`${p.event} ${p.path}`) })
    expect(calls).toEqual([`${SEARCH_MODEL_BASE_URL}/onnx/model.bin`, `${SEARCH_MODEL_BASE_URL}/tokenizer.json`])
    expect(await checkModelFiles(dir, 'hash', FILES)).toEqual([])
    expect((await stat(join(dir, 'onnx/model.bin'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'onnx'))).mode & 0o777).toBe(0o700)
    expect(await readdir(join(dir, 'onnx'))).toEqual(['model.bin'])
    expect(events).toEqual(['start onnx/model.bin', 'done onnx/model.bin', 'start tokenizer.json', 'done tokenizer.json'])
  })

  test('a file that already passes the hash check is not fetched again', async () => {
    await downloadModelFiles({ dir, fetch: okFetch([]), cli: 'mcpcut', files: FILES })
    const calls: string[] = []
    await downloadModelFiles({ dir, fetch: okFetch(calls), cli: 'mcpcut', files: FILES })
    expect(calls).toEqual([])
  })

  test('a stale .part from a crashed run is replaced', async () => {
    await mkdir(join(dir, 'onnx'), { recursive: true })
    await writeFile(join(dir, 'onnx/model.bin.part'), 'junk')
    await downloadModelFiles({ dir, fetch: okFetch([]), cli: 'mcpcut', files: FILES })
    expect(await checkModelFiles(dir, 'hash', FILES)).toEqual([])
    expect(await readdir(join(dir, 'onnx'))).toEqual(['model.bin'])
  })

  test('more bytes than pinned abort the download and leave nothing behind', async () => {
    const fetch = okFetch([], { 'onnx/model.bin': Buffer.from('a'.repeat(2000)) })
    await expect(downloadModelFiles({ dir, fetch, cli: 'mcpcut', files: FILES })).rejects.toThrow(/does not match its pinned hash/)
    expect(await readdir(join(dir, 'onnx'))).toEqual([])
  })

  test('a hash mismatch names the retry and leaves no file', async () => {
    const fetch = okFetch([], { 'tokenizer.json': Buffer.from('{"k":2}') })
    const failure = downloadModelFiles({ dir, fetch, cli: 'mcpcut', files: FILES })
    await expect(failure).rejects.toThrow('the downloaded tokenizer.json does not match its pinned hash: run `mcpcut files setup --search` again; if it repeats, the download is being altered on the way')
    expect(await readdir(dir)).toEqual(['onnx'])
  })

  test('a truncated body is a mismatch too', async () => {
    const fetch = okFetch([], { 'tokenizer.json': Buffer.from('{"k"') })
    await expect(downloadModelFiles({ dir, fetch, cli: 'mcpcut', files: FILES })).rejects.toBeInstanceOf(ModelDownloadError)
  })

  test('an HTTP error is one line with the proxy hint', async () => {
    const fetch: ModelFetch = async () => ({ ok: false, status: 404, body: null })
    await expect(downloadModelFiles({ dir, fetch, cli: 'mcpcut', files: FILES })).rejects.toThrow(
      'could not download onnx/model.bin (HTTP 404): check the network; behind a proxy set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`, then run `mcpcut files setup --search` again',
    )
  })

  test('a network error carries its reason', async () => {
    const fetch: ModelFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND huggingface.co')
    }
    await expect(downloadModelFiles({ dir, fetch, cli: 'mcpcut', files: FILES })).rejects.toThrow(/could not download onnx\/model\.bin \(getaddrinfo ENOTFOUND huggingface\.co\)/)
  })
})
