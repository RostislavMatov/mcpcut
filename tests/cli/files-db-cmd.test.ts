import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import type { FilesDb } from '../../src/files/db/connection.js'
import { FILES_PG_URL_SECRET, PG_PACKAGE_VERSION } from '../../src/files/db/constants.js'
import { SEARCH_MODEL_FILES } from '../../src/files/search/constants.js'
import { modelDirOf } from '../../src/files/search/model-files.js'
import { FilesDbModuleMissingError, loadPg } from '../../src/files/db/pg-loader.js'
import type { PgModule } from '../../src/files/db/pg-types.js'
import { createVaultStore } from '../../src/vault/store.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** `mcpcut files db init|status` through the dispatcher, on temp dirs only. */

let journalDir: string
let token: string
const opened: FilesDb[] = []
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-files-db-cmd-'))
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(journalDir, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

interface RunOptions {
  readonly withToken?: boolean
  readonly clientInstalled?: boolean
  readonly schema?: string
  /** A client whose every connection is refused, as when nothing listens on the port. */
  readonly refusingClient?: boolean
}

/** A pg stand-in that cannot reach anything: the bundled URL's port may be in use on a developer machine. */
const REFUSING_PG = {
  Pool: class {
    private readonly refusal = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    connect = this.refusal
    query = this.refusal
    end = () => Promise.resolve()
    on = () => this
  },
} as unknown as PgModule

async function db(args: string[], run: RunOptions = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const installed = run.clientInstalled ?? true
  const code = await dispatch(['files', 'db', ...args], io, {
    files: {
      journalDir,
      env: run.withToken === false ? {} : { [ADMIN_TOKEN_ENV_VAR]: token },
      db: {
        loadPg: !installed
          ? () => Promise.reject(new FilesDbModuleMissingError())
          : run.refusingClient === true
            ? () => Promise.resolve(REFUSING_PG)
            : () => loadPg(process.cwd()),
        ...(run.schema !== undefined ? { schema: run.schema } : {}),
        onOpen: (opened_) => opened.push(opened_),
      },
    },
  })
  return { code, out: out.join(''), err: err.join('') }
}

async function initVaultAndOwner(): Promise<void> {
  await createVaultStore({ journalDir }).init()
  token = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
}

async function setUrl(url: string): Promise<void> {
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, url)
}

async function everyFile(dir: string): Promise<Array<{ path: string; text: string }>> {
  const found: Array<{ path: string; text: string }> = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await everyFile(path)))
    else found.push({ path, text: (await readFile(path)).toString('latin1') })
  }
  return found
}

