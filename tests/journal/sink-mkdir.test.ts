import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createJournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Isolated in its own file because it module-mocks node:fs/promises to count
 * mkdir calls: the sink must create its journal directory once per session,
 * not once per record.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

const RECORD: JournalRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  ts: new Date(0).toISOString(),
  sessionId: 'session-1',
  direction: 'client→server',
  kind: 'notification',
  payload: { hello: 'world' },
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-sink-mkdir-'))
  vi.mocked(mkdir).mockClear()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('directory creation', () => {
  test('creates the journal directory once regardless of how many records are written', async () => {
    const sink = createJournalSink('session-1', { dir: join(tempDir, 'journal') })

    for (let i = 0; i < 10; i += 1) {
      sink.write(RECORD)
    }
    await sink.close()

    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(1)
  })
})
