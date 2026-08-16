import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Behavior of `mcp-journal export`: streams `journal.db`'s records as JSONL
 * to stdout, in `seq` (global write) order. Routing (`dispatch` wiring
 * `export` to this module) is covered separately in `tests/cli/dispatch.test.ts`.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-export-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
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
  return runExportCommand(args, io, { journalDir })
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

describe('export: whole journal', () => {
  test('round-trip: every stdout line parses back to the exact records, in seq order', async () => {
    const sessionA = [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ]
    const sessionB = [recordOf('session-b', '01BBBBBBBBBBBBBBBBBBBBBBB0', 'ping')]
    await writeRecordsViaSink('session-a', sessionA)
    await writeRecordsViaSink('session-b', sessionB)
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    const lines = io.out().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(3)
    const parsed = lines.map((line) => JSON.parse(line) as JournalRecord)
    expect(parsed.map((record) => record.id)).toEqual([
      sessionA[0]!.id,
      sessionA[1]!.id,
      sessionB[0]!.id,
    ])
    expect(parsed[0]).toEqual(sessionA[0])
  })
})

describe('export: --session filter', () => {
  test('streams only the matching session, in seq order', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    await writeRecordsViaSink('session-b', [recordOf('session-b', '01BBBBBBBBBBBBBBBBBBBBBBB0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--session', 'session-b'], io)

    expect(exitCode).toBe(0)
    const lines = io.out().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as JournalRecord).sessionId).toBe('session-b')
  })

  test('an unknown session id yields empty stdout, exit 0', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    const io = fakeIo()

    const exitCode = await run(['--session', 'session-does-not-exist'], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('')
  })
})

describe('export: empty install', () => {
  test('no journal.db at all: exit 0, empty stdout', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('')
  })
})

describe('export: arguments are rejected', () => {
  test('an extra positional argument aborts with exit 1 and usage', async () => {
    const io = fakeIo()

    const exitCode = await run(['unexpected'], io)

    expect(exitCode).toBe(1)
    expect(io.out()).toBe('')
    expect(io.err().toLowerCase()).toContain('usage')
  })
})

describe('export: backpressure', () => {
  /**
   * A stdout that fills after every `fullAfter` writes and only drains when
   * asked, recording how many chunks it ever accepted between drains — the
   * bound an export piped into a slow consumer must respect.
   */
  function backpressureIo(fullAfter: number): {
    stdout: { write: (chunk: string) => boolean; once: (event: 'drain', listener: () => void) => void }
    stderr: { write: (chunk: string) => void }
    lines: () => readonly string[]
    maxWritesWithoutDrain: () => number
    drainCount: () => number
  } {
    const chunks: string[] = []
    let sinceDrain = 0
    let maxSinceDrain = 0
    let drainCount = 0
    return {
      stdout: {
        write: (chunk: string) => {
          chunks.push(chunk)
          sinceDrain += 1
          maxSinceDrain = Math.max(maxSinceDrain, sinceDrain)
          return sinceDrain < fullAfter
        },
        once: (_event: 'drain', listener: () => void) => {
          drainCount += 1
          setImmediate(() => {
            sinceDrain = 0
            listener()
          })
        },
      },
      stderr: { write: () => undefined },
      lines: () => chunks.join('').split('\n').filter((line) => line.length > 0),
      maxWritesWithoutDrain: () => maxSinceDrain,
      drainCount: () => drainCount,
    }
  }

  test('waits for drain before writing past a full stdout, and still exports every record', async () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      recordOf('session-a', `01AAAAAAAAAAAAAAAAAAAAAA${index}`, 'tools/list'),
    )
    await writeRecordsViaSink('session-a', records)
    const io = backpressureIo(3)

    const exitCode = await runExportCommand([], io, { journalDir })

    expect(exitCode).toBe(0)
    expect(io.lines()).toHaveLength(8)
    expect(io.maxWritesWithoutDrain()).toBeLessThanOrEqual(3)
    expect(io.drainCount()).toBeGreaterThan(0)
  })
})

describe('export: legacy hint', () => {
  test('an un-imported legacy *.jsonl file prints a hint on stderr after the data', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    await writeFile(
      join(journalDir, 'session-legacy.jsonl'),
      `${JSON.stringify(recordOf('session-legacy', '01CCCCCCCCCCCCCCCCCCCCCCC0', 'ping'))}\n`,
      'utf8',
    )
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('session-a')
    expect(io.err()).toContain('mcp-journal migrate')
  })

  test('no legacy files: no hint on stderr', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.err()).toBe('')
  })
})
