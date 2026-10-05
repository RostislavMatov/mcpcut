import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import type { FilesDb } from '../../src/files/db/connection.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import { SEARCH_MODEL_ID } from '../../src/files/search/constants.js'
import { createIndexRulesStore } from '../../src/files/search/index-rules-store.js'
import { createVaultStore } from '../../src/vault/store.js'
import { createFakeEmbedder } from '../files/search/fake-embedder.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** `mcpcut files index on|off|list` and the index block of `files db status`, on temp dirs only. */

let base: string
let journalDir: string
let folder: string
let token: string
const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []
const SETUP_LINE = 'search by meaning is not installed: run `mcpcut files setup --search`'

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-index-cmd-')))
  journalDir = join(base, 'state')
  folder = join(base, 'data')
  await mkdir(journalDir, { recursive: true })
  await mkdir(join(folder, 'private'), { recursive: true })
  await createVaultStore({ journalDir }).init()
  token = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
  await run(['root', 'add', folder], { token })
})
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(base, { recursive: true, force: true })
})

interface RunOptions {
  readonly token?: string
  readonly schema?: string
  readonly problem?: string | null
}

async function run(args: string[], extra: RunOptions = {}) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', ...args], io, {
    files: {
      journalDir,
      env: extra.token === undefined ? {} : { [ADMIN_TOKEN_ENV_VAR]: extra.token },
      db: {
        loadPg: () => loadPg(process.cwd()),
        ...(extra.schema !== undefined ? { schema: extra.schema } : {}),
        onOpen: (db) => opened.push(db),
        searchProblem: async () => (extra.problem === undefined ? SETUP_LINE : extra.problem),
        indexEmbedder: async () => createFakeEmbedder(SEARCH_MODEL_ID),
      },
    },
  })
  return { code, out: out.join(''), err: err.join('') }
}

const rulesOf = async () => (await createIndexRulesStore({ journalDir }).list()).map((rule) => [rule.path, rule.enabled])

describe('files index on', () => {
  test('stores the rule, says so, and points at Postgres when it is off', async () => {
    const result = await run(['index', 'on', folder], { token })

    expect(result.code).toBe(0)
    expect(result.out).toBe(`search index: on for ${folder} and its subfolders\n`)
    expect(result.err).toContain('Next: mcpcut files db init\n')
    expect(result.err).toContain(`[audit] files set by alice (owner): ${folder}\n`)
    expect(await rulesOf()).toEqual([[folder, true]])
  })

  test('leaves an access-edit record that files audit shows', async () => {
    await run(['index', 'on', folder], { token })

    const audit = await run(['audit', '--path', folder])

    expect(audit.out).toContain('files.index.on')
  })

  test('with Postgres on but no runtime, the next step is files setup --search', async () => {
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL === '' ? 'postgres://u:p@127.0.0.1:1/db' : PG_URL)

    const result = await run(['index', 'on', folder], { token })

    expect(result.err).toContain('Next: mcpcut files setup --search\n')
  })

  test('with Postgres on and the runtime ready, the next step is the sync and serve is mentioned', async () => {
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, 'postgres://u:p@127.0.0.1:1/db')

    const result = await run(['index', 'on', folder], { token, problem: null })

    expect(result.err).toContain('Next: mcpcut files db sync  (mcpcut serve keeps it current)\n')
  })

  test('needs an owner token and changes nothing without one', async () => {
    const result = await run(['index', 'on', folder])

    expect(result.code).toBe(1)
    expect(result.out).toBe('')
    expect(await rulesOf()).toEqual([])
  })

  test('refuses a folder outside every declared root with the root add command', async () => {
    const outside = join(base, 'elsewhere')
    await mkdir(outside)

    const result = await run(['index', 'on', outside], { token })

    expect(result).toMatchObject({ code: 1, out: '' })
    expect(result.err).toBe(`${outside} is not inside a declared root: run \`mcpcut files root add ${outside}\` first\n`)
  })

  test('refuses a path that is not a folder, or does not exist', async () => {
    await writeFile(join(folder, 'a.md'), 'x')

    const file = await run(['index', 'on', join(folder, 'a.md')], { token })
    const missing = await run(['index', 'on', join(folder, 'nope')], { token })

    expect(file.err).toContain('is not a folder that exists')
    expect(missing.err).toContain('is not a folder that exists')
    expect(await rulesOf()).toEqual([])
  })

  test('without an argument it prints the usage line', async () => {
    expect((await run(['index', 'on'], { token })).err).toBe('usage: mcpcut files index on <folder>\n')
  })
})

