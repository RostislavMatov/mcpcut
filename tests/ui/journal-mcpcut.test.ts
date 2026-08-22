import { describe, expect, test, vi } from 'vitest'
import { createJournalHandler, JOURNAL_SESSIONS_PER_PAGE } from '../../src/ui/handlers/journal.js'
import { bodyOf, ctx, emptyCross, emptyPage, fakePort, record, summary } from './journal-fixtures.js'

/**
 * The journal browser in the McpCut "Call journal" language: panels with caps
 * header rows, grid rows, disclosure per record, pills for class/outcome, the
 * top-bar search as the text search and the in-panel filter form carrying the
 * session. Text contracts stay in `journal.test.ts`.
 */
describe('journal handler — McpCut front (structure)', () => {
  test('the session list is a "Call journal" panel with grid rows, nav meta and a pager in the footer', async () => {
    const total = JOURNAL_SESSIONS_PER_PAGE + 3
    const sessions = Array.from({ length: total }, (_, i) =>
      summary(`sess-${String(i).padStart(3, '0')}`, { skippedLineCount: i === 0 ? 2 : 0 }),
    )
    const read = fakePort({ listSessions: vi.fn(async () => sessions) })
    const handler = createJournalHandler({ read })

    const page2 = await bodyOf(await handler(ctx('page=2')))
    expect(page2).toContain('<h1>Call journal</h1>')
    expect(page2).toContain(`${total} sessions`)
    expect(page2).toMatch(/<span class="meta num">\d+ sessions<\/span>/)
    expect(page2).toMatch(/<a class="jr-row jr-session[^"]*" href="\/journal\?session=sess-050"/)
    expect(page2).toMatch(/<div class="panel-ft">[\s\S]*<nav class="pager">/)
    expect(page2).toContain('<a class="prev" href="/journal?page=1">Prev</a>')
    expect(page2).toContain('<span class="next disabled">Next</span>')

    const page1 = await bodyOf(await handler(ctx('')))
    expect(page1).toContain('<a class="next" href="/journal?page=2">Next</a>')
    expect(page1).toContain('<strong class="skipped">2</strong>')
    expect(page1).not.toContain('<table')
  })

  test('the top-bar search is the text search and echoes q; the in-panel filters carry the session', async () => {
    const read = fakePort()
    const handler = createJournalHandler({ read })

    const search = await bodyOf(await handler(ctx('q=hello&kind=decision')))
    expect(search).toContain('<form class="search" method="get" action="/journal" role="search">')
    expect(search).toMatch(/<input type="search" name="q" value="hello"[^>]*placeholder="search journal/)
    expect(search).toContain('<h1>Journal search</h1>')
    expect(search).toMatch(/<form class="filters jr-filters" method="get" action="\/journal">/)
    expect(search).toMatch(/<input type="text" name="kind" value="decision"/)

    const session = await bodyOf(await handler(ctx('session=S1&q=abc&tool=create_issue')))
    expect(session).toContain('<input type="hidden" name="session" value="S1">')
    expect(session).toMatch(/jr-filters[\s\S]*name="q" value="abc"/)
    expect(session).toMatch(/name="tool" value="create_issue"/)
    expect(session).toContain('<h1>Session S1</h1>')
    expect(session).toMatch(/<span class="meta num">page 1<\/span>/)
  })

  test('a record row is a <details> disclosure with the payload inside; time is HH:MM:SS with the full ts as title', async () => {
    const page = emptyPage({
      records: [record({ ts: '2026-08-11T09:08:07.000Z', payload: { a: 1 } })],
    })
    const read = fakePort({ searchSession: vi.fn(async () => page) })
    const handler = createJournalHandler({ read })

    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toMatch(
      /<details class="disclosure jr-rec[^"]*">\s*<summary class="jr-row jr-record">[\s\S]*?<\/summary>[\s\S]*?<pre class="payload">/,
    )
    expect(body).toMatch(/title="2026-08-11T09:08:07.000Z"[^>]*>09:08:07</)
    expect(body).toContain('client→server')
    expect(body).toContain('tools/call')
    expect(body).not.toContain('<span>Lat</span>')
  })

  test('a decision row shows the outcome as an alert pill for deny, the rule line and the approval link', async () => {
    const decisionRecord = record({
      kind: 'decision',
      decision: {
        outcome: 'deny',
        rule: 'deny:destructive',
        serverName: 'github',
        toolName: 'delete_repo',
        toolClass: 'destructive',
        quarantineState: 'known',
        argsHash: 'abc',
        approvalId: '01APPROVAL02',
        agentName: 'bot-1',
      },
    })
    const read = fakePort({
      searchSession: vi.fn(async () => emptyPage({ records: [decisionRecord] })),
    })
    const handler = createJournalHandler({ read })

    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toMatch(/<span class="pill pill-alert jr-outcome">deny<\/span>/)
    expect(body).toMatch(/<span class="pill jr-class">destructive<\/span>/)
    expect(body).toContain('github</span>/<span class="tool-name">delete_repo')
    expect(body).toContain('bot-1')
    expect(body).toMatch(/<p class="rule[^"]*">rule: deny:destructive/)
    expect(body).toContain('<a href="/#approval-01APPROVAL02">approval 01APPROVAL02</a>')
  })

  test('latency renders as the Lat column only when a record carries durationMs', async () => {
    const read = fakePort({
      searchSession: vi.fn(async () =>
        emptyPage({ records: [record({ kind: 'response', durationMs: 42 })] }),
      ),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('session=S1')))
    expect(body).toContain('<span>Lat</span>')
    expect(body).toMatch(/<span class="jr-lat num">42 ms<\/span>/)
    expect(body).toMatch(/<section class="panel jr-panel jr-has-lat"/)
  })

  test('a cross-session hit is a row prefixed by an escaped session link', async () => {
    const hostileId = '<b>S1</b>'
    const read = fakePort({
      searchAllSessions: vi.fn(async () =>
        emptyCross({ hits: [{ sessionId: hostileId, record: record() }], filesTotal: 2, filesScanned: 2 }),
      ),
    })
    const handler = createJournalHandler({ read })
    const body = await bodyOf(await handler(ctx('q=x')))
    expect(body).not.toContain('<b>S1</b>')
    expect(body).toMatch(
      /<a class="session-link[^"]*" href="\/journal\?session=%3Cb%3ES1%3C%2Fb%3E">&lt;b&gt;S1&lt;\/b&gt;<\/a>/,
    )
    expect(body).toContain('<p class="notice complete">Scanned all 2 session file(s).</p>')
    expect(body).toMatch(/<span class="meta num">1 hit<\/span>/)
  })

  test('the invalid-session view is a panel with an error notice and no reflected id', async () => {
    const read = fakePort()
    const handler = createJournalHandler({ read })
    const result = await handler(ctx('session=' + encodeURIComponent('a"b<c>')))
    const body = await bodyOf(result)
    expect(result.kind === 'response' && result.status).toBe(400)
    expect(body).toMatch(/<p class="notice error">Invalid session id/)
    expect(body).not.toContain('a"b<c>')
    expect(body).not.toContain('&lt;c&gt;')
  })
})
