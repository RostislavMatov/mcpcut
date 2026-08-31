import { describe, expect, test, vi } from 'vitest'
import { createJournalHandler } from '../../src/ui/handlers/journal.js'
import {
  applyPick,
  applyPreset,
  dayBefore,
  monthGrid,
  periodLabel,
  shiftMonth,
  shortTime,
} from '../../src/ui/pages/journal-period.js'
import { bodyOf, ctx, emptyCross, emptyPage, fakePort, record, summary } from './journal-fixtures.js'

/**
 * The journal's period control and the `Sessions`/`Records` tabs, redrawn from
 * Claude Design `Journal.dc.html` (2026-08-27).
 *
 * The load-bearing property under test is that the whole control works with
 * JavaScript off: its days, presets, month arrows and `Done` are submit
 * buttons of the filter form, and the handler folds them into `from`/`to`
 * exactly as the design's in-memory `setPeriod` does.
 */

/** A handler with "today" pinned, so preset spans are assertable. */
function handlerAt(today: string, read = fakePort()) {
  return createJournalHandler({ read, now: () => new Date(`${today}T12:00:00.000Z`) })
}

describe('period arithmetic', () => {
  test('a day label and a record stamp read as the design writes them', () => {
    expect(periodLabel('2026-08-20', '2026-08-27')).toBe('Aug 20 26 → Aug 27 26')
    expect(periodLabel('2026-08-20', '')).toBe('from Aug 20 26')
    expect(periodLabel('', '2026-08-27')).toBe('to Aug 27 26')
    expect(periodLabel('', '')).toBe('period · all')
    expect(shortTime('2026-08-27T09:02:11.004Z')).toBe('Aug 27 26 09:02:11')
    expect(shortTime('not-a-timestamp')).toBe('not-a-timestamp')
  })

  test('presets count back from today inclusive', () => {
    expect(dayBefore('2026-08-27', 0)).toBe('2026-08-27')
    expect(applyPreset('24h', '2026-08-27')).toEqual({ from: '2026-08-27', to: '2026-08-27' })
    expect(applyPreset('7d', '2026-08-27')).toEqual({ from: '2026-08-21', to: '2026-08-27' })
    expect(applyPreset('30d', '2026-08-27')).toEqual({ from: '2026-07-29', to: '2026-08-27' })
    expect(applyPreset('all', '2026-08-27')).toEqual({ from: '', to: '' })
    expect(applyPreset('nonsense', '2026-08-27')).toBeUndefined()
  })

  test('a first click starts a period, a second closes it, and a backwards second click swaps', () => {
    expect(applyPick('', '', '2026-08-20')).toEqual({ from: '2026-08-20', to: '' })
    expect(applyPick('2026-08-20', '', '2026-08-27')).toEqual({ from: '2026-08-20', to: '2026-08-27' })
    expect(applyPick('2026-08-20', '', '2026-08-11')).toEqual({ from: '2026-08-11', to: '2026-08-20' })
    // A closed period restarts rather than growing — the design's rule.
    expect(applyPick('2026-08-20', '2026-08-27', '2026-08-30')).toEqual({ from: '2026-08-30', to: '' })
  })

  test('the month grid is Monday-first with leading blanks and every day of the month', () => {
    const august = monthGrid('2026-08')
    // 2026-08-01 is a Saturday, so five blanks lead the grid.
    expect(august.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(august[5]).toBe('2026-08-01')
    expect(august.filter((cell) => cell !== null)).toHaveLength(31)
    expect(monthGrid('2026-02').filter((cell) => cell !== null)).toHaveLength(28)
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
})

describe('the period control renders as no-JS form controls', () => {
  test('closed by default, its cells are submit buttons and the form carries from/to', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('session=S1')))
    expect(body).toContain('<details class="jr-period">')
    expect(body).toContain('<summary class="jr-period-btn">period · all')
    expect(body).toContain('<input type="hidden" name="from" value="">')
    expect(body).toContain('<input type="hidden" name="to" value="">')
    expect(body).toContain('<button type="submit" class="jr-day" name="pick" value="2026-08-27"')
    expect(body).toContain('<button type="submit" class="jr-preset" name="period" value="7d">7d</button>')
    expect(body).toContain('<button type="submit" name="close" value="1">Done</button>')
  })

  test('a day click applies the period, marks the edge and leaves the popover open', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('session=S1&pick=2026-08-20')))
    expect(body).toContain('<details class="jr-period is-set" open>')
    expect(body).toContain('<summary class="jr-period-btn">from Aug 20 26')
    expect(body).toContain('<input type="hidden" name="from" value="2026-08-20">')
    expect(body).toMatch(/class="jr-day is-edge" name="pick" value="2026-08-20"[^>]*aria-current="date"/)
    expect(body).toContain('pick the end of the period')
  })

  test('a second day click closes the period and paints the days between it as in-range', async () => {
    const body = await bodyOf(
      await handlerAt('2026-08-27')(ctx('session=S1&from=2026-08-20&pick=2026-08-23')),
    )
    expect(body).toContain('<summary class="jr-period-btn">Aug 20 26 → Aug 23 26')
    expect(body).toContain('<input type="hidden" name="to" value="2026-08-23">')
    expect(body).toMatch(/class="jr-day in-range" name="pick" value="2026-08-21"/)
    expect(body).toMatch(/class="jr-day in-range" name="pick" value="2026-08-22"/)
    expect(body).toContain('click a day to start a period')
  })

  test('a preset lights up, `All` clears the period, and `Done` closes the popover', async () => {
    const handler = handlerAt('2026-08-27')

    const preset = await bodyOf(await handler(ctx('session=S1&period=7d')))
    expect(preset).toContain('<input type="hidden" name="from" value="2026-08-21">')
    expect(preset).toContain('<button type="submit" class="jr-preset is-on" name="period" value="7d">')

    const cleared = await bodyOf(await handler(ctx('session=S1&from=2026-08-21&to=2026-08-27&period=all')))
    expect(cleared).toContain('<details class="jr-period" open>')
    expect(cleared).toContain('<summary class="jr-period-btn">period · all')

    const done = await bodyOf(await handler(ctx('session=S1&from=2026-08-21&to=2026-08-27&close=1')))
    expect(done).toContain('<details class="jr-period is-set">')
    expect(done).not.toContain('<details class="jr-period is-set" open>')
  })

  test('the calendar opens on the period, the arrows move it, and the month rides along as a hidden field', async () => {
    const handler = handlerAt('2026-08-27')

    const onPeriod = await bodyOf(await handler(ctx('session=S1&from=2026-05-04&to=2026-05-09')))
    expect(onPeriod).toContain('<span class="jr-picker-month">MAY 2026</span>')
    expect(onPeriod).toContain('<input type="hidden" name="pm" value="2026-05">')

    const navigated = await bodyOf(await handler(ctx('session=S1&pmnav=2026-07')))
    expect(navigated).toContain('<span class="jr-picker-month">JUL 2026</span>')
    expect(navigated).toContain('<details class="jr-period" open>')

    // The carried month survives the next pick, which is the whole point of
    // splitting `pm` (carry) from `pmnav` (the arrow).
    const picked = await bodyOf(await handler(ctx('session=S1&pm=2026-07&pick=2026-07-04')))
    expect(picked).toContain('<span class="jr-picker-month">JUL 2026</span>')
  })

  test('a malformed day or month narrows nothing instead of narrowing to garbage', async () => {
    const read = fakePort()
    const handler = handlerAt('2026-08-27', read)
    const body = await bodyOf(await handler(ctx('session=S1&from=2026-13-99&pmnav=oops&pick=%3Cscript%3E')))
    expect(body).toContain('<summary class="jr-period-btn">period · all')
    expect(body).toContain('<span class="jr-picker-month">AUG 2026</span>')
    expect(body).not.toContain('<script>')
    expect(read.searchSession).toHaveBeenCalledWith('S1', expect.not.objectContaining({ from: expect.anything() }))
  })

  test('the period reaches the read layer as from/to filters', async () => {
    const read = fakePort()
    await handlerAt('2026-08-27', read)(ctx('session=S1&from=2026-08-01&to=2026-08-02'))
    expect(read.searchSession).toHaveBeenCalledWith(
      'S1',
      expect.objectContaining({ from: '2026-08-01', to: '2026-08-02' }),
    )
  })
})

