import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createJournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'

let tempDir: string

function makeRecord(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(0).toISOString(),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'notification',
    payload: { hello: 'world' },
    ...overrides,
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-sink-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('createJournalSink', () => {
  test('writes a single record as one JSONL line', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord({ payload: { n: 1 } }))
    await sink.close()

    const content = await readFile(join(tempDir, 'session-1.jsonl'), 'utf8')
    const lines = content.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ payload: { n: 1 } })
  })

  test('creates the journal directory recursively on first write', async () => {
    const nestedDir = join(tempDir, 'nested', 'deeper')
    const sink = createJournalSink('session-1', { dir: nestedDir })

    sink.write(makeRecord())
    await sink.close()

    const content = await readFile(join(nestedDir, 'session-1.jsonl'), 'utf8')
    expect(content.length).toBeGreaterThan(0)
  })

  test('many concurrent writes end up as valid one-per-line JSONL, in call order, without interleaving', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })
    const total = 50

    for (let i = 0; i < total; i += 1) {
      sink.write(makeRecord({ payload: { seq: i } }))
    }
    await sink.close()

    const content = await readFile(join(tempDir, 'session-1.jsonl'), 'utf8')
    const lines = content.trimEnd().split('\n')
    expect(lines).toHaveLength(total)

    const parsed = lines.map((line) => JSON.parse(line) as JournalRecord)
    parsed.forEach((record, index) => {
      expect((record.payload as { seq: number }).seq).toBe(index)
    })
  })

  test('close() resolves only after all pending writes are flushed', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord({ payload: { seq: 0 } }))
    sink.write(makeRecord({ payload: { seq: 1 } }))
    sink.write(makeRecord({ payload: { seq: 2 } }))
    await sink.close()

    const content = await readFile(join(tempDir, 'session-1.jsonl'), 'utf8')
    expect(content.trimEnd().split('\n')).toHaveLength(3)
  })

  test('a write error (unwritable directory) is caught, logged to stderr, and never thrown or rejected', async () => {
    // Force mkdir(recursive) to fail deterministically: a *file* already
    // exists at a path segment the sink needs to create as a directory.
    const blockerFile = join(tempDir, 'blocked')
    await writeFile(blockerFile, 'i am a file, not a directory')
    const brokenDir = join(blockerFile, 'subdir')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const sink = createJournalSink('session-1', { dir: brokenDir })

    expect(() => sink.write(makeRecord())).not.toThrow()
    await expect(sink.close()).resolves.toBeUndefined()
    expect(stderrSpy).toHaveBeenCalled()

    stderrSpy.mockRestore()
  })

  test('subsequent writes after a failed write still behave sanely (no unhandled rejection, close resolves)', async () => {
    const blockerFile = join(tempDir, 'blocked')
    await writeFile(blockerFile, 'i am a file, not a directory')
    const brokenDir = join(blockerFile, 'subdir')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const sink = createJournalSink('session-1', { dir: brokenDir })

    sink.write(makeRecord({ payload: { seq: 0 } }))
    sink.write(makeRecord({ payload: { seq: 1 } }))

    await expect(sink.close()).resolves.toBeUndefined()

    vi.restoreAllMocks()
  })

  test('defaults dir to JOURNAL_DIR when opts.dir is omitted (does not throw at construction time)', () => {
    expect(() => createJournalSink('session-default')).not.toThrow()
  })

  test('reuses an already-existing directory without error', async () => {
    await mkdir(tempDir, { recursive: true })
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord())
    await sink.close()

    const content = await readFile(join(tempDir, 'session-1.jsonl'), 'utf8')
    expect(content.length).toBeGreaterThan(0)
  })
})
