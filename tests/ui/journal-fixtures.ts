import { vi } from 'vitest'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import type { UiSession } from '../../src/ui/auth.js'
import { JOURNAL_RECORDS_PER_PAGE, type JournalReadPort } from '../../src/ui/handlers/journal.js'
import type { CrossSessionSearchResult, SessionPage } from '../../src/journal/search.js'
import type { SessionSummaryEntry } from '../../src/journal/index-cache.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Shared fixtures for the journal-browser handler tests: a fake read port
 * (search + index-cache seam) so no test touches disk, plus request/record
 * builders. Used by `journal.test.ts` (contract) and `journal-mcpcut.test.ts`
 * (McpCut front structure).
 */

export const VIEWER: UiSession = { adminName: 'alice', role: 'viewer', csrfToken: 'csrf-xyz' }

export function ctx(queryString: string, session: UiSession | undefined = VIEWER): UiRequestContext {
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

export function summary(sessionId: string, extra: Partial<SessionSummaryEntry> = {}): SessionSummaryEntry {
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

export function record(extra: Partial<JournalRecord> = {}): JournalRecord {
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

export function emptyPage(extra: Partial<SessionPage> = {}): SessionPage {
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

export function emptyCross(extra: Partial<CrossSessionSearchResult> = {}): CrossSessionSearchResult {
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

export interface FakePort extends JournalReadPort {
  readonly listSessions: ReturnType<typeof vi.fn>
  readonly searchSession: ReturnType<typeof vi.fn>
  readonly searchAllSessions: ReturnType<typeof vi.fn>
}

export function fakePort(overrides: Partial<Record<keyof JournalReadPort, unknown>> = {}): FakePort {
  return {
    listSessions: vi.fn(async () => []),
    searchSession: vi.fn(async () => emptyPage()),
    searchAllSessions: vi.fn(async () => emptyCross()),
    ...overrides,
  } as FakePort
}

export async function bodyOf(result: UiResult): Promise<string> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return typeof result.body === 'string' ? result.body : (result.body?.toString('utf8') ?? '')
}
