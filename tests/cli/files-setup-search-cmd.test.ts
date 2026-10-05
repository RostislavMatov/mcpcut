import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch } from '../../src/cli.js'
import type { NpmInvocation } from '../../src/cli/files-db-seams.js'
import { PG_PACKAGE_VERSION } from '../../src/files/db/constants.js'
import { SEARCH_MODEL_BASE_URL, ORT_PACKAGE_VERSION, TOKENIZERS_PACKAGE_VERSION, type PinnedModelFile } from '../../src/files/search/constants.js'
import { checkModelFiles, modelDirOf, type ModelFetch } from '../../src/files/search/model-files.js'
import { SEARCH_MODULES_PACKAGE_JSON, SEARCH_MODULES_PACKAGE_LOCK } from '../../src/files/search/search-lock.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import { createVaultStore } from '../../src/vault/store.js'
import { createFakeEmbedder } from '../files/search/fake-embedder.js'

/** `mcpcut files setup --search` with a fake npm, fake download and fake embedder: no network, no native code. */

let journalDir: string
beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-files-setup-search-'))
})
afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const modulesDir = () => join(journalDir, 'modules')
const searchDir = () => join(modulesDir(), 'search')

const BIG = Buffer.from('m'.repeat(2_500_000))
const SMALL = Buffer.from('{"t":1}')
const digest = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
const TEST_FILES: readonly PinnedModelFile[] = [
  { path: 'onnx/model_quantized.onnx', size: BIG.length, sha256: digest(BIG) },
  { path: 'tokenizer.json', size: SMALL.length, sha256: digest(SMALL) },
]
const CONTENT: Record<string, Buffer> = { 'onnx/model_quantized.onnx': BIG, 'tokenizer.json': SMALL }

function servingFetch(urls: string[]): ModelFetch {
  return async (url) => {
    urls.push(url)
    return { ok: true, status: 200, body: (async function* () { yield CONTENT[url.slice(SEARCH_MODEL_BASE_URL.length + 1)]! })() }
  }
}

async function installPg(): Promise<void> {
  const dir = join(modulesDir(), 'node_modules', 'pg')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'pg', version: PG_PACKAGE_VERSION }))
}