describe('files db init: first run', () => {
  test('prints the docker command, keeps the password out of every output and the journal', async () => {
    await initVaultAndOwner()
    const result = await db(['init'])

    expect(result.code).toBe(0)
    const envFile = join(journalDir, 'modules', 'postgres.env')
    expect(result.out).toBe(
      `docker run -d --name mcpcut-postgres --restart unless-stopped -p 127.0.0.1:55432:5432 --env-file ${envFile} -v mcpcut-postgres:/var/lib/postgresql pgvector/pgvector:pg18\n`,
    )
    expect(result.err).toContain('When it is running (a few seconds): mcpcut files db init\n')
    expect(result.err).toContain("Own Postgres instead? printf '%s' 'postgres://user:pass@host:5432/db' | mcpcut vault set files-pg-url\n")
    expect(result.err).toContain('[audit] vault set by alice (owner): files-pg-url')

    const content = await readFile(envFile, 'utf8')
    const password = /POSTGRES_PASSWORD=(\S+)/.exec(content)?.[1] ?? ''
    expect(content).toBe(`POSTGRES_USER=mcpcut\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=mcpcut\n`)
    expect(Buffer.from(password, 'base64url')).toHaveLength(32)
    expect((await stat(envFile)).mode & 0o777).toBe(0o600)

    const stored = await createVaultStore({ journalDir }).readSecretValues([FILES_PG_URL_SECRET])
    expect(stored).toEqual({ status: 'read', values: { [FILES_PG_URL_SECRET]: `postgres://mcpcut:${password}@127.0.0.1:55432/mcpcut` } })

    expect(result.out + result.err).not.toContain(password)
    for (const file of await everyFile(journalDir)) {
      if (file.path === envFile) continue
      expect(file.text, file.path).not.toContain(password)
    }
  })

  test('a rerun without the secret reuses the env file password', async () => {
    await initVaultAndOwner()
    await db(['init'])
    const envFile = join(journalDir, 'modules', 'postgres.env')
    const before = await readFile(envFile, 'utf8')
    await createVaultStore({ journalDir }).removeSecret(FILES_PG_URL_SECRET)

    const again = await db(['init'])

    expect(again.code).toBe(0)
    expect(await readFile(envFile, 'utf8')).toBe(before)
    const password = /POSTGRES_PASSWORD=(\S+)/.exec(before)?.[1] ?? ''
    const stored = await createVaultStore({ journalDir }).readSecretValues([FILES_PG_URL_SECRET])
    expect(stored.status === 'read' && stored.values[FILES_PG_URL_SECRET]).toContain(`:${password}@`)
  })

  test('a malformed env file is refused by name and nothing is stored', async () => {
    await initVaultAndOwner()
    await mkdir(join(journalDir, 'modules'), { recursive: true })
    await writeFile(join(journalDir, 'modules', 'postgres.env'), 'POSTGRES_USER=mcpcut\n')
    const result = await db(['init'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('postgres.env is malformed')
    expect(await createVaultStore({ journalDir }).readSecretValues([FILES_PG_URL_SECRET])).toEqual({ status: 'read', values: {} })
  })

  test('without a token it is the files refusal and nothing is written', async () => {
    await initVaultAndOwner()
    const result = await db(['init'], { withToken: false })
    expect(result.code).toBe(1)
    expect(result.err).toContain('MCP_ADMIN_TOKEN')
    expect(result.err).toMatch(/^Refusing to change the vault/)
    await expect(stat(join(journalDir, 'modules', 'postgres.env'))).rejects.toThrow()
    expect(await createVaultStore({ journalDir }).readSecretValues([FILES_PG_URL_SECRET])).toEqual({ status: 'read', values: {} })
  })

  test('without the client it is the setup line, before the vault is touched', async () => {
    const result = await db(['init'], { clientInstalled: false, withToken: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe('Postgres support is not installed: run `mcpcut files setup`\n')
  })

  test('with an uninitialized vault it names vault init', async () => {
    const result = await db(['init'], { withToken: false })
    expect(result.code).toBe(1)
    expect(result.err).toContain('`mcpcut vault init`')
  })

  test('an unknown form prints the usage', async () => {
    const result = await db(['nope'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('files db init')
  })
})

describe('files db init: with the secret set', () => {
  test('an unreachable server is one line and exit 1, without the password', async () => {
    await initVaultAndOwner()
    await setUrl('postgres://mcpcut:hunter2-secret@127.0.0.1:1/mcpcut')
    const result = await db(['init'], { withToken: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe('Postgres at 127.0.0.1:1 is not reachable: check that it is running and accepts connections from this machine, then `mcpcut files db status`\n')
    expect(result.out + result.err).not.toContain('hunter2')
  })

  test('the bundled container, unreachable, gets both ways to start it and the step after', async () => {
    await initVaultAndOwner()
    const first = await db(['init'], { refusingClient: true })
    expect(first.code).toBe(0)
    const result = await db(['init'], { withToken: false, refusingClient: true })
    const envFile = join(journalDir, 'modules', 'postgres.env')
    expect(result.code).toBe(1)
    expect(result.err.split('\n')).toEqual([
      'Postgres at 127.0.0.1:55432 is not reachable. Start it: docker start mcpcut-postgres',
      `Never created? ${first.out.trim()}`,
      'Then: mcpcut files db init',
      '',
    ])
    expect(first.out).toContain(envFile)
    const password = (await readFile(envFile, 'utf8')).match(/POSTGRES_PASSWORD=(.+)/)?.[1] ?? 'missing'
    expect(result.out + result.err).not.toContain(password)
  })

  test('a value that is not a postgres URL says how to replace it', async () => {
    await initVaultAndOwner()
    await setUrl('http://example.com/x')
    const result = await db(['init'], { withToken: false })
    expect(result.code).toBe(1)
    expect(result.err).toContain("replace it with `printf '%s' '<url>' | mcpcut vault set files-pg-url`")
  })

  describePg('on a real Postgres', () => {
    test('connects, migrates and reports the version without a token', async () => {
      await initVaultAndOwner()
      await setUrl(PG_URL)
      const { schema, cleanup } = withTestSchema()
      cleanups.push(cleanup)

      const result = await db(['init'], { withToken: false, schema })

      expect(result.code).toBe(0)
      expect(result.out).toBe(`Postgres ready: postgres://mcpcut@127.0.0.1:55439/mcpcut_test (schema ${schema}, version 1)\n`)
      expect(result.err).toBe('Next: mcpcut files db sync\n')
      expect(result.out + result.err).not.toContain('mcpcut-test@')
    })
  })
})

const SEARCH_NOT_INSTALLED =
  'search runtime: not installed (run `mcpcut files setup --search`)\nsearch model: not installed (run `mcpcut files setup --search`)\n'

describe('files db status', () => {
  test('client not installed and mode off: the setup step', async () => {
    await initVaultAndOwner()
    const result = await db(['status'], { clientInstalled: false })
    expect(result.code).toBe(0)
    expect(result.out).toBe(`client: not installed\n${SEARCH_NOT_INSTALLED}url: off\n`)
    expect(result.err).toBe('Next: mcpcut files setup\n')
  })

  test('client installed and mode off: turn it on', async () => {
    await initVaultAndOwner()
    await mkdir(join(journalDir, 'modules', 'node_modules', 'pg'), { recursive: true })
    await writeFile(join(journalDir, 'modules', 'node_modules', 'pg', 'package.json'), JSON.stringify({ version: PG_PACKAGE_VERSION }))
    const result = await db(['status'])
    expect(result.out).toBe(`client: installed pg ${PG_PACKAGE_VERSION}\n${SEARCH_NOT_INSTALLED}url: off\n`)
    expect(result.err).toBe('Turn it on: mcpcut files db init\n')
  })

  test('the search block reports an installed runtime and a complete model', async () => {
    await initVaultAndOwner()
    const searchDir = join(journalDir, 'modules', 'search')
    for (const [name, version] of [['onnxruntime-node', '1.30.0'], ['@huggingface/tokenizers', '0.2.0']] as const) {
      await mkdir(join(searchDir, 'node_modules', ...name.split('/')), { recursive: true })
      await writeFile(join(searchDir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ version }))
    }
    for (const file of SEARCH_MODEL_FILES) {
      const path = join(modelDirOf(searchDir), ...file.path.split('/'))
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, '')
      await truncate(path, file.size)
    }
    const result = await db(['status'])
    expect(result.out).toContain('search runtime: installed onnxruntime-node 1.30.0, tokenizers 0.2.0\nsearch model: ok\n')
  })

  test('a half-downloaded model names the missing file and the setup command', async () => {
    await initVaultAndOwner()
    const dir = modelDirOf(join(journalDir, 'modules', 'search'))
    const file = SEARCH_MODEL_FILES.find((candidate) => candidate.path === 'tokenizer_config.json')!
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tokenizer_config.json'), '')
    await truncate(join(dir, 'tokenizer_config.json'), file.size)
    const result = await db(['status'])
    expect(result.out).toContain('search model: incomplete (onnx/model_quantized.onnx, tokenizer.json) (run `mcpcut files setup --search`)\n')
  })

  test('an uninitialized vault is the vault init step', async () => {
    const result = await db(['status'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('`mcpcut vault init`')
  })

  test('an unreachable server shows the URL without the password and the start step', async () => {
    await initVaultAndOwner()
    await setUrl('postgres://mcpcut:hunter2-secret@127.0.0.1:1/mcpcut')
    const result = await db(['status'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('url: postgres://mcpcut@127.0.0.1:1/mcpcut\nserver: unavailable\n')
    expect(result.err).toContain('check that it is running')
    expect(result.out + result.err).not.toContain('hunter2')
  })

  test('an invalid URL is reported without echoing it', async () => {
    await initVaultAndOwner()
    await setUrl('mysql://u:hunter2@h/d')
    const result = await db(['status'])
    expect(result.code).toBe(1)
    expect(result.out).toBe(`client: not installed\n${SEARCH_NOT_INSTALLED}url: invalid\n`)
    expect(result.out + result.err).not.toContain('hunter2')
  })

  test('the client is missing while the URL is set: the setup line', async () => {
    await initVaultAndOwner()
    await setUrl(PG_URL || 'postgres://mcpcut:pw@127.0.0.1:55439/x')
    const result = await db(['status'], { clientInstalled: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe('Postgres support is not installed: run `mcpcut files setup`\n')
  })

  describePg('on a real Postgres', () => {
    test('schema not created yet: the init step', async () => {
      await initVaultAndOwner()
      await setUrl(PG_URL)
      const { schema, cleanup } = withTestSchema()
      cleanups.push(cleanup)
      const result = await db(['status'], { schema })
      expect(result.err).not.toContain('Postgres error')
      expect(result.code).toBe(0)
      expect(result.out).toContain(`server: reachable, schema ${schema} not created yet\n`)
      expect(result.err).toBe('Next: mcpcut files db init\n')
    })

    test('after init: version, counts and how far the index has caught up', async () => {
      await initVaultAndOwner()
      await setUrl(PG_URL)
      const { schema, cleanup } = withTestSchema()
      cleanups.push(cleanup)
      await db(['init'], { schema })

      const result = await db(['status'], { schema })

      expect(result.code).toBe(0)
      expect(result.out).toContain(`server: reachable, schema ${schema}, version 1\ncatalog: 0 rows\nfile events: 0 rows, synced through record 0 of 0\n`)
      expect(result.err).toBe('Next: mcpcut files db sync\n')
    })
  })
})