describe('files index off', () => {
  test('removes the rule of a folder that has no wider rule above it', async () => {
    await run(['index', 'on', folder], { token })

    const result = await run(['index', 'off', folder], { token })

    expect(result.code).toBe(0)
    expect(result.out).toBe(`search index: off for ${folder}\n`)
    expect(result.err).toContain('Next: mcpcut files index list')
    expect(result.err).toContain(`[audit] files remove by alice (owner): ${folder}\n`)
    expect(await rulesOf()).toEqual([])
  })

  test('cuts a subfolder out of an indexed folder, and says so again when repeated', async () => {
    await run(['index', 'on', folder], { token })
    const sub = join(folder, 'private')

    const cut = await run(['index', 'off', sub], { token })
    const again = await run(['index', 'off', sub], { token })

    expect(cut.out).toBe(`search index: ${sub} cut out of the index (its parent folder stays indexed)\n`)
    expect(again.out).toBe(`${sub} is already cut out of the index\n`)
    expect(await rulesOf()).toEqual([
      [folder, true],
      [sub, false],
    ])
  })

  test('a folder with no rule is not indexed: exit 0 and no record', async () => {
    const result = await run(['index', 'off', folder], { token })

    expect(result).toMatchObject({ code: 0, out: `${folder} is not indexed\n` })
    expect(result.err).not.toContain('[audit]')
  })

  test('needs an owner token', async () => {
    await run(['index', 'on', folder], { token })

    expect((await run(['index', 'off', folder])).code).toBe(1)
    expect(await rulesOf()).toEqual([[folder, true]])
  })

  test('works for a folder that was deleted since', async () => {
    await run(['index', 'on', join(folder, 'private')], { token })
    await rm(join(folder, 'private'), { recursive: true })

    const result = await run(['index', 'off', join(folder, 'private')], { token })

    expect(result.out).toBe(`search index: off for ${join(folder, 'private')}\n`)
  })
})

describe('files index list', () => {
  test('an empty list says how to fill it, with the first root, and needs no token', async () => {
    const result = await run(['index', 'list'])

    expect(result).toMatchObject({ code: 0, out: '(no folder is indexed)\n' })
    expect(result.err).toBe(`no folder is indexed: run \`mcpcut files index on ${folder}\`\n`)
  })

  test('lists rules and the runtime line without a token, with the Postgres step when it is off', async () => {
    await run(['index', 'on', folder], { token })
    await run(['index', 'off', join(folder, 'private')], { token })

    const result = await run(['index', 'list'])

    expect(result.code).toBe(0)
    expect(result.out.split('\n')).toEqual([
      `on   ${folder}`,
      `off  ${join(folder, 'private')}  (cut out)`,
      `counts need Postgres: mcpcut files db init`,
      `runtime: ${SETUP_LINE}`,
      '',
    ])
    expect(result.err).toBe('Next: mcpcut files db init\n')
  })
})

describePg('files index list and status on a real Postgres', () => {
  test('shows per-rule counts after a sync, and the totals in files db status', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
    await writeFile(join(folder, 'a.md'), 'alpha')
    await writeFile(join(folder, 'b.md'), 'beta')
    await writeFile(join(folder, '.env'), 'TOKEN=1')
    await writeFile(join(folder, 'private', 'p.md'), 'hidden')
    await run(['index', 'on', folder], { token, schema })
    await run(['index', 'off', join(folder, 'private')], { token, schema })
    const synced = await run(['db', 'sync'], { schema })

    const list = await run(['index', 'list'], { schema, problem: null })
    const status = await run(['db', 'status'], { schema })

    expect(synced.out).toContain('search index: 2 files indexed, 1 skipped (1 secret-like name), 0 pending, 0 failed')
    expect(list.out).toContain(`on   ${folder}  2 files, 2 chunks, 1 skipped, 0 pending\n`)
    expect(list.out).toContain('runtime: ready\n')
    expect(list.err).toContain('files grant')
    expect(status.out).toMatch(/^search index: 2 files indexed \(2 chunks\), 1 skipped, last indexed \d{4}-\d\d-\d\dT[\d:.]+Z$/m)
  })

  test('turning the folder off clears the index at the next sync, and status reports zero', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
    await writeFile(join(folder, 'a.md'), 'alpha')
    await run(['index', 'on', folder], { token, schema })
    await run(['db', 'sync'], { schema })
    await run(['index', 'off', folder], { token, schema })

    const synced = await run(['db', 'sync'], { schema })
    const status = await run(['db', 'status'], { schema })

    expect(synced.out).toContain('1 removed')
    expect(status.out).toContain('search index: 0 files indexed (0 chunks), 0 skipped, nothing indexed yet')
  })

  test('a database that never used search shows no index line in status', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
    await run(['db', 'sync'], { schema })

    expect((await run(['db', 'status'], { schema })).out).not.toContain('search index')
  })
})
