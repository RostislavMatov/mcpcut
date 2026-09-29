import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { recordFirstSessionHint, showSessionHint } from '../../src/cli/next-step.js'
import {
  runSessionsCommand,
  runShowCommand,
  type JournalCliIo,
} from '../../src/cli/journal-cmds.js'
import { migrateJournalFiles } from '../../src/journal/import.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * `sessions` / `show` (M4.5 wave 5, task 6): behavior is unchanged by the
 * cutover except for one addition, the un-imported-legacy-file hint —
 * `tests/cli/dispatch.test.ts` covers routing and the pre-existing
 * `--kind` filter regression, so this suite only covers what task 6 added.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-journal-cmds-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): JournalCliIo & { readonly out: () => string; readonly err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function record(sessionId: string, overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-16T10:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
    ...overrides,
  }
}

/** Writes a session into `journal.db` through the real sink. */
async function writeDbSession(sessionId: string): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: journalDir })
  sink.write(record(sessionId))
  await sink.close()
}

/** Writes a session the old way: a `*.jsonl` file nobody has imported yet. */
async function writeLegacySession(sessionId: string): Promise<void> {
  await writeFile(
    join(journalDir, `${sessionId}.jsonl`),
    `${JSON.stringify(record(sessionId))}\n`,
    'utf8',
  )
}

const LEGACY_HINT = 'legacy *.jsonl session file(s) are not imported'