describe('the Sessions / Records tabs', () => {
  test('the session list lights Sessions and offers Records; a session view lights Records', async () => {
    const list = await bodyOf(await handlerAt('2026-08-27')(ctx('')))
    expect(list).toContain('<a class="jr-tab is-on" href="/journal" aria-current="page">Sessions</a>')
    expect(list).toContain('<a class="jr-tab" href="/journal?view=records">Records</a>')

    const session = await bodyOf(await handlerAt('2026-08-27')(ctx('session=S1')))
    expect(session).toContain('<a class="jr-tab is-on" href="/journal?view=records" aria-current="page">Records</a>')
  })

  test('the tabs carry the applied filters across, and drop the session and the page', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('session=S1&page=3&outcome=deny&from=2026-08-01&to=2026-08-02')))
    // Records keeps everything; Sessions keeps only what a session list can
    // honour — carrying `outcome=` there would be a narrowing the page neither
    // shows nor applies.
    expect(body).toContain('href="/journal?view=records&amp;outcome=deny&amp;from=2026-08-01&amp;to=2026-08-02"')
    expect(body).toContain('href="/journal?from=2026-08-01&amp;to=2026-08-02"')
  })

  test('the Sessions tab names its own view when text is set, so a bare q does not land on the search panel', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('view=records&q=exec&tool=exec')))
    expect(body).toContain('href="/journal?view=sessions&amp;q=exec"')
  })

  test('the Records tab is the cross-session stream and needs no text to exist', async () => {
    const read = fakePort({
      searchAllSessions: vi.fn(async () =>
        emptyCross({ hits: [{ sessionId: 'S9', record: record() }], filesTotal: 1, filesScanned: 1 }),
      ),
    })
    const body = await bodyOf(await handlerAt('2026-08-27', read)(ctx('view=records&outcome=deny')))
    expect(read.searchAllSessions).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'deny' }))
    expect(body).toContain('<h1 class="vh">Journal records</h1>')
    expect(body).toContain('aria-label="Journal records"')
    expect(body).toContain('all sessions · 1 shown')
    // Cross-session lists lead with the session link, so the wider grid applies.
    expect(body).toContain('<section class="panel jr-panel jr-with-session"')
    expect(body).toMatch(/<span class="meta num" data-live-text="nav-meta">1 record<\/span>/)
    // The honest scan accounting travels with the tab, not only with a search.
    expect(body).toContain('<p class="notice complete">Scanned all 1 session file(s).</p>')
  })

  test('the Records tab keeps its own view when the in-panel filters are submitted', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('view=records')))
    expect(body).toContain('<input type="hidden" name="view" value="records">')
  })
})

