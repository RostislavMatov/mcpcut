import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch } from '../../src/cli.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import { createVaultStore } from '../../src/vault/store.js'
import { call, writeJournal } from '../files/db/journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** `mcpcut files audit` with Postgres turned on, on temp dirs only. */

let journalDir: string
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-files-audit-pg-'))
  await writeJournal(journalDir, 's1', [call({ agent: 'bot', payload: { path: '/data/a' } })])
  await createVaultStore({ journalDir }).init()
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(journalDir, { recursive: true, force: true })
})

async function audit(args: string[], schema?: string) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', 'audit', ...args], io, {
    files: { journalDir, env: {}, db: { loadPg: () => loadPg(process.cwd()), ...(schema !== undefined ? { schema } : {}) } },
  })
  return { code, out: out.join(''), err: err.join('') }
}

describe('files audit with an unreachable Postgres', () => {
  test('answers from the journal, says why on stderr, and keeps the password out', async () => {
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, 'postgres://u:pw-secret@127.0.0.1:1/db')

    const result = await audit([])

    expect(result.code).toBe(0)
    expect(result.out).toContain('read_file')
    expect(result.err).toContain('is not reachable')
    expect(result.err).toContain('answered from the journal.')
    expect(result.err).not.toContain('pw-secret')
    expect(result.err).not.toContain('from Postgres')
  })
})

describePg('files audit with Postgres on a real server', () => {
  test('answers from Postgres, says so in the footer and in --json', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)

    const text = await audit([], schema)
    const json = await audit(['--json'], schema)

    expect(text.out).toContain('read_file')
    expect(text.err).toContain('1 file operation(s) from Postgres')
    expect(text.err).not.toContain('answered from the journal')
    expect(JSON.parse(json.out)).toMatchObject({ source: 'postgres' })
  })
})
