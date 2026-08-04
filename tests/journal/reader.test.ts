import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { listSessions, readSession } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'

let tempDir: string

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-04T10:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    rpcId: 1,
    payload: {},
    ...overrides,
  }
}

async function writeJsonl(fileName: string, lines: string[]): Promise<void> {
  await writeFile(join(tempDir, fileName), lines.join('\n') + '\n', 'utf8')
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-reader-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('listSessions', () => {
  test('returns an empty list for an empty directory', async () => {
    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([])
  })

  test('returns an empty list for a missing directory instead of throwing', async () => {
    const missingDir = join(tempDir, 'does-not-exist')

    const sessions = await listSessions(missingDir)

    expect(sessions).toEqual([])
  })

  test('summarizes a session file with sessionId, firstTs, lastTs and messageCount', async () => {
    await writeJsonl('session-a.jsonl', [
      JSON.stringify(record({ ts: '2026-08-04T10:00:00.000Z' })),
      JSON.stringify(record({ ts: '2026-08-04T10:05:00.000Z' })),
      JSON.stringify(record({ ts: '2026-08-04T10:10:00.000Z' })),
    ])

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([
      {
        sessionId: 'session-a',
        firstTs: '2026-08-04T10:00:00.000Z',
        lastTs: '2026-08-04T10:10:00.000Z',
        messageCount: 3,
      },
    ])
  })

  test('sorts sessions newest-first by lastTs', async () => {
    await writeJsonl('session-old.jsonl', [
      JSON.stringify(record({ ts: '2026-08-01T00:00:00.000Z' })),
    ])
    await writeJsonl('session-new.jsonl', [
      JSON.stringify(record({ ts: '2026-08-04T00:00:00.000Z' })),
    ])

    const sessions = await listSessions(tempDir)

    expect(sessions.map((s) => s.sessionId)).toEqual(['session-new', 'session-old'])
  })

  test('skips malformed lines without failing the whole file', async () => {
    await writeJsonl('session-b.jsonl', [
      JSON.stringify(record({ ts: '2026-08-04T10:00:00.000Z' })),
      'not valid json {{{',
      JSON.stringify(record({ ts: '2026-08-04T10:01:00.000Z' })),
    ])

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([
      {
        sessionId: 'session-b',
        firstTs: '2026-08-04T10:00:00.000Z',
        lastTs: '2026-08-04T10:01:00.000Z',
        messageCount: 2,
      },
    ])
  })

  test('ignores non-.jsonl files in the directory', async () => {
    await writeJsonl('session-c.jsonl', [JSON.stringify(record())])
    await writeFile(join(tempDir, 'README.md'), 'not a session file', 'utf8')

    const sessions = await listSessions(tempDir)

    expect(sessions.map((s) => s.sessionId)).toEqual(['session-c'])
  })

  test('excludes a session file whose every line is malformed', async () => {
    await writeJsonl('session-empty.jsonl', ['not json', '{{{'])

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([])
  })
})

describe('readSession', () => {
  test('returns all records for a session in file order', async () => {
    await writeJsonl('session-d.jsonl', [
      JSON.stringify(record({ method: 'tools/list' })),
      JSON.stringify(record({ method: 'tools/call' })),
    ])

    const records = await readSession('session-d', { dir: tempDir })

    expect(records.map((r) => r.method)).toEqual(['tools/list', 'tools/call'])
  })

  test('filters by method', async () => {
    await writeJsonl('session-e.jsonl', [
      JSON.stringify(record({ method: 'tools/list' })),
      JSON.stringify(record({ method: 'tools/call' })),
      JSON.stringify(record({ method: 'tools/list' })),
    ])

    const records = await readSession('session-e', { dir: tempDir, method: 'tools/list' })

    expect(records).toHaveLength(2)
    expect(records.every((r) => r.method === 'tools/list')).toBe(true)
  })

  test('filters by direction', async () => {
    await writeJsonl('session-f.jsonl', [
      JSON.stringify(record({ direction: 'client→server' })),
      JSON.stringify(record({ direction: 'server→client' })),
      JSON.stringify(record({ direction: 'server-stderr', kind: 'stderr', payload: 'log line' })),
    ])

    const records = await readSession('session-f', { dir: tempDir, direction: 'server→client' })

    expect(records).toHaveLength(1)
    expect(records[0]?.direction).toBe('server→client')
  })

  test('filters by both method and direction together', async () => {
    await writeJsonl('session-g.jsonl', [
      JSON.stringify(record({ method: 'tools/call', direction: 'client→server' })),
      JSON.stringify(record({ method: 'tools/call', direction: 'server→client' })),
      JSON.stringify(record({ method: 'tools/list', direction: 'client→server' })),
    ])

    const records = await readSession('session-g', {
      dir: tempDir,
      method: 'tools/call',
      direction: 'client→server',
    })

    expect(records).toHaveLength(1)
    expect(records[0]?.method).toBe('tools/call')
    expect(records[0]?.direction).toBe('client→server')
  })

  test('skips malformed lines without failing', async () => {
    await writeJsonl('session-h.jsonl', [
      JSON.stringify(record({ method: 'tools/list' })),
      'garbage line',
      JSON.stringify(record({ method: 'tools/call' })),
    ])

    const records = await readSession('session-h', { dir: tempDir })

    expect(records).toHaveLength(2)
  })

  test('returns an empty array when the session file does not exist', async () => {
    const records = await readSession('missing-session', { dir: tempDir })

    expect(records).toEqual([])
  })

  test('returns an empty array when the directory does not exist', async () => {
    const records = await readSession('any-session', { dir: join(tempDir, 'nope') })

    expect(records).toEqual([])
  })
})
