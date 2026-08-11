import { describe, expect, test, vi } from 'vitest'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import type { UiSession } from '../../src/ui/auth.js'
import {
  createJournalHandler,
  JOURNAL_RECORDS_PER_PAGE,
  JOURNAL_SESSIONS_PER_PAGE,
  type JournalReadPort,
} from '../../src/ui/handlers/journal.js'
import type { CrossSessionSearchResult, SessionPage } from '../../src/journal/search.js'
import type { SessionSummaryEntry } from '../../src/journal/index-cache.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Task 15 — journal browser handler. Exercised through the injectable
 * `UiHandler` factory with a fake read port (search + index-cache seam), so
 * these tests touch no disk and assert only the handler's contract: how query
 * params become filters/pagination, honest truncation marking, escaping of
 * hostile payloads, and fail-closed session-id validation.
 */

const VIEWER: UiSession = { adminName: 'alice', role: 'viewer', csrfToken: 'csrf-xyz' }

function ctx(queryString: string, session: UiSession | undefined = VIEWER): UiRequestContext {
  return {
    method: 'GET',
    path: '/journal',
    params: {},
    query: new URLSearchParams(queryString),
    session,
    body: Buffer.alloc(0),
    headers: {},
  }
}

function summary(sessionId: string, extra: Partial<SessionSummaryEntry> = {}): SessionSummaryEntry {
  return {
    sessionId,
    firstTs: '2026-08-11T00:00:00.000Z',
    lastTs: '2026-08-11T01:00:00.000Z',
    count: 3,
    skippedLineCount: 0,
    size: 100,
    mtimeMs: 1,
    ...extra,
  }
}

function record(extra: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: 'rec-1',
    ts: '2026-08-11T00:00:00.000Z',
    sessionId: 'S1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
    ...extra,
  }
}

function emptyPage(extra: Partial<SessionPage> = {}): SessionPage {
  return {
    records: [],
    offset: 0,
    limit: JOURNAL_RECORDS_PER_PAGE,
    scannedLineCount: 0,
    skippedLineCount: 0,
    hasMore: false,
    truncated: false,
    ...extra,
  }
}

function emptyCross(extra: Partial<CrossSessionSearchResult> = {}): CrossSessionSearchResult {
  return {
    hits: [],
    truncated: false,
    stoppedBy: null,
    filesScanned: 0,
    filesTotal: 0,
    bytesRead: 0,
    skippedLineCount: 0,
    ...extra,
  }
}

interface FakePort extends JournalReadPort {
  readonly listSessions: ReturnType<typeof vi.fn>
  readonly searchSession: ReturnType<typeof vi.fn>
  readonly searchAllSessions: ReturnType<typeof vi.fn>
}

function fakePort(overrides: Partial<Record<keyof JournalReadPort, unknown>> = {}): FakePort {
  return {
    listSessions: vi.fn(async () => []),
    searchSession: vi.fn(async () => emptyPage()),
    searchAllSessions: vi.fn(async () => emptyCross()),
    ...overrides,
  } as FakePort
}

async function bodyOf(result: UiResult): Promise<string> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return typeof result.body === 'string' ? result.body : (result.body?.toString('utf8') ?? '')
}

describe('journal handler — session list', () => {
  test('lists sessions in the order the index-cache returns (descending activity), paginated', async () => {
    const total = JOURNAL_SESSIONS_PER_PAGE + 3
    const sessions = Array.from({ length: total }, (_, i) =>
      summary(`sess-${String(i).padStart(3, '0')}`),
    )
    const read = fakePort({ listSessions: vi.fn(async () => sessions) })
    const handler = createJournalHandler({ read })

    const firstPage = await bodyOf(await handler(ctx('')))
    // Page 1 shows the first page-worth, and preserves the given (descending) order.
    expect(firstPage).toContain('sess-000')
    expect(firstPage.indexOf('sess-000')).toBeLessThan(firstPage.indexOf('sess-001'))
    expect(firstPage).toContain(`sess-${String(JOURNAL_SESSIONS_PER_PAGE - 1).padStart(3, '0')}`)
    expect(firstPage).not.toContain(`sess-${String(JOURNAL_SESSIONS_PER_PAGE).padStart(3, '0')}`)

    const secondPage = await bodyOf(await handler(ctx('page=2')))
    expect(secondPage).toContain(`sess-${String(JOURNAL_SESSIONS_PER_PAGE).padStart(3, '0')}`)
    expect(secondPage).not.toContain('sess-000')
  })

  test('renders a friendly empty state when there are no sessions', async () => {
    const read = fakePort({ listSessions: vi.fn(async () => []) })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('')))
    expect(body.toLowerCase()).toContain('no sessions')
  })
})

