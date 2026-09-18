import { chmod, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runBackupCommand } from '../../src/cli/backup-cmd.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { openJournalDbShared } from '../../src/journal/db.js'
import { openStateDbShared } from '../../src/policy/store-backend.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Behavior of `mcpcut backup <destDir>`: an online SQLite backup of both
 * `state.db` and `journal.db` into a destination directory. Routing
 * (`dispatch` wiring `backup` to this module) is covered separately in
 * `tests/cli/dispatch.test.ts`.
 */

let journalDir: string
let destDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-backup-cmd-src-'))
  destDir = join(await mkdtemp(join(tmpdir(), 'mcpcut-backup-cmd-dest-')), 'snapshot')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(destDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function run(args: string[], io = fakeIo()): Promise<number> {
  return runBackupCommand(args, io, { journalDir })
}

function recordOf(sessionId: string, id: string): JournalRecord {
  return {
    id,
    ts: new Date().toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'request',
    method: 'tools/list',
    payload: {},
  }
}

async function writeJournalRecord(): Promise<void> {
  const sink = createJournalSink('session-a', { dir: journalDir })
  sink.write(recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0'))
  await sink.close()
}

async function writeStateRow(): Promise<void> {
  await createAgentsStore({ journalDir }).createAgent('research-bot')
}

describe('backup: a populated journal directory', () => {
  test('both files exist at 0600, open cleanly, and hold the same rows as the source', async () => {
    await writeJournalRecord()
    await writeStateRow()
    const io = fakeIo()

    const exitCode = await run([destDir], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(`backup: state.db -> ${join(destDir, 'state.db')}`)
    expect(io.out()).toContain(`backup: journal.db -> ${join(destDir, 'journal.db')}`)

    const stateStat = await stat(join(destDir, 'state.db'))
    const journalStat = await stat(join(destDir, 'journal.db'))
    expect(stateStat.mode & 0o777).toBe(0o600)
    expect(journalStat.mode & 0o777).toBe(0o600)

    const journalHandle = await openJournalDbShared(join(destDir, 'journal.db'))
    const journalRows = journalHandle.db.prepare('SELECT COUNT(*) AS n FROM journal_records').get() as Record<
      string,
      unknown
    >
    expect(Number(journalRows['n'])).toBe(1)

    const stateHandle = await openStateDbShared(join(destDir, 'state.db'))
    const stateRows = stateHandle.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as Record<
      string,
      unknown
    >
    expect(Number(stateRows['n'])).toBe(1)
  })
})

describe('backup: running twice into the same destination', () => {
  test('the second run refuses to overwrite, exit 1, mentioning the existing file', async () => {
    await writeJournalRecord()
    await writeStateRow()
    await run([destDir])

    const io = fakeIo()
    const exitCode = await run([destDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('state.db')
  })
})

describe('backup: only journal.db exists', () => {
  test('one report line, exit 0', async () => {
    await writeJournalRecord()
    const io = fakeIo()

    const exitCode = await run([destDir], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('journal.db')
    expect(io.out()).not.toContain('state.db')
    const entries = await readdir(destDir)
    expect(entries.sort()).toEqual(['journal.db'])
  })
})

describe('backup: no databases at all', () => {
  test('exit 1 with a message, nothing written', async () => {
    const io = fakeIo()

    const exitCode = await run([destDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No databases to back up.')
    expect(io.out()).toBe('')
  })
})

describe('backup: destDir is a symlink', () => {
  test("refuses, exit 1, and leaves the link target's mode and contents untouched", async () => {
    // A symlink pre-staged where the operator will point the backup: the
    // command's chmod would otherwise tighten SOMEBODY ELSE'S directory to 0700.
    const targetDir = await mkdtemp(join(tmpdir(), 'mcpcut-backup-cmd-target-'))
    await chmod(targetDir, 0o755)
    await symlink(targetDir, destDir)
    await writeJournalRecord()
    const io = fakeIo()

    try {
      const exitCode = await run([destDir], io)

      expect(exitCode).toBe(1)
      expect(io.err()).toContain('symlink')
      expect((await stat(targetDir)).mode & 0o777).toBe(0o755)
      expect(await readdir(targetDir)).toEqual([])
      expect(io.out()).toBe('')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})

describe('backup: argument count is validated', () => {
  test('zero positionals: exit 1 with usage', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(1)
    expect(io.err().toLowerCase()).toContain('usage')
  })

  test('two positionals: exit 1 with usage', async () => {
    const io = fakeIo()

    const exitCode = await run([destDir, 'extra'], io)

    expect(exitCode).toBe(1)
    expect(io.err().toLowerCase()).toContain('usage')
  })
})
