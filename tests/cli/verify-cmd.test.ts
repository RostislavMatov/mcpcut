import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runVerifyCommand } from '../../src/cli/verify-cmd.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * `mcp-journal verify [--session <id>]` end to end: records land through the
 * real sink/batch-writer into a real tmpdir `journal.db`, then are tampered
 * with directly via SQL (never through the sink -- that is the whole point:
 * simulating an edit that bypassed the journaling path entirely), then
 * `verify` is run and its exit code / stdout / stderr are asserted. Routing
 * (`dispatch` wiring `verify` to this module) is covered separately in
 * `tests/cli/dispatch.test.ts`.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-verify-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

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
  return runVerifyCommand(args, io, { journalDir })
}

function recordOf(sessionId: string, id: string, method: string): JournalRecord {
  return {
    id,
    ts: new Date().toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'request',
    method,
    payload: {},
  }
}

async function writeRecordsViaSink(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: journalDir })
  for (const record of records) {
    sink.write(record)
  }
  await sink.close()
}

/** Direct SQL access to the same database, bypassing the sink -- simulates tampering that never went through the journal writer. */
async function rawHandle() {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

describe('verify: no database at all', () => {
  test('reports a clear error, exit 1, and never creates the file', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/No journal database found/)
    await expect(stat(journalDbPathFor(journalDir))).rejects.toThrow()
  })
})

describe('verify: empty journal', () => {
  test('exit 0, "nothing to verify"', async () => {
    // Opening (without writing) creates the schema but no rows -- the
    // "database exists, holds nothing" case, distinct from "no file at all".
    await openJournalDbShared(journalDbPathFor(journalDir))
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/Journal is empty; nothing to verify/)
  })
})

describe('verify: clean chain', () => {
  test('exit 0, reports the chain intact through the last seq', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    await writeRecordsViaSink('session-b', [recordOf('session-b', '01BBBBBBBBBBBBBBBBBBBBBBB0', 'ping')])
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/Chain intact through seq 3 \(3 record\(s\) checked\)/)
    expect(io.err()).toBe('')
  })
})

describe('verify: --session', () => {
  test('an existing session reports its span and full coverage, exit 0', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    await writeRecordsViaSink('session-b', [recordOf('session-b', '01BBBBBBBBBBBBBBBBBBBBBBB0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--session', 'session-a'], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/Session "session-a": 2 record\(s\), seq 1\.\.2/)
    expect(io.out()).toMatch(/fully covered/)
  })

  test('a session that does not exist: exit 1, clear message', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
    ])
    const io = fakeIo()

    const exitCode = await run(['--session', 'no-such-session'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/No records found for session "no-such-session"/)
  })

  test('a malformed --session value is rejected before touching the database, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['--session', '../escape'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/Invalid --session/)
  })
})

describe('verify: usage errors', () => {
  test('a stray positional argument is rejected, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['session-a'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/takes no positional arguments/)
  })
})

describe('verify: tamper detection', () => {
  test('an UPDATEd row is detected as modified, exit 2, names the seq', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA2', 'ping'),
    ])
    const handle = await rawHandle()
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 2:.*modified|changed after being written/i)
  })

  test('a DELETEd middle row is detected as a gap, exit 2, names the surviving seq', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA2', 'ping'),
    ])
    const handle = await rawHandle()
    handle.db.prepare('DELETE FROM journal_records WHERE seq = 2').run()
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 3:.*deleted, inserted, or reordered/)
  })

  // Regression: a "gap" report must not claim more precision than the stored
  // columns can support -- see chain-verify.ts's module doc and the
  // dedicated forged-self-consistent-edit test in chain-verify.test.ts. A
  // careful edit of seq 2 that also recomputes seq 2's own record_hash from
  // its own stored prev_hash produces THE SAME "gap at seq 3" report as a
  // genuine deletion/insertion/reorder -- the two are indistinguishable from
  // what verifyChain has to look at, so the message must say both are
  // possible and must point the operator at seq 2 as well as seq 3, not name
  // only the deletion/insertion/reorder story.
  test('a gap break message states both possible causes and points at the preceding record too', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA2', 'ping'),
    ])
    const handle = await rawHandle()
    handle.db.prepare('DELETE FROM journal_records WHERE seq = 2').run()
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(2)
    const out = io.out()
    expect(out).toMatch(/BROKEN at seq 3:/)
    expect(out).toMatch(/deleted, inserted, or reordered/)
    expect(out).toMatch(/edited/i)
    expect(out).toMatch(/seq 2/)
  })

  test('two rows with swapped doc values are detected, exit 2', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA2', 'ping'),
    ])
    const handle = await rawHandle()
    const rows = handle.db.prepare('SELECT seq, doc FROM journal_records ORDER BY seq').all() as {
      seq: number
      doc: string
    }[]
    const [first, second] = rows
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = ?').run(second!.doc, first!.seq)
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = ?').run(first!.doc, second!.seq)
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 1:/)
  })

  test('--session reports a warning when the global break falls within its range', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    const handle = await rawHandle()
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    const io = fakeIo()

    const exitCode = await run(['--session', 'session-a'], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/WARNING: the chain break at seq 2 falls within/)
  })

  test('an untouched journal after tamper-test setup elsewhere still verifies clean, exit 0', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
    ])
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).not.toMatch(/BROKEN/)
  })

  // Regression: a real chain break must always escalate to exit 2, even when
  // the command ALSO could not do some other, separately-requested thing
  // (sign with a key that does not exist yet, or resolve an unknown
  // --session). Before this fix, either of those "the extra thing failed"
  // paths returned exit 1 and masked a break the walk had already found and
  // already printed to stdout -- exactly the case an auditor's script (which
  // treats 1 as "low priority" and 2 as "alert") must never see.
  test('a broken chain with an unknown --session still exits 2, not 1 -- the break is not masked by the session lookup failing', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    const handle = await rawHandle()
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    const io = fakeIo()

    const exitCode = await run(['--session', 'no-such-session'], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 2/)
    expect(io.err()).toMatch(/No records found for session "no-such-session"/)
  })
})