describe('journal handler — single session view', () => {
  test('passes every query filter and pagination through to searchSession', async () => {
    const read = fakePort()
    const handler = createJournalHandler({ read, dir: '/some/journal' })

    await handler(
      ctx(
        'session=S1&kind=response&direction=' +
          encodeURIComponent('server→client') +
          '&method=tools/call&tool=create_issue&outcome=approved&q=hello&page=3',
      ),
    )

    expect(read.searchSession).toHaveBeenCalledTimes(1)
    const [sessionId, options] = read.searchSession.mock.calls[0]
    expect(sessionId).toBe('S1')
    expect(options).toMatchObject({
      kind: 'response',
      direction: 'server→client',
      method: 'tools/call',
      toolName: 'create_issue',
      outcome: 'approved',
      text: 'hello',
      dir: '/some/journal',
      limit: JOURNAL_RECORDS_PER_PAGE,
      offset: (3 - 1) * JOURNAL_RECORDS_PER_PAGE,
    })
  })

  test('escapes a hostile payload string rather than emitting live markup', async () => {
    const hostile = '<script>alert(1)</script>'
    const page = emptyPage({ records: [record({ payload: { note: hostile } })] })
    const read = fakePort({ searchSession: vi.fn(async () => page) })
    const handler = createJournalHandler({ read })

    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toContain('&lt;script&gt;')
    expect(body).not.toContain('<script>alert(1)</script>')
  })

  test('a decision record shows outcome, rule and a link to its approval resolution', async () => {
    const decisionRecord = record({
      kind: 'decision',
      decision: {
        outcome: 'require-approval-pending',
        rule: 'require-approval:write',
        serverName: 'github',
        toolName: 'create_issue',
        toolClass: 'write',
        quarantineState: 'known',
        argsHash: 'abc',
        approvalId: '01APPROVAL01',
      },
    })
    const read = fakePort({
      searchSession: vi.fn(async () => emptyPage({ records: [decisionRecord] })),
    })
    const handler = createJournalHandler({ read })

    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toContain('require-approval-pending')
    expect(body).toContain('require-approval:write')
    expect(body).toContain('01APPROVAL01')
    expect(body).toMatch(/<a[^>]+href="[^"]*01APPROVAL01[^"]*"/)
  })

  test('counts and shows unreadable lines instead of hiding them', async () => {
    const read = fakePort({
      searchSession: vi.fn(async () => emptyPage({ skippedLineCount: 4 })),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toContain('4')
    expect(body.toLowerCase()).toMatch(/unreadable|skipped/)
  })

  test('marks a truncated single-session scan honestly', async () => {
    const read = fakePort({
      searchSession: vi.fn(async () => emptyPage({ truncated: true, scannedLineCount: 200000 })),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body.toLowerCase()).toMatch(/truncat|stopped|incomplete/)
  })
})

describe('journal handler — cross-session search', () => {
  test('passes filters through to searchAllSessions', async () => {
    const read = fakePort()
    const handler = createJournalHandler({ read, dir: '/j' })

    await handler(ctx('q=hello&kind=decision&tool=create_issue&outcome=deny'))

    expect(read.searchAllSessions).toHaveBeenCalledTimes(1)
    expect(read.searchSession).not.toHaveBeenCalled()
    const [options] = read.searchAllSessions.mock.calls[0]
    expect(options).toMatchObject({
      text: 'hello',
      kind: 'decision',
      toolName: 'create_issue',
      outcome: 'deny',
      dir: '/j',
    })
  })

  test('honestly marks a truncated cross-session search with files scanned of total', async () => {
    const read = fakePort({
      searchAllSessions: vi.fn(async () =>
        emptyCross({ truncated: true, stoppedBy: 'limit', filesScanned: 5, filesTotal: 20 }),
      ),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('q=hello')))

    expect(body).toContain('5')
    expect(body).toContain('20')
    expect(body.toLowerCase()).toMatch(/stopped|truncat|limit/)
  })

  test('escapes hostile content in a cross-session hit', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const read = fakePort({
      searchAllSessions: vi.fn(async () =>
        emptyCross({ hits: [{ sessionId: 'S1', record: record({ payload: hostile }) }] }),
      ),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('q=x')))
    expect(body).not.toContain('<img src=x onerror=alert(1)>')
    expect(body).toContain('&lt;img')
  })
})

describe('journal handler — fail-closed session id', () => {
  test('a path-traversal session id yields a clean error, never a 500 or a disk read', async () => {
    const read = fakePort()
    const handler = createJournalHandler({ read })

    const result = await handler(ctx('session=' + encodeURIComponent('../../etc/passwd')))

    expect(result.kind).toBe('response')
    if (result.kind !== 'response') throw new Error('unreachable')
    expect(result.status).toBe(400)
    expect(read.searchSession).not.toHaveBeenCalled()
    const body = typeof result.body === 'string' ? result.body : (result.body?.toString() ?? '')
    expect(body.toLowerCase()).toContain('invalid')
    // The rejected value must not be reflected as live markup.
    expect(body).not.toContain('../../etc/passwd')
  })
})
