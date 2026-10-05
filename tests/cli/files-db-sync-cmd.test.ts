import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import { openFilesDb, type FilesDb } from '../../src/files/db/connection.js'
import { FilesDbModuleMissingError, loadPg } from '../../src/files/db/pg-loader.js'
import { createVaultStore } from '../../src/vault/store.js'
import { call, writeJournal } from '../files/db/journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** `mcpcut files db sync` through the dispatcher, on temp dirs only. */

let base: string
let journalDir: string
let folder: string
const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-db-sync-')))
  journalDir = join(base, 'state')
  folder = join(base, 'data')
  await mkdir(journalDir, { recursive: true })
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(base, { recursive: true, force: true })
})

async function files(args: string[], schema?: string, installed = true) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', ...args], io, {
    files: {
      journalDir,
      env: {},
      db: {
        loadPg: installed ? () => loadPg(process.cwd()) : () => Promise.reject(new FilesDbModuleMissingError()),
        ...(schema !== undefined ? { schema } : {}),
        onOpen: (db) => opened.push(db),
      },
    },
  })
  return { code, out: out.join(''), err: err.join('') }
}

async function declareRoot(): Promise<void> {
  await createVaultStore({ journalDir }).init()
  const owner = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
  const out: string[] = []
  const io = { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => out.push(c) } }
  await dispatch(['files', 'root', 'add', folder], io, { files: { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: owner.token } } })
}

describe('files db sync: states', () => {
  test('without the client it is the setup line', async () => {
    const result = await files(['db', 'sync'], undefined, false)
    expect(result).toMatchObject({ code: 1, out: '', err: 'Postgres support is not installed: run `mcpcut files setup`\n' })
  })

  test('with Postgres off it says how to turn it on', async () => {
    await createVaultStore({ journalDir }).init()
    const result = await files(['db', 'sync'])
    expect(result.code).toBe(1)
    expect(result.err).toBe('Postgres is not turned on: run `mcpcut files db init`\n')
  })

  test('an unreachable server is one line without the password', async () => {
    await createVaultStore({ journalDir }).init()
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, 'postgres://u:pw-secret@127.0.0.1:1/db')
    const result = await files(['db', 'sync'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('is not reachable')
    expect(result.out + result.err).not.toContain('pw-secret')
  })
})

describePg('files db sync on a real Postgres', () => {
  test('ingests events, walks the root and ends with the audit step', async () => {
    await declareRoot()
    await writeFile(join(folder, 'a.txt'), 'hello')
    await mkdir(join(folder, 'sub'))
    await writeJournal(journalDir, 's1', [call({ agent: 'bot', payload: { path: join(folder, 'a.txt') } })])
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)

    const result = await files(['db', 'sync'], schema)

    expect(result.code).toBe(0)
    const lines = result.out.trimEnd().split('\n')
    // the call and the root.add edit
    expect(lines[0]).toMatch(/^events: \+2 \(synced through record \d+\)$/)
    expect(lines[1]).toBe(`${folder}  1 file, 1 folder  +2 ~0 -0`)
    expect(result.err).toBe(`Next: mcpcut files audit --path ${folder}\n`)
    expect(result.out + result.err).not.toContain('mcpcut-test@')

    const again = await files(['db', 'sync'], schema)
    expect(again.out.split('\n')[0]).toMatch(/^events: \+0 /)
    expect(again.out).toContain('+0 ~0 -0')
  })

  test('a declared folder that is gone is reported with the way out', async () => {
    await declareRoot()
    await rm(folder, { recursive: true })
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)

    const result = await files(['db', 'sync'], schema)

    expect(result.code).toBe(1)
    expect(result.out).toContain(`${folder}  error: the folder is gone or cannot be read`)
    expect(result.err).toContain(`files root remove ${folder}`)
  })

  test('records the index refuses are counted with the way to read them from the journal', async () => {
    await declareRoot()
    await writeJournal(journalDir, 's1', [call({ payload: { path: join(folder, 'a.txt') } }), call({ payload: { path: join(folder, 'bad') } })])
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
    const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema })
    await db.query(
      `CREATE FUNCTION refuse_bad() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.paths[1] LIKE '%/bad' THEN ` +
        `RAISE EXCEPTION 'refused' USING ERRCODE = '22023'; END IF; RETURN NEW; END $$`,
    )
    await db.query('CREATE TRIGGER refuse_bad BEFORE INSERT ON file_events FOR EACH ROW EXECUTE FUNCTION refuse_bad()')
    await db.close()

    const result = await files(['db', 'sync'], schema)

    expect(result.code).toBe(0)
    expect(result.out).toContain('1 record could not be indexed; they are still in the journal: mcpcut files audit\n')
  })
})