describe('runSessionsCommand: the legacy hint', () => {
  test('is silent when every session is in the database', async () => {
    await writeDbSession('db-only')
    const io = fakeIo()

    const exitCode = await runSessionsCommand(io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('db-only')
    // Only the next step, never the migrate nudge.
    expect(io.err()).toBe(showSessionHint('db-only'))
  })

  test('fires once, with the file count, when un-imported legacy files exist', async () => {
    await writeDbSession('db-session')
    await writeLegacySession('legacy-1')
    await writeLegacySession('legacy-2')
    const io = fakeIo()

    const exitCode = await runSessionsCommand(io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('db-session')
    expect(io.err()).toContain('2 legacy *.jsonl session file(s) are not imported')
    expect(io.err()).toContain('mcpcut migrate')
  })

  test('goes silent again after migrate imports the files', async () => {
    await writeLegacySession('legacy-1')
    await migrateJournalFiles(journalDir)
    const io = fakeIo()

    const exitCode = await runSessionsCommand(io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).toBe(showSessionHint('legacy-1'))
  })

  test('degrades to no hint instead of failing when the probe cannot read the directory', async () => {
    // A path that is not a directory: the probe's stat/readdir calls fail in a
    // way that is not "missing", and the hint must not turn that into a
    // command failure — the sessions output itself already handles this path.
    const notADir = join(journalDir, 'not-a-dir')
    await writeFile(notADir, 'plain file', 'utf8')
    const io = fakeIo()

    const exitCode = await runSessionsCommand(io, notADir)

    expect(exitCode).toBe(0)
    expect(io.err()).toBe(recordFirstSessionHint())
  })
})

describe('runShowCommand: the legacy hint', () => {
  test('is silent for a session that is in the database', async () => {
    await writeDbSession('shown')
    const io = fakeIo()

    const exitCode = await runShowCommand(['shown'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain(LEGACY_HINT)
  })

  test('fires when the requested session itself is un-imported', async () => {
    await writeLegacySession('un-imported')
    const io = fakeIo()

    const exitCode = await runShowCommand(['un-imported'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('un-imported')
    expect(io.err()).toContain('mcpcut migrate')
  })

  test('stays silent for a different session even when other legacy files exist (targeted, not noisy)', async () => {
    await writeDbSession('shown')
    await writeLegacySession('someone-elses-legacy-file')
    const io = fakeIo()

    const exitCode = await runShowCommand(['shown'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain(LEGACY_HINT)
  })
})

/**
 * `show` had the defect `prune` had (user-journey smoke 2026-09-18, UX-6): an
 * invalid `--direction`/`--kind` value, or a missing session id, was answered
 * with the whole top-level help table, so the list of allowed values scrolled
 * off the screen above it. The command now prints its own synopsis.
 */
describe('runShowCommand: an argument error prints this command, not the whole CLI', () => {
  // A row of the full table that no next-step hint names.
  const OTHER_COMMAND_ROW = 'mcpcut serve'

  test('an invalid --kind names the allowed values and stays short', async () => {
    const io = fakeIo()

    const exitCode = await runShowCommand(['s1', '--kind', 'bogus'], io, journalDir)

    expect(exitCode).toBe(1)
    const err = io.err()
    expect(err).toContain('Invalid --kind "bogus"')
    expect(err).toContain('mcpcut show <sessionId>')
    expect(err).toContain('mcpcut --help')
    expect(err).not.toContain(OTHER_COMMAND_ROW)
  })

  test('an invalid --direction and a missing session id stay equally short', async () => {
    const cases: string[][] = [['s1', '--direction', 'sideways'], []]
    for (const args of cases) {
      const io = fakeIo()

      const exitCode = await runShowCommand(args, io, journalDir)

      expect(exitCode, args.join(' ')).toBe(1)
      expect(io.err(), args.join(' ')).not.toContain(OTHER_COMMAND_ROW)
      expect(io.err(), args.join(' ')).toContain('mcpcut show <sessionId>')
    }
  })
})

/**
 * The next step (owner's rule 2026-09-29): an empty journal says how to fill
 * it, a list offers the latest session by id, and an unknown id is an error
 * that points back at the list instead of an empty screen and exit 0.
 */
describe('sessions and show end with the next command', () => {
  test('an empty journal says how to record the first session', async () => {
    const io = fakeIo()

    const exitCode = await runSessionsCommand(io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('No sessions found.\n')
    expect(io.err()).toContain('wrap -- <server command>')
  })

  test('a list offers the newest session, ready to paste', async () => {
    await writeDbSession('the-session')
    const io = fakeIo()

    await runSessionsCommand(io, journalDir)

    expect(io.err()).toContain('show the-session')
  })

  test('an unknown session id is an error naming the list command', async () => {
    await writeDbSession('real-session')
    const io = fakeIo()

    const exitCode = await runShowCommand(['nope'], io, journalDir)

    expect(exitCode).toBe(1)
    expect(io.out()).toBe('')
    expect(io.err()).toContain('No session "nope" in the journal')
    expect(io.err()).toContain('sessions')
  })

  test('a filter that matches nothing in a real session is not an error', async () => {
    await writeDbSession('real-session')
    const io = fakeIo()

    const exitCode = await runShowCommand(['real-session', '--kind', 'decision'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain('No session')
  })

  test('a missing id offers the newest session when there is one', async () => {
    await writeDbSession('the-session')
    const io = fakeIo()

    const exitCode = await runShowCommand([], io, journalDir)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('show the-session')
  })
})

describe('show and sessions: the edges of the next step', () => {
  test('an unknown id with --json keeps stdout empty JSONL, and exits 1', async () => {
    const io = fakeIo()

    const exitCode = await runShowCommand(['nope', '--json'], io, journalDir)

    expect(exitCode).toBe(1)
    expect(io.out()).toBe('')
    expect(io.err()).toContain('No session "nope"')
  })

  test('an id that could never be a session gets the same answer, terminal-safe', async () => {
    const io = fakeIo()

    const exitCode = await runShowCommand(['bad\u001b[2Jid'], io, journalDir)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No session')
    expect(io.err()).not.toContain('\u001b')
  })

  test('a --method filter that matches nothing in a real session is not an error', async () => {
    await writeDbSession('real-session')
    const io = fakeIo()

    const exitCode = await runShowCommand(['real-session', '--method', 'ping'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).toBe('')
  })

  test('a journal of un-imported files alone points only at migrate', async () => {
    await writeLegacySession('legacy-only')
    const io = fakeIo()

    await runSessionsCommand(io, journalDir)

    expect(io.err()).toContain('mcpcut migrate')
    expect(io.err()).not.toContain('To record one')
  })

  test('a missing id still answers with usage when the journal cannot be listed', async () => {
    const notADir = join(journalDir, 'not-a-dir')
    await writeFile(notADir, 'plain file', 'utf8')
    const io = fakeIo()

    const exitCode = await runShowCommand([], io, notADir)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Missing <sessionId>')
  })
})
