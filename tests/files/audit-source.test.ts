import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { queryFileAudit } from '../../src/files/audit.js'
import { fileAudit } from '../../src/files/audit-source.js'
import { openFilesDb } from '../../src/files/db/connection.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import { FilesDbModuleMissingError, loadPg } from '../../src/files/db/pg-loader.js'
import { createVaultStore } from '../../src/vault/store.js'
import { call, writeJournal } from './db/journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from './db/pg-helpers.js'

/** The source switch: Postgres when on and caught up, the journal otherwise, with a one-line reason. */

let dir: string
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-audit-source-'))
  await writeJournal(dir, 's1', [call({ agent: 'bot', payload: { path: '/data/a' } }), call({ agent: 'bot', payload: { path: '/data/b' } })])
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(dir, { recursive: true, force: true })
})

async function turnOn(url: string): Promise<void> {
  await createVaultStore({ journalDir: dir }).init()
  await createVaultStore({ journalDir: dir }).setSecret(FILES_PG_URL_SECRET, url)
}

const base = { cli: 'mcpcut', budgetMs: 60_000, platform: 'linux' as const }

describe('fileAudit', () => {
  test('without a vault Postgres is off: the journal answers and nothing is said', async () => {
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir })
    expect(answer.source).toBe('journal')
    expect(answer.notice).toBeUndefined()
    expect(answer.entries).toHaveLength(2)
  })

  test('with a vault that has no URL it is off too', async () => {
    await createVaultStore({ journalDir: dir }).init()
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir })
    expect(answer).toMatchObject({ source: 'journal' })
    expect(answer.notice).toBeUndefined()
  })

  test('a client that is not installed falls back with the setup step', async () => {
    await turnOn('postgres://u:pw-secret@127.0.0.1:1/db')
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir, loadPg: () => Promise.reject(new FilesDbModuleMissingError()) })
    expect(answer.source).toBe('journal')
    expect(answer.notice).toBe('Postgres support is not installed: run `mcpcut files setup` — answered from the journal.')
    expect(answer.entries).toHaveLength(2)
  })

  test('an unreachable server falls back, names the step and never the password', async () => {
    await turnOn('postgres://u:pw-secret@127.0.0.1:1/db')
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir, loadPg: () => loadPg(process.cwd()) })
    expect(answer.source).toBe('journal')
    expect(answer.notice).toContain('is not reachable')
    expect(answer.notice).toContain('mcpcut files db status')
    expect(answer.notice).not.toContain('pw-secret')
    expect(answer.entries).toHaveLength(2)
  })

  test('a URL that is not postgres:// falls back with the fix', async () => {
    await turnOn('http://example.com/x')
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir, loadPg: () => loadPg(process.cwd()) })
    expect(answer.notice).toContain('vault set files-pg-url')
  })
})

describePg('fileAudit on a real Postgres', () => {
  async function turnOnTestDb(): Promise<string> {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn(PG_URL)
    return schema
  }

  test('caught up: Postgres answers, the same entries as the journal', async () => {
    const schema = await turnOnTestDb()
    const options = { ...base, journalDir: dir, schema, loadPg: () => loadPg(process.cwd()) }
    const answer = await fileAudit({ limit: 10, agent: 'bot' }, options)
    expect(answer.source).toBe('postgres')
    expect(answer.notice).toBeUndefined()
    const journal = await queryFileAudit({ limit: 10, agent: 'bot' }, { dir, platform: 'linux' })
    expect(answer.entries).toEqual(journal.entries)
  })

  test('a record the index could not take: the journal answers, so nothing is missing from the answer', async () => {
    const schema = await turnOnTestDb()
    const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema })
    await db.query(
      "CREATE FUNCTION refuse_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.paths = ARRAY['/data/b'] THEN " +
        "RAISE EXCEPTION 'refused' USING ERRCODE = '22023'; END IF; RETURN NEW; END $$",
    )
    await db.query('CREATE TRIGGER refuse_b BEFORE INSERT ON file_events FOR EACH ROW EXECUTE FUNCTION refuse_b()')
    await db.close()
    const answer = await fileAudit({ limit: 10, agent: 'bot' }, { ...base, journalDir: dir, schema, loadPg: () => loadPg(process.cwd()) })
    expect(answer.source).toBe('journal')
    expect(answer.notice).toContain('1 journal record(s) could not be put in the Postgres index')
    expect(answer.entries.map((entry) => entry.paths[0])).toEqual(['/data/b', '/data/a'])
  })

  test('not caught up within the budget: the journal answers and the notice says how to finish', async () => {
    const schema = await turnOnTestDb()
    await writeJournal(dir, 's2', Array.from({ length: 5 }, (_, i) => call({ payload: { path: `/data/m${i}` } })))
    const answer = await fileAudit(
      { limit: 100 },
      { ...base, journalDir: dir, schema, budgetMs: 0, batchSize: 2, loadPg: () => loadPg(process.cwd()) },
    )
    expect(answer.source).toBe('journal')
    expect(answer.notice).toContain('mcpcut files db sync')
  })

  test('a bad schema name in the environment is a notice, not a crash', async () => {
    await turnOnTestDb()
    const answer = await fileAudit({ limit: 10 }, { ...base, journalDir: dir, env: { MCPCUT_FILES_DB_SCHEMA: 'Bad-Name' }, loadPg: () => loadPg(process.cwd()) })
    expect(answer.source).toBe('journal')
    expect(answer.notice).toContain('MCPCUT_FILES_DB_SCHEMA')
  })
})