async function fakeInstalledRuntime(): Promise<void> {
  for (const [name, version] of [['onnxruntime-node', ORT_PACKAGE_VERSION], ['@huggingface/tokenizers', TOKENIZERS_PACKAGE_VERSION]] as const) {
    const dir = join(searchDir(), 'node_modules', ...name.split('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
}

interface Calls {
  npm: NpmInvocation[]
  urls: string[]
  embedders: ReturnType<typeof createFakeEmbedder>[]
}

async function run(extra: { pinned?: boolean; platform?: NodeJS.Platform; arch?: string; npmCode?: number; fetch?: ModelFetch; failEmbed?: boolean; args?: string[]; skipRuntime?: boolean } = {}) {
  const calls: Calls = { npm: [], urls: [], embedders: [] }
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } }
  const code = await dispatch(['files', 'setup', ...(extra.args ?? ['--search'])], io, {
    files: {
      journalDir,
      env: {},
      db: {
        platform: extra.platform ?? 'darwin',
        arch: extra.arch ?? 'arm64',
        loadPg: async () => ({ Pool: class {} as never }),
        runNpm: async (invocation) => {
          calls.npm.push(invocation)
          if (invocation.cwd === searchDir() && (extra.npmCode ?? 0) === 0 && extra.skipRuntime !== true) await fakeInstalledRuntime()
          return invocation.cwd === searchDir() ? (extra.npmCode ?? 0) : 0
        },
        ...(extra.pinned === true ? {} : { modelFiles: TEST_FILES }),
        fetch: extra.fetch ?? servingFetch(calls.urls),
        createEmbedder: async () => {
          if (extra.failEmbed) throw new Error('native crash')
          const embedder = createFakeEmbedder()
          calls.embedders.push(embedder)
          return embedder
        },
      },
    },
  })
  return { code, out: out.join(''), err: err.join(''), calls }
}

describe('files setup --search', () => {
  test('an unsupported platform is one line and exit 1, before anything is installed', async () => {
    await installPg()
    const result = await run({ platform: 'darwin', arch: 'x64' })
    expect(result.code).toBe(1)
    expect(result.err).toBe(
      'search by meaning needs macOS on Apple silicon, Linux or Windows (x64 or arm64): the local model runtime has no build for darwin-x64; everything else in the file module works\n',
    )
    expect(result.calls.npm).toEqual([])
  })

  test('installs the runtime tree with the pinned files and constant npm arguments', async () => {
    await installPg()
    const result = await run()
    expect(JSON.parse(await readFile(join(searchDir(), 'package.json'), 'utf8'))).toEqual(SEARCH_MODULES_PACKAGE_JSON)
    expect(JSON.parse(await readFile(join(searchDir(), 'package-lock.json'), 'utf8'))).toEqual(SEARCH_MODULES_PACKAGE_LOCK)
    expect((await stat(searchDir())).mode & 0o777).toBe(0o700)
    expect(result.calls.npm).toEqual([
      { command: 'npm', args: ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'], cwd: searchDir(), shell: false },
    ])
    expect(result.out).toContain('installing the search runtime')
  })

  test('runs the Postgres client part first when it is missing', async () => {
    const result = await run()
    expect(result.calls.npm.map((call) => call.cwd)).toEqual([modulesDir(), searchDir()])
    expect(result.out).toContain(`installed pg ${PG_PACKAGE_VERSION}`)
  })

  test('downloads the model with progress, verifies it, smoke-tests the embedder and closes it', async () => {
    await installPg()
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.calls.urls).toEqual([`${SEARCH_MODEL_BASE_URL}/onnx/model_quantized.onnx`, `${SEARCH_MODEL_BASE_URL}/tokenizer.json`])
    expect(result.out).toContain('downloading onnx/model_quantized.onnx (3 MB)… ok\n')
    expect(result.out).toContain('downloading tokenizer.json (1 KB)… ok\n')
    expect(await checkModelFiles(modelDirOf(searchDir()), 'hash', TEST_FILES)).toEqual([])
    expect(result.calls.embedders).toHaveLength(1)
    expect(result.calls.embedders[0]!.calls).toEqual([{ kind: 'query', text: 'test' }])
    expect(result.calls.embedders[0]!.isClosed()).toBe(true)
    expect(result.out).toMatch(/installed search by meaning: onnxruntime-node 1\.30\.0, model multilingual-e5-small \(\d+ MB\) in /)
  })

  test('a second run fetches nothing and runs no npm', async () => {
    await installPg()
    await run()
    const again = await run()
    expect(again.code).toBe(0)
    expect(again.calls.npm).toEqual([])
    expect(again.calls.urls).toEqual([])
    expect(again.out).toContain('already installed')
    expect(again.out).toContain('already in place and verified')
  })

  test('a failing npm is one line with the retry step', async () => {
    await installPg()
    const result = await run({ npmCode: 9 })
    expect(result.code).toBe(1)
    expect(result.err).toBe('npm exited with code 9: check your network and run `mcpcut files setup --search` again\n')
  })

  test('npm succeeding without the pinned versions is refused', async () => {
    await installPg()
    const result = await run({ skipRuntime: true })
    expect(result.code).toBe(1)
    expect(result.err).toContain('not at the pinned versions')
  })

  test('a failed download is one line, the open progress line is closed, exit 1', async () => {
    await installPg()
    const result = await run({ fetch: async () => ({ ok: false, status: 503, body: null }) })
    expect(result.code).toBe(1)
    expect(result.out).toContain('downloading onnx/model_quantized.onnx (3 MB)… failed\n')
    expect(result.err).toContain('could not download onnx/model_quantized.onnx (HTTP 503)')
  })

  test('a download that does not match the pinned hash is refused and leaves no model', async () => {
    await installPg()
    const result = await run({ pinned: true })
    expect(result.code).toBe(1)
    expect(result.err).toContain('does not match its pinned hash')
    expect(await checkModelFiles(modelDirOf(searchDir()), 'size')).toHaveLength(3)
  })

  test('a failing smoke embedding says what happened and to run setup again', async () => {
    await installPg()
    const result = await run({ failEmbed: true })
    expect(result.code).toBe(1)
    expect(result.err).toBe('the search runtime was installed but a test embedding failed (native crash): run `mcpcut files setup --search` again\n')
  })
})

describe('files setup --search: the next step', () => {
  test('Postgres not configured: db init', async () => {
    await installPg()
    const result = await run()
    expect(result.err).toBe('Next: mcpcut files db init\n')
  })

  async function turnPostgresOn(): Promise<void> {
    const vault = createVaultStore({ journalDir })
    await vault.init()
    await vault.setSecret(FILES_PG_URL_SECRET, 'postgres://u:p@127.0.0.1:1/db')
  }

  test('Postgres on, no root: root add', async () => {
    await installPg()
    await turnPostgresOn()
    const result = await run()
    expect(result.err).toBe('Next: mcpcut files root add <folder>\n')
  })

  test('Postgres on and a root: index on that root, shell-quoted', async () => {
    await installPg()
    await turnPostgresOn()
    const root = join(journalDir, 'my notes')
    await mkdir(root)
    await createRootsStore({ journalDir }).add(root)
    const result = await run()
    expect(result.err).toMatch(/^Next: mcpcut files index on '.*my notes'\n$/)
  })
})

describe('files setup without --search', () => {
  test('rejects other arguments with the usage line', async () => {
    const result = await run({ args: ['--searhc'] })
    expect(result.code).toBe(1)
    expect(result.err).toBe('usage: mcpcut files setup [--search]\n')
  })
})
