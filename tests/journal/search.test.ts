import { appendFile, mkdir, mkdtemp, open, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  DEADLINE_CHECK_LINE_INTERVAL,
  DEFAULT_PAGE_LIMIT,
  defaultJournalReadDeps,
  searchAllSessions,
  searchSession,
  type JournalReadDeps,
} from '../../src/journal/search.js'
import { createSessionIndexCache } from '../../src/journal/index-cache.js'
import type { DecisionInfo, JournalRecord } from '../../src/journal/record.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-search-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-11T10:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    rpcId: 1,
    payload: {},
    ...overrides,
  }
}

function decision(overrides: Partial<DecisionInfo> = {}): DecisionInfo {
  return {
    outcome: 'allow',
    rule: 'classDefaults.read',
    serverName: 'github',
    toolName: 'list_issues',
    toolClass: 'read',
    quarantineState: 'known',
    argsHash: 'sha256:abc',
    ...overrides,
  }
}

function decisionRecord(
  decisionOverrides: Partial<DecisionInfo> = {},
  overrides: Partial<JournalRecord> = {},
): JournalRecord {
  return record({
    kind: 'decision',
    method: undefined,
    payload: null,
    decision: decision(decisionOverrides),
    ...overrides,
  })
}

async function writeLines(sessionId: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(tempDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

async function writeRecords(
  sessionId: string,
  records: readonly JournalRecord[],
): Promise<void> {
  await writeLines(
    sessionId,
    records.map((entry) => JSON.stringify(entry)),
  )
}

interface Counters {
  lineCount: number
  openedFiles: string[]
  statCount: number
}

async function* countLines(
  source: AsyncIterable<string>,
  counters: Counters,
): AsyncGenerator<string> {
  for await (const line of source) {
    counters.lineCount += 1
    yield line
  }
}

/** Wraps the real deps with counters so tests can assert how much was read. */
function countingDeps(overrides: Partial<JournalReadDeps> = {}): {
  deps: JournalReadDeps
  counters: Counters
} {
  const counters: Counters = { lineCount: 0, openedFiles: [], statCount: 0 }
  const deps: JournalReadDeps = {
    readLines: (filePath) => {
      counters.openedFiles.push(filePath)
      return countLines(defaultJournalReadDeps.readLines(filePath), counters)
    },
    listFiles: (dir) => defaultJournalReadDeps.listFiles(dir),
    statFile: async (filePath) => {
      counters.statCount += 1
      return defaultJournalReadDeps.statFile(filePath)
    },
    now: () => defaultJournalReadDeps.now(),
    ...overrides,
  }
  return { deps, counters }
}

/** A clock that jumps `stepMs` on every read: makes deadline trips deterministic. */
function steppingClock(stepMs: number): () => number {
  let currentMs = 0
  return () => {
    currentMs += stepMs
    return currentMs
  }
}

/** Sets a file's mtime without touching its contents. */
async function setMtime(fileName: string, mtimeMs: number): Promise<void> {
  const path = join(tempDir, fileName)
  const seconds = mtimeMs / 1000
  await utimes(path, seconds, seconds)
}

describe('searchSession — paging', () => {
  test('returns the requested page of records in file order', async () => {
    await writeRecords(
      'paged',
      Array.from({ length: 30 }, (_, index) => record({ rpcId: index })),
    )

    const page = await searchSession('paged', { dir: tempDir, offset: 10, limit: 5 })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([10, 11, 12, 13, 14])
    expect(page.offset).toBe(10)
    expect(page.limit).toBe(5)
    expect(page.hasMore).toBe(true)
  })

  test('does not read the whole file to build the first page', async () => {
    const lineCount = 2000
    await writeRecords(
      'large',
      Array.from({ length: lineCount }, (_, index) => record({ rpcId: index })),
    )
    const { deps, counters } = countingDeps()

    const page = await searchSession('large', { dir: tempDir, offset: 0, limit: 10 }, deps)

    expect(page.records).toHaveLength(10)
    expect(page.hasMore).toBe(true)
    // 10 page lines + 1 probe line that proves there is more; never 2000.
    expect(counters.lineCount).toBeLessThanOrEqual(12)
    expect(page.scannedLineCount).toBeLessThanOrEqual(12)
  })

  test('reports hasMore false on the last page', async () => {
    await writeRecords(
      'tail',
      Array.from({ length: 12 }, (_, index) => record({ rpcId: index })),
    )

    const page = await searchSession('tail', { dir: tempDir, offset: 10, limit: 10 })

    expect(page.records).toHaveLength(2)
    expect(page.hasMore).toBe(false)
    expect(page.truncated).toBe(false)
  })

  test('returns an empty page when the offset is past the end', async () => {
    await writeRecords('short', [record(), record()])

    const page = await searchSession('short', { dir: tempDir, offset: 50, limit: 10 })

    expect(page.records).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  test('marks the page truncated when the per-session scan cap is reached', async () => {
    await writeRecords(
      'capped',
      Array.from({ length: 100 }, (_, index) => record({ rpcId: index })),
    )

    const page = await searchSession('capped', {
      dir: tempDir,
      limit: 100,
      maxScannedLines: 10,
    })

    expect(page.truncated).toBe(true)
    expect(page.records.length).toBeLessThanOrEqual(10)
  })
})

describe('searchSession — filters', () => {
  const mixed: readonly JournalRecord[] = [
    record({ rpcId: 0, method: 'tools/list', direction: 'client→server' }),
    record({ rpcId: 1, method: 'tools/call', direction: 'client→server' }),
    record({ rpcId: 2, method: 'tools/call', direction: 'server→client', kind: 'response' }),
    decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 3 }),
    decisionRecord({ toolName: 'create_issue', outcome: 'approved' }, { rpcId: 4 }),
  ]

  test('filters by kind', async () => {
    await writeRecords('filters', mixed)

    const page = await searchSession('filters', { dir: tempDir, kind: 'decision' })

    expect(page.records).toHaveLength(2)
    expect(page.records.every((entry) => entry.kind === 'decision')).toBe(true)
  })

  test('filters by direction', async () => {
    await writeRecords('filters', mixed)

    const page = await searchSession('filters', { dir: tempDir, direction: 'server→client' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([2])
  })

  test('filters by method', async () => {
    await writeRecords('filters', mixed)

    const page = await searchSession('filters', { dir: tempDir, method: 'tools/call' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([1, 2])
  })

  test('filters by decision toolName', async () => {
    await writeRecords('filters', mixed)

    const page = await searchSession('filters', { dir: tempDir, toolName: 'delete_repo' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([3])
  })

  test('filters by decision outcome', async () => {
    await writeRecords('filters', mixed)

    const page = await searchSession('filters', { dir: tempDir, outcome: 'approved' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([4])
  })

  test('filters by case-insensitive substring across payload, method and decision', async () => {
    await writeRecords('text', [
      record({ rpcId: 0, payload: { params: { name: 'list_issues' } } }),
      record({ rpcId: 1, payload: { params: { name: 'DELETE_repo' } } }),
      decisionRecord({ rule: 'servers.github.tools.delete_*' }, { rpcId: 2 }),
    ])

    const page = await searchSession('text', { dir: tempDir, text: 'delete_' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([1, 2])
  })

  test('combines kind, direction, method, toolName, outcome and substring', async () => {
    const target = decisionRecord(
      { toolName: 'create_issue', outcome: 'approved', rule: 'servers.github.tools.create_*' },
      { rpcId: 99, direction: 'client→server', method: 'tools/call' },
    )
    await writeRecords('combined', [
      ...mixed,
      decisionRecord(
        { toolName: 'create_issue', outcome: 'deny' },
        { rpcId: 98, direction: 'client→server', method: 'tools/call' },
      ),
      decisionRecord(
        { toolName: 'create_issue', outcome: 'approved' },
        { rpcId: 97, direction: 'server→client', method: 'tools/call' },
      ),
      target,
    ])

    const page = await searchSession('combined', {
      dir: tempDir,
      kind: 'decision',
      direction: 'client→server',
      method: 'tools/call',
      toolName: 'create_issue',
      outcome: 'approved',
      text: 'servers.github.tools.create_',
    })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([99])
  })

  test('returns nothing when one filter of the combination excludes every record', async () => {
    await writeRecords('combined-empty', mixed)

    const page = await searchSession('combined-empty', {
      dir: tempDir,
      kind: 'decision',
      method: 'tools/call',
    })

    expect(page.records).toEqual([])
  })
})

describe('searchSession — untrusted input', () => {
  test('skips malformed lines, counts them, and still returns the good ones', async () => {
    await writeLines('broken', [
      JSON.stringify(record({ rpcId: 0 })),
      'not json at all {{{',
      JSON.stringify({ kind: 'request' }),
      '',
      JSON.stringify(record({ rpcId: 1 })),
    ])

    const page = await searchSession('broken', { dir: tempDir })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([0, 1])
    expect(page.skippedLineCount).toBe(2)
  })

  test('skips a line that is valid JSON but not an object', async () => {
    await writeLines('not-objects', [
      '[1, 2, 3]',
      '"just a string"',
      '42',
      JSON.stringify(record({ rpcId: 5 })),
    ])

    const page = await searchSession('not-objects', { dir: tempDir })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([5])
    expect(page.skippedLineCount).toBe(3)
  })

  test('searches the raw text of a stderr record', async () => {
    await writeRecords('stderr', [
      record({
        rpcId: 0,
        kind: 'stderr',
        direction: 'server-stderr',
        method: undefined,
        payload: 'upstream said: rate limit exceeded',
      }),
      record({ rpcId: 1, payload: {} }),
    ])

    const page = await searchSession('stderr', { dir: tempDir, text: 'RATE LIMIT' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([0])
  })

  test('surfaces a read error that is not "missing" instead of returning an empty page', async () => {
    await mkdir(join(tempDir, 'directory-not-file.jsonl'))

    await expect(searchSession('directory-not-file', { dir: tempDir })).rejects.toThrow(/EISDIR/)
  })

  test('rejects a decision record whose decision field is the wrong shape', async () => {
    await writeLines('bad-decision', [
      JSON.stringify(record({ kind: 'decision', decision: undefined })),
      JSON.stringify(record({ rpcId: 7 })),
    ])

    const page = await searchSession('bad-decision', { dir: tempDir })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([7])
    expect(page.skippedLineCount).toBe(1)
  })

  test('returns an empty page when the session file is missing', async () => {
    const page = await searchSession('missing', { dir: tempDir })

    expect(page.records).toEqual([])
    expect(page.skippedLineCount).toBe(0)
  })

  test('returns an empty page when the directory does not exist', async () => {
    const page = await searchSession('any', { dir: join(tempDir, 'nope') })

    expect(page.records).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  test('throws before building a path when the session id is unsafe', async () => {
    await expect(searchSession('../../etc/passwd', { dir: tempDir })).rejects.toThrow(
      /Invalid session id/,
    )
  })

  test('clamps a hostile page size instead of honouring it', async () => {
    await writeRecords('clamp', [record()])

    const page = await searchSession('clamp', { dir: tempDir, limit: 10_000_000, offset: -5 })

    expect(page.limit).toBeLessThanOrEqual(1000)
    expect(page.offset).toBe(0)
  })

  test('falls back to the default page size when the numbers are not numbers', async () => {
    await writeRecords('nan', [record()])

    const page = await searchSession('nan', { dir: tempDir, limit: Number.NaN, offset: Number.NaN })

    expect(page.limit).toBe(DEFAULT_PAGE_LIMIT)
    expect(page.offset).toBe(0)
    expect(page.records).toHaveLength(1)
  })

  test('surfaces a directory error that is not "missing" instead of hiding it', async () => {
    await writeFile(join(tempDir, 'plain.txt'), 'not a directory', 'utf8')

    await expect(searchAllSessions({ dir: join(tempDir, 'plain.txt') })).rejects.toThrow(
      /ENOTDIR/,
    )
  })
})

describe('createSessionIndexCache', () => {
  test('summarizes every session with counts, timestamps, size and mtime', async () => {
    await writeRecords('cache-a', [
      record({ ts: '2026-08-11T10:00:00.000Z' }),
      record({ ts: '2026-08-11T10:05:00.000Z' }),
    ])
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(tempDir)
    const stats = await stat(join(tempDir, 'cache-a.jsonl'))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: 'cache-a',
      firstTs: '2026-08-11T10:00:00.000Z',
      lastTs: '2026-08-11T10:05:00.000Z',
      count: 2,
      skippedLineCount: 0,
      size: stats.size,
    })
    expect(sessions[0]?.mtimeMs).toBeCloseTo(stats.mtimeMs, 0)
  })

  test('sorts sessions by last activity, newest first', async () => {
    await writeRecords('older', [record({ ts: '2026-08-01T00:00:00.000Z' })])
    await writeRecords('newer', [record({ ts: '2026-08-10T00:00:00.000Z' })])
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(tempDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['newer', 'older'])
  })

  test('does not re-read a file whose mtime and size are unchanged', async () => {
    await writeRecords('stable', [record(), record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)

    const first = await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount
    const second = await cache.listSessions(tempDir)

    expect(linesAfterFirst).toBeGreaterThan(0)
    expect(counters.lineCount).toBe(linesAfterFirst)
    expect(second).toEqual(first)
  })

  test('re-reads a file whose size changed', async () => {
    await writeRecords('growing', [record({ ts: '2026-08-11T10:00:00.000Z' })])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount

    await appendFile(
      join(tempDir, 'growing.jsonl'),
      JSON.stringify(record({ ts: '2026-08-11T11:00:00.000Z' })) + '\n',
      'utf8',
    )
    const sessions = await cache.listSessions(tempDir)

    expect(counters.lineCount).toBeGreaterThan(linesAfterFirst)
    expect(sessions[0]?.count).toBe(2)
    expect(sessions[0]?.lastTs).toBe('2026-08-11T11:00:00.000Z')
  })

  test('re-reads a file whose mtime changed even when its size did not', async () => {
    await writeRecords('touched', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount

    await setMtime('touched.jsonl', Date.now() + 60_000)
    await cache.listSessions(tempDir)

    expect(counters.lineCount).toBeGreaterThan(linesAfterFirst)
  })

  test('re-reads a rewritten file that kept its mtime but changed size', async () => {
    await writeRecords('rewritten', [record({ rpcId: 1 })])
    const original = await stat(join(tempDir, 'rewritten.jsonl'))
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount

    await writeRecords('rewritten', [record({ rpcId: 1 }), record({ rpcId: 2 })])
    await setMtime('rewritten.jsonl', original.mtimeMs)
    const sessions = await cache.listSessions(tempDir)

    expect(counters.lineCount).toBeGreaterThan(linesAfterFirst)
    expect(sessions[0]?.count).toBe(2)
  })

  test('caches the "no readable record" verdict without re-reading the file', async () => {
    await writeLines('garbage', ['not json', '{{{'])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)

    const first = await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount
    await cache.listSessions(tempDir)

    expect(first).toEqual([])
    expect(counters.lineCount).toBe(linesAfterFirst)
  })

  test('returns an empty list for a missing directory instead of throwing', async () => {
    const cache = createSessionIndexCache()

    await expect(cache.listSessions(join(tempDir, 'nope'))).resolves.toEqual([])
  })

  test('ignores non-.jsonl files', async () => {
    await writeRecords('kept', [record()])
    await writeFile(join(tempDir, 'README.md'), 'not a journal', 'utf8')
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(tempDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['kept'])
  })

  test('evicts the least recently used entry when the cache is full', async () => {
    for (const index of [0, 1, 2]) {
      await writeRecords(`evict-${index}`, [record()])
    }
    const cache = createSessionIndexCache({}, { maxEntries: 2 })

    await cache.listSessions(tempDir)

    expect(cache.cachedCount()).toBeLessThanOrEqual(2)
  })

  test('invalidate() forces a re-read of one session only', async () => {
    await writeRecords('inv-a', [record()])
    await writeRecords('inv-b', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount

    cache.invalidate('inv-a', tempDir)
    await cache.listSessions(tempDir)

    expect(counters.lineCount).toBe(linesAfterFirst + 1)
  })

  test('clear() drops every cached summary', async () => {
    await writeRecords('cleared', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const linesAfterFirst = counters.lineCount

    cache.clear()
    await cache.listSessions(tempDir)

    expect(cache.cachedCount()).toBe(1)
    expect(counters.lineCount).toBe(linesAfterFirst * 2)
  })

  test('getSession() returns one summary and null for a missing session', async () => {
    await writeRecords('one', [record()])
    const cache = createSessionIndexCache()

    await expect(cache.getSession('one', tempDir)).resolves.toMatchObject({ count: 1 })
    await expect(cache.getSession('absent', tempDir)).resolves.toBeNull()
  })

  test('getSession() rejects an unsafe session id', async () => {
    const cache = createSessionIndexCache()

    await expect(cache.getSession('../escape', tempDir)).rejects.toThrow(/Invalid session id/)
  })

  test('surfaces a stat error that is not "missing" instead of caching a wrong verdict', async () => {
    await writeFile(join(tempDir, 'plain.txt'), 'not a directory', 'utf8')
    const cache = createSessionIndexCache()

    await expect(cache.getSession('any', join(tempDir, 'plain.txt'))).rejects.toThrow(/ENOTDIR/)
    expect(cache.cachedCount()).toBe(0)
  })

  test('forgets a session whose file disappeared', async () => {
    await writeRecords('vanishing', [record()])
    const cache = createSessionIndexCache()
    await cache.listSessions(tempDir)

    await rm(join(tempDir, 'vanishing.jsonl'))

    await expect(cache.getSession('vanishing', tempDir)).resolves.toBeNull()
    expect(cache.cachedCount()).toBe(0)
  })
})

describe('searchAllSessions', () => {
  async function writeThreeSessions(): Promise<void> {
    await writeRecords('cross-old', [record({ rpcId: 1, method: 'tools/call' })])
    await writeRecords('cross-mid', [record({ rpcId: 2, method: 'tools/call' })])
    await writeRecords('cross-new', [record({ rpcId: 3, method: 'tools/call' })])
    await setMtime('cross-old.jsonl', 1_000_000)
    await setMtime('cross-mid.jsonl', 2_000_000)
    await setMtime('cross-new.jsonl', 3_000_000)
  }

  test('walks files newest-first and reports an untruncated scan', async () => {
    await writeThreeSessions()

    const result = await searchAllSessions({ dir: tempDir })

    expect(result.hits.map((hit) => hit.sessionId)).toEqual([
      'cross-new',
      'cross-mid',
      'cross-old',
    ])
    expect(result.hits.map((hit) => hit.record.rpcId)).toEqual([3, 2, 1])
    expect(result.truncated).toBe(false)
    expect(result.stoppedBy).toBeNull()
    expect(result.filesScanned).toBe(3)
    expect(result.filesTotal).toBe(3)
  })

  test('applies the same filters as a single-session search', async () => {
    await writeRecords('f-1', [
      record({ rpcId: 1, method: 'tools/list' }),
      decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 2 }),
    ])
    await writeRecords('f-2', [decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 3 })])

    const result = await searchAllSessions({
      dir: tempDir,
      kind: 'decision',
      toolName: 'delete_repo',
      outcome: 'deny',
    })

    expect(result.hits.map((hit) => hit.record.rpcId).sort()).toEqual([2, 3])
  })

  test('stops at the file limit and says so', async () => {
    await writeThreeSessions()

    const result = await searchAllSessions({ dir: tempDir, maxFiles: 1 })

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('files')
    expect(result.filesScanned).toBe(1)
    expect(result.filesTotal).toBe(3)
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['cross-new'])
  })

  test('stops at the byte limit and says so', async () => {
    await writeThreeSessions()

    const result = await searchAllSessions({ dir: tempDir, maxBytes: 10 })

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('bytes')
    expect(result.filesScanned).toBeLessThan(result.filesTotal)
    expect(result.bytesRead).toBeGreaterThan(0)
  })

  test('stops at the deadline between files and says so', async () => {
    await writeThreeSessions()
    const { deps } = countingDeps({ now: steppingClock(600) })

    const result = await searchAllSessions({ dir: tempDir, timeBudgetMs: 1000 }, deps)

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('deadline')
    expect(result.filesScanned).toBeLessThan(result.filesTotal)
  })

  test('stops at the deadline inside a long file', async () => {
    const lineCount = DEADLINE_CHECK_LINE_INTERVAL * 3
    await writeRecords(
      'long',
      Array.from({ length: lineCount }, (_, index) => record({ rpcId: index })),
    )
    await writeRecords('other', [record()])
    const { deps } = countingDeps({ now: steppingClock(400) })

    const result = await searchAllSessions(
      { dir: tempDir, timeBudgetMs: 500, limit: lineCount + 10 },
      deps,
    )

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('deadline')
    expect(result.hits.length).toBeLessThan(lineCount)
  })

  test('stops at the hit limit only when there is genuinely more to return', async () => {
    await writeThreeSessions()

    const capped = await searchAllSessions({ dir: tempDir, limit: 2 })
    const exact = await searchAllSessions({ dir: tempDir, limit: 3 })

    expect(capped.hits).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    expect(capped.stoppedBy).toBe('limit')
    expect(exact.hits).toHaveLength(3)
    expect(exact.truncated).toBe(false)
  })

  test('counts unreadable lines across files instead of failing', async () => {
    await writeLines('bad-1', ['{{{', JSON.stringify(record({ rpcId: 1 }))])
    await writeLines('bad-2', ['still not json', JSON.stringify(record({ rpcId: 2 }))])

    const result = await searchAllSessions({ dir: tempDir })

    expect(result.hits).toHaveLength(2)
    expect(result.skippedLineCount).toBe(2)
  })

  test('returns an empty result for a missing directory instead of throwing', async () => {
    const result = await searchAllSessions({ dir: join(tempDir, 'nope') })

    expect(result.hits).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.filesTotal).toBe(0)
    expect(result.filesScanned).toBe(0)
  })

  test('ignores files whose name is not a usable session id', async () => {
    await writeRecords('good', [record()])
    await writeFile(join(tempDir, 'not a session!.jsonl'), JSON.stringify(record()) + '\n', 'utf8')

    const result = await searchAllSessions({ dir: tempDir })

    expect(result.filesTotal).toBe(1)
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['good'])
  })
})

/**
 * Cost gate for the whole layer: a journal far larger than the memory budget
 * must be walked as a stream, never materialized. Heap is sampled *during* the
 * walk, not only after it: an implementation that built an array of every
 * record and then filtered it would release that array before returning, so an
 * after-the-fact delta would not notice. Peak growth does.
 */
describe('large journal budget', () => {
  const FIXTURE_BYTES = 128 * 1024 * 1024
  const CHUNK_BYTES = 4 * 1024 * 1024
  const HEAP_SAMPLE_INTERVAL_MS = 20
  const NEEDLE = 'needle-cd6f0a1b'
  /**
   * Well under what holding this fixture's ~225k parsed records would need
   * (>120 MB of retained objects alone), and well above the tens of megabytes
   * of short-lived parse garbage a streaming walk produces between collections.
   */
  const HEAP_BUDGET_BYTES = 64 * 1024 * 1024

  async function writeLargeFixture(sessionId: string): Promise<number> {
    const filler = 'x'.repeat(400)
    const handle = await open(join(tempDir, `${sessionId}.jsonl`), 'w')
    let written = 0
    let index = 0
    try {
      while (written < FIXTURE_BYTES) {
        let chunk = ''
        while (chunk.length < CHUNK_BYTES && written + chunk.length < FIXTURE_BYTES) {
          chunk += JSON.stringify(record({ rpcId: index, payload: { filler } })) + '\n'
          index += 1
        }
        await handle.write(chunk)
        written += chunk.length
      }
      await handle.write(JSON.stringify(record({ rpcId: -1, payload: { marker: NEEDLE } })) + '\n')
    } finally {
      await handle.close()
    }
    return index
  }

  async function measurePeakHeapGrowth<T>(
    action: () => Promise<T>,
  ): Promise<{ result: T; peakGrowthBytes: number }> {
    globalThis.gc?.()
    const baseline = process.memoryUsage().heapUsed
    let peak = baseline
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }, HEAP_SAMPLE_INTERVAL_MS)
    try {
      const result = await action()
      peak = Math.max(peak, process.memoryUsage().heapUsed)
      return { result, peakGrowthBytes: peak - baseline }
    } finally {
      clearInterval(sampler)
    }
  }

  test('walks a 128 MB journal within a bounded heap budget', { timeout: 300_000 }, async () => {
    const lineCount = await writeLargeFixture('huge')

    const { result: page, peakGrowthBytes } = await measurePeakHeapGrowth(() =>
      searchSession('huge', {
        dir: tempDir,
        text: NEEDLE,
        limit: 10,
        maxScannedLines: lineCount + 10,
      }),
    )

    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.rpcId).toBe(-1)
    expect(page.truncated).toBe(false)
    expect(page.scannedLineCount).toBeGreaterThan(lineCount)
    expect(peakGrowthBytes).toBeLessThan(HEAP_BUDGET_BYTES)
  })

  test('stops a cross-session walk at the byte ceiling and admits it', { timeout: 300_000 }, async () => {
    await writeLargeFixture('huge')

    const { result, peakGrowthBytes } = await measurePeakHeapGrowth(() =>
      searchAllSessions({ dir: tempDir, text: NEEDLE }),
    )

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('bytes')
    expect(result.bytesRead).toBeLessThanOrEqual(FIXTURE_BYTES)
    expect(result.filesScanned).toBe(1)
    expect(result.filesTotal).toBe(1)
    expect(peakGrowthBytes).toBeLessThan(HEAP_BUDGET_BYTES)
  })
})