describe('the agent dropdown and the session-list bar', () => {
  test('the agent field enumerates the registry and marks the current selection', async () => {
    const handler = createJournalHandler({
      read: fakePort(),
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      listAgentNames: async () => ['bot-1', 'bot-2'],
    })
    const body = await bodyOf(await handler(ctx('session=S1&agent=bot-2')))
    expect(body).toContain('<span class="jr-select is-set">')
    expect(body).toContain('<option value="bot-1">bot-1</option>')
    expect(body).toContain('<option value="bot-2" selected>bot-2</option>')
    expect(body).toContain('<option value="">agent · any</option>')
  })

  test('an agent that is filtered for but no longer registered is still offered, so the URL never widens', async () => {
    const handler = createJournalHandler({
      read: fakePort(),
      listAgentNames: async () => ['bot-1'],
    })
    const body = await bodyOf(await handler(ctx('session=S1&agent=retired')))
    expect(body).toContain('<option value="retired" selected>retired</option>')
  })

  test('a registry that cannot be read leaves the dropdown empty rather than failing the page', async () => {
    const handler = createJournalHandler({
      read: fakePort(),
      listAgentNames: async () => {
        throw new Error('store unavailable')
      },
    })
    const result = await handler(ctx('session=S1'))
    expect(result.kind === 'response' && result.status).toBe(200)
    expect(await bodyOf(result)).toContain('<option value="" selected>agent · any</option>')
  })

  test('the agent filter reaches the read layer as agentName', async () => {
    const read = fakePort()
    await handlerAt('2026-08-27', read)(ctx('session=S1&agent=bot-1'))
    expect(read.searchSession).toHaveBeenCalledWith('S1', expect.objectContaining({ agentName: 'bot-1' }))
  })

  test('the session-list bar is the reduced one: text and period only, no record-level fields', async () => {
    const body = await bodyOf(await handlerAt('2026-08-27')(ctx('')))
    expect(body).toMatch(/<input type="search" name="q" value="" placeholder="session id or text"/)
    expect(body).toContain('<input type="hidden" name="view" value="sessions">')
    expect(body).toContain('<summary class="jr-period-btn">')
    expect(body).not.toContain('name="kind"')
    expect(body).not.toContain('name="agent"')
  })
})

