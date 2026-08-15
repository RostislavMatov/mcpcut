import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createJournalSink } from '../../src/journal/sink.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../../src/config.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Hardening regressions for the journal sink: restrictive permissions on
 * the journal directory and its database, safe behavior after close, and
 * session id validation. The journal holds redacted-but-sensitive traffic,
 * so it must never be group- or world-readable.
 */

const PERMISSION_MASK = 0o777
const isWindows = process.platform === 'win32'

let tempDir: string

function makeRecord(): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(0).toISOString(),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'notification',
    payload: { hello: 'world' },
  }
}

/** The records a session left in `journal.db`, in commit order. */
async function readRecords(dir: string): Promise<JournalRecord[]> {
  const handle = await openJournalDbShared(journalDbPathFor(dir))
  const rows = handle.db
    .prepare('SELECT doc FROM journal_records ORDER BY seq')
    .all() as { doc: string }[]
  return rows.map((row) => JSON.parse(row.doc) as JournalRecord)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-sink-hardening-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tempDir, { recursive: true, force: true })
})

describe('journal file permissions', () => {
  test.skipIf(isWindows)(
    'creates the journal database with owner-only permissions (0600)',
    async () => {
      const dir = join(tempDir, 'journal')
      const sink = createJournalSink('session-1', { dir })

      sink.write(makeRecord())
      await sink.close()

      const fileStat = await stat(journalDbPathFor(dir))
      expect(fileStat.mode & PERMISSION_MASK).toBe(JOURNAL_FILE_MODE)
    },
  )

  test.skipIf(isWindows)(
    'creates the journal directory with owner-only permissions (0700)',
    async () => {
      const dir = join(tempDir, 'journal')
      const sink = createJournalSink('session-1', { dir })

      sink.write(makeRecord())
      await sink.close()

      const dirStat = await stat(dir)
      expect(dirStat.mode & PERMISSION_MASK).toBe(JOURNAL_DIR_MODE)
    },
  )

  test.skipIf(isWindows)(
    'tightens a pre-existing journal directory to owner-only (0700)',
    async () => {
      const dir = join(tempDir, 'journal')
      await mkdir(dir, { recursive: true, mode: 0o755 })
      const sink = createJournalSink('session-1', { dir })

      sink.write(makeRecord())
      await sink.close()

      const dirStat = await stat(dir)
      expect(dirStat.mode & PERMISSION_MASK).toBe(JOURNAL_DIR_MODE)
    },
  )
})

describe('write after close', () => {
  test('a write after close is a no-op that does not reach the journal', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord())
    await sink.close()
    sink.write(makeRecord())
    await sink.close()

    expect(await readRecords(tempDir)).toHaveLength(1)
  })

  test('warns exactly once no matter how many writes arrive after close', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createJournalSink('session-1', { dir: tempDir })

    await sink.close()
    sink.write(makeRecord())
    sink.write(makeRecord())
    sink.write(makeRecord())

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('closed')
  })

  test('close is idempotent', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord())

    await expect(sink.close()).resolves.toBeUndefined()
    await expect(sink.close()).resolves.toBeUndefined()
  })
})

describe('session id validation', () => {
  test.each(['../escape', 'a/b', '..', 'sess ion', '', 'sess/../../etc/passwd', 'a\\b'])(
    'rejects the traversal-unsafe session id %j',
    (sessionId) => {
      expect(() => createJournalSink(sessionId, { dir: tempDir })).toThrow(/session id/i)
    },
  )

  test.each(['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-1', 'test_session_2'])(
    'accepts the safe session id %s',
    (sessionId) => {
      expect(() => createJournalSink(sessionId, { dir: tempDir })).not.toThrow()
    },
  )

  test('rejects an over-long session id without echoing it back in full', () => {
    const overLong = 'a'.repeat(5_000)

    let thrown: unknown
    try {
      createJournalSink(overLong, { dir: tempDir })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/session id/i)
    expect((thrown as Error).message.length).toBeLessThan(200)
  })

  test('escapes control characters when reporting a rejected session id', () => {
    expect(() => createJournalSink('bad\nid', { dir: tempDir })).toThrow(/bad\\nid/)
  })
})
