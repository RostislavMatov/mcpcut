import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  assertDatabasesHealthy,
  preflightDatabases,
  DatabaseIntegrityError,
} from '../../src/store/preflight.js'
import { openStateDbShared } from '../../src/policy/store-backend.js'
import { openJournalDbShared } from '../../src/journal/db.js'
import { writeCorruptDatabase, writeUnopenableDatabase } from '../support/corrupt-db.js'

/**
 * The startup gate of the four long-lived entry points: both databases of a
 * journal directory are checked with `PRAGMA integrity_check` before anything
 * binds a port or spawns a server, and a directory that has no database yet
 * must come out of the check exactly as it went in — a preflight that CREATED
 * `state.db` would turn "nothing installed" into "empty install".
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-preflight-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stderr writes for assertions instead of touching the real stream. */
function fakeStderr(): { write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
  }
}

describe('assertDatabasesHealthy()', () => {
  test('resolves when both databases are healthy', async () => {
    await openStateDbShared(join(journalDir, 'state.db'))
    await openJournalDbShared(join(journalDir, 'journal.db'))

    await expect(assertDatabasesHealthy(journalDir)).resolves.toBeUndefined()
  })

  test('resolves and creates nothing when the directory holds no database', async () => {
    const before = await readdir(journalDir)

    await expect(assertDatabasesHealthy(journalDir)).resolves.toBeUndefined()

    expect(await readdir(journalDir)).toEqual(before)
    expect(await readdir(journalDir)).toEqual([])
  })

  test('rejects with DatabaseIntegrityError naming state.db when its pages are damaged', async () => {
    await writeCorruptDatabase(join(journalDir, 'state.db'))

    const error = await assertDatabasesHealthy(journalDir).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(DatabaseIntegrityError)
    expect((error as Error).message).toContain('state.db')
    expect((error as Error).message).toContain('PRAGMA integrity_check')
  })

  test('rejects with DatabaseIntegrityError when state.db cannot be opened at all', async () => {
    await writeUnopenableDatabase(join(journalDir, 'state.db'))

    const error = await assertDatabasesHealthy(journalDir).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(DatabaseIntegrityError)
    expect((error as Error).message).toContain('state.db cannot be opened')
  })

  test('rejects naming journal.db when only the journal database is unopenable', async () => {
    await openStateDbShared(join(journalDir, 'state.db'))
    await writeUnopenableDatabase(join(journalDir, 'journal.db'))

    const error = await assertDatabasesHealthy(journalDir).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(DatabaseIntegrityError)
    expect((error as Error).message).toContain('journal.db cannot be opened')
  })

  test('rejects naming journal.db when only the journal database is damaged', async () => {
    await openStateDbShared(join(journalDir, 'state.db'))
    await writeCorruptDatabase(join(journalDir, 'journal.db'))

    const error = await assertDatabasesHealthy(journalDir).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(DatabaseIntegrityError)
    expect((error as Error).message).toContain('journal.db')
  })
})

describe('preflightDatabases()', () => {
  test('returns true and stays silent for a healthy directory', async () => {
    await openStateDbShared(join(journalDir, 'state.db'))
    const stderr = fakeStderr()

    expect(await preflightDatabases(journalDir, stderr)).toBe(true)
    expect(stderr.text()).toBe('')
  })

  test('returns false and explains the refusal for a damaged database', async () => {
    await writeCorruptDatabase(join(journalDir, 'state.db'))
    const stderr = fakeStderr()

    expect(await preflightDatabases(journalDir, stderr)).toBe(false)
    expect(stderr.text()).toContain('state.db failed PRAGMA integrity_check')
    expect(stderr.text()).toContain('Refusing to start.')
    expect(stderr.text()).toContain('Backup & restore')
  })

  test('returns false with the same restore guidance for an unopenable database', async () => {
    await writeUnopenableDatabase(join(journalDir, 'state.db'))
    const stderr = fakeStderr()

    expect(await preflightDatabases(journalDir, stderr)).toBe(false)
    expect(stderr.text()).toContain('state.db cannot be opened')
    expect(stderr.text()).toContain('Refusing to start.')
    expect(stderr.text()).toContain('Backup & restore')
  })
})