describe('the session list narrows by what a summary row knows', () => {
  const sessions = [
    summary('alpha', { firstTs: '2026-08-01T00:00:00.000Z', lastTs: '2026-08-02T00:00:00.000Z' }),
    summary('beta', { firstTs: '2026-08-10T00:00:00.000Z', lastTs: '2026-08-20T00:00:00.000Z' }),
  ]

  test('text matches the session id, case-insensitively', async () => {
    const read = fakePort({ listSessions: vi.fn(async () => sessions) })
    const body = await bodyOf(await handlerAt('2026-08-27', read)(ctx('view=sessions&q=ALP')))
    expect(body).toContain('alpha')
    expect(body).not.toMatch(/jr-session-id">beta</)
    expect(body).toContain('1 sessions')
  })

  test('a period keeps every session whose activity overlaps it', async () => {
    const read = fakePort({ listSessions: vi.fn(async () => sessions) })
    const handler = handlerAt('2026-08-27', read)

    const inside = await bodyOf(await handler(ctx('from=2026-08-15&to=2026-08-16')))
    expect(inside).toMatch(/jr-session-id">beta</)
    expect(inside).not.toMatch(/jr-session-id">alpha</)

    const none = await bodyOf(await handler(ctx('from=2026-08-25&to=2026-08-26')))
    expect(none).toContain('No sessions match the current filters.')
  })

  test('an empty journal says so, and a narrowed empty list says something else', async () => {
    const read = fakePort({ listSessions: vi.fn(async () => []) })
    const body = await bodyOf(await handlerAt('2026-08-27', read)(ctx('')))
    expect(body).toContain('No sessions in the journal yet.')
  })

  test('the pager keeps the filters instead of silently widening the page', async () => {
    const many = Array.from({ length: 60 }, (_, i) => summary(`sess-${String(i).padStart(3, '0')}`))
    const read = fakePort({ listSessions: vi.fn(async () => many) })
    const body = await bodyOf(await handlerAt('2026-08-27', read)(ctx('view=sessions&q=sess&from=2026-08-01')))
    expect(body).toContain(
      '<a class="next" href="/journal?view=sessions&amp;q=sess&amp;from=2026-08-01&amp;page=2">Next</a>',
    )
  })
})

describe('the session view keeps its own filters', () => {
  test('a filtered session page pages within its filters', async () => {
    const read = fakePort({
      searchSession: vi.fn(async () => emptyPage({ records: [record()], hasMore: true })),
    })
    const body = await bodyOf(await handlerAt('2026-08-27', read)(ctx('session=S1&outcome=deny&page=2')))
    expect(body).toContain('<a class="prev" href="/journal?session=S1&amp;outcome=deny&amp;page=1">Prev</a>')
    expect(body).toContain('<a class="next" href="/journal?session=S1&amp;outcome=deny&amp;page=3">Next</a>')
  })
})
