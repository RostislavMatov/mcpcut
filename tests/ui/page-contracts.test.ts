import { describe, expect, test } from 'vitest'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { matchRoute } from '../../src/ui/authz.js'
import { renderAdminsPage } from '../../src/ui/pages/admins.js'
import { renderAgentsPage } from '../../src/ui/pages/agents.js'
import { renderApprovalsPage, type ApprovalCardView } from '../../src/ui/pages/approvals.js'
import { renderLoginPage } from '../../src/ui/pages/login.js'
import { renderQuarantinePage, type QuarantineCardView } from '../../src/ui/pages/quarantine.js'
import { renderRemoveWarning, renderServersPage, renderVaultPage } from '../../src/ui/pages/servers.js'
import type { UiSession } from '../../src/ui/auth.js'

/**
 * Contract tests between the server-rendered pages and the client script
 * (`assets/app-js.ts`). The two halves of the UI are written in different
 * languages in different files and nothing in the type system connects them, so
 * a page can silently emit an attribute the script never reads (or a value the
 * script mis-uses) and every unit test still passes while the button is dead.
 *
 * These tests close that gap structurally, without a DOM: they extract the
 * attributes the pages actually render and check them against (a) the normative
 * `ROUTE_TABLE` and (b) the selectors and topic list literally present in the
 * `APP_JS` source. A regression in either half fails here.
 *
 * Findings this pins (M4 wave 2–4 review):
 *  - HIGH-1: `data-action` is the URL the script fetches, not a bare verb.
 *  - M-3: live regions are `data-live-region` (+ `data-live-src`,
 *    `data-pending-count`), not the never-consumed `data-live`.
 */

const JS_SOURCE = APP_JS.body.toString('utf8')

const SESSION: UiSession = { adminName: 'alice', role: 'owner', csrfToken: 'csrf-token-value' }

const APPROVAL_CARD: ApprovalCardView = {
  approvalId: '01J0000000000000000000000A',
  agentName: 'research-bot',
  serverName: 'github',
  toolName: 'create_issue',
  toolClass: 'write',
  argsRedacted: { title: 'hello' },
  waitRemainingSec: 42,
  grantRemainingSec: 300,
  expired: false,
}

const QUARANTINE_CARD: QuarantineCardView = {
  serverName: 'github',
  toolName: 'create_issue',
  state: 'changed',
  firstSeenAt: '2026-08-11T12:00:00.000Z',
  surfaceDelta: 'widened',
  changes: [{ kind: 'property-added', path: 'properties.force' }],
  truncated: false,
}

/** Every page document the UI can serve, rendered with a representative view. */
function allPages(): ReadonlyArray<{ readonly name: string; readonly html: string }> {
  return [
    {
      name: 'approvals',
      html: renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken }),
    },
    { name: 'approvals-empty', html: renderApprovalsPage({ cards: [], csrfToken: SESSION.csrfToken }) },
    {
      name: 'quarantine',
      html: renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken }),
    },
    {
      name: 'quarantine-empty',
      html: renderQuarantinePage({ cards: [], csrfToken: SESSION.csrfToken }),
    },
    {
      name: 'servers',
      html: renderServersPage({
        servers: [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
        canManage: true,
        csrfToken: SESSION.csrfToken,
        currentAdmin: { name: SESSION.adminName, role: SESSION.role },
      }),
    },
    {
      name: 'servers-remove-warning',
      html: renderRemoveWarning({
        serverName: 'github',
        agents: ['research-bot'],
        csrfToken: SESSION.csrfToken,
        currentAdmin: { name: SESSION.adminName, role: SESSION.role },
      }),
    },
    {
      name: 'vault',
      html: renderVaultPage({
        csrfToken: SESSION.csrfToken,
        currentAdmin: { name: SESSION.adminName, role: SESSION.role },
        secrets: [],
      }),
    },
    { name: 'agents', html: renderAgentsPage({ agents: [], session: SESSION }) },
    { name: 'admins', html: renderAdminsPage({ admins: [], session: SESSION }) },
    { name: 'login', html: renderLoginPage() },
  ]
}

/** All values of one attribute across a document, in source order. */
function attributeValues(documentHtml: string, attribute: string): string[] {
  const pattern = new RegExp(`${attribute}="([^"]*)"`, 'g')
  const out: string[] = []
  for (const match of documentHtml.matchAll(pattern)) out.push(match[1] ?? '')
  return out
}

describe('data-action values are real POST routes (HIGH-1)', () => {
  test('every rendered data-action matches a POST entry in ROUTE_TABLE', () => {
    for (const page of allPages()) {
      for (const value of attributeValues(page.html, 'data-action')) {
        expect(matchRoute('POST', value), `${page.name}: data-action="${value}"`).not.toBeNull()
      }
    }
  })

  test('the approvals card wires approve and deny to their own id-scoped routes', () => {
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken })
    const actions = attributeValues(document, 'data-action')
    expect(actions).toEqual([
      `/approvals/${APPROVAL_CARD.approvalId}/approve`,
      `/approvals/${APPROVAL_CARD.approvalId}/deny`,
    ])
  })

  test('the quarantine card wires approve and reject to the quarantine routes', () => {
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken })
    expect(attributeValues(document, 'data-action')).toEqual([
      '/quarantine/approve',
      '/quarantine/reject',
    ])
  })

  test('the no-JS form action stays byte-identical to the scripted data-action', () => {
    for (const page of allPages()) {
      const pattern = /<form[^>]*>/g
      for (const tag of page.html.match(pattern) ?? []) {
        const dataAction = /data-action="([^"]*)"/.exec(tag)
        if (dataAction === null) continue
        const action = /\saction="([^"]*)"/.exec(tag)
        expect(action?.[1], `${page.name}: ${tag}`).toBe(dataAction[1])
      }
    }
  })

  test('every POST form action is a real POST route', () => {
    for (const page of allPages()) {
      for (const tag of page.html.match(/<form[^>]*>/g) ?? []) {
        if (!/method="post"/i.test(tag)) continue
        const action = /\saction="([^"]*)"/.exec(tag)?.[1]
        expect(action, `${page.name}: ${tag}`).toBeDefined()
        expect(matchRoute('POST', action ?? ''), `${page.name}: action="${action}"`).not.toBeNull()
      }
    }
  })
})

describe('live-region attributes match what APP_JS consumes (M-3)', () => {
  test('no page emits the never-consumed data-live attribute', () => {
    expect(JS_SOURCE).not.toContain('data-live"')
    for (const page of allPages()) {
      expect(/\sdata-live="/.test(page.html), `${page.name} emits stale data-live`).toBe(false)
    }
  })

  test('the approvals page exposes a live region, its source and a pending count', () => {
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken })
    const regions = attributeValues(document, 'data-live-region')
    expect(regions).toHaveLength(1)
    expect(attributeValues(document, 'data-live-src')).toEqual(['/'])
    expect(attributeValues(document, 'data-pending-count')).toEqual(['1'])
  })

  test('the pending count tracks the number of cards', () => {
    const empty = renderApprovalsPage({ cards: [], csrfToken: SESSION.csrfToken })
    expect(attributeValues(empty, 'data-pending-count')).toEqual(['0'])
  })

  test('the quarantine page exposes a live region and its own source', () => {
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken })
    expect(attributeValues(document, 'data-live-region')).toHaveLength(1)
    expect(attributeValues(document, 'data-live-src')).toEqual(['/quarantine'])
  })

  test('every live-region topic is one the client script subscribes to', () => {
    // The topic list the script fans SSE events out on, read from its source.
    const declared = /LIVE_TOPICS = \[([^\]]*)\]/.exec(JS_SOURCE)?.[1] ?? ''
    const topics = declared.split(',').map((entry) => entry.trim().replace(/^"|"$/g, ''))
    expect(topics.length).toBeGreaterThan(0)
    for (const page of allPages()) {
      for (const value of attributeValues(page.html, 'data-live-region')) {
        for (const topic of value.split(/\s+/).filter((entry) => entry !== '')) {
          expect(topics, `${page.name}: topic "${topic}"`).toContain(topic)
        }
      }
    }
  })

  test('a live region can be found again in its own refetched document', () => {
    // `swapRegion` looks the region up by an EXACT attribute-value match in the
    // response fetched from `data-live-src`; both sides are this same render.
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken })
    const region = attributeValues(document, 'data-live-region')[0] ?? ''
    expect(document).toContain(`data-live-region="${region}"`)
    expect(region).not.toContain('"')
  })

  test('an authenticated layout names the SSE endpoint the script consumes', () => {
    const document = renderApprovalsPage({
      cards: [],
      csrfToken: SESSION.csrfToken,
      currentAdmin: { name: SESSION.adminName, role: SESSION.role },
    })
    const url = attributeValues(document, 'data-events-url')[0]
    expect(url).toBeDefined()
    expect(matchRoute('GET', url ?? '')).not.toBeNull()
  })

  test('a page with no signed-in admin names no SSE endpoint at all', () => {
    // The login page is the only such page. It used to carry the attribute and
    // therefore made every visitor's browser open a stream that `/events` could
    // only refuse — a 403 in the console of every unauthenticated visitor.
    const document = renderApprovalsPage({ cards: [], csrfToken: SESSION.csrfToken })

    expect(attributeValues(document, 'data-events-url')).toHaveLength(0)
  })
})

/**
 * The tab badge must not contradict the page. Reads of the approvals queue are
 * bounded (`APPROVALS_LIST_MAX_ROWS`), and the page body says so explicitly
 * ("500 of 520 pending (showing the oldest)"). A badge built from the bounded
 * card count would repeat the very number that line exists to correct, and an
 * operator glancing at the tab instead of the page would read the backlog as
 * drained down to the bound.
 *
 * These tests run the REAL `syncPendingBadge` out of the shipped `APP_JS`
 * source (there is no DOM in this suite, so the function is lifted from the
 * script and fed a stub built from the REAL rendered page) — a copy of the
 * logic here would pass while the shipped script regressed.
 */
describe('the pending badge reports the queue, not the page (smoke LOW-3)', () => {
  /** The shipped `syncPendingBadge`, bound to a stub `document`. */
  function loadSyncPendingBadge(documentStub: { title: string }): (scope: unknown) => void {
    const source = /\n {2}function syncPendingBadge\(scope\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'syncPendingBadge not found in APP_JS').toBeDefined()
    return new Function('document', `${source ?? ''}\nreturn syncPendingBadge;`)(documentStub) as (
      scope: unknown,
    ) => void
  }

  /** A `querySelector`-alike over the one tag that carries `data-pending-count`. */
  function scopeOf(documentHtml: string): unknown {
    const tag = /<[a-z]+[^>]*\sdata-pending-count="[^"]*"[^>]*>/i.exec(documentHtml)?.[0]
    if (tag === undefined) return { querySelector: () => null }
    const attributes = new Map<string, string>()
    for (const match of tag.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes.set(match[1] ?? '', match[2] ?? '')
    }
    const node = { getAttribute: (name: string) => attributes.get(name) ?? null }
    return { querySelector: () => node }
  }

  /** Title the shipped script would set for a page rendered from `input`. */
  function badgedTitle(input: Parameters<typeof renderApprovalsPage>[0]): string {
    const documentStub = { title: 'Approvals · mcp-journal' }
    loadSyncPendingBadge(documentStub)(scopeOf(renderApprovalsPage(input)))
    return documentStub.title
  }

  const CARDS = (count: number): ApprovalCardView[] =>
    Array.from({ length: count }, (_unused, index) => ({
      ...APPROVAL_CARD,
      approvalId: `01J000000000000000000000${String(index).padStart(2, '0')}`,
    }))

  test('a truncated read badges the true total, never the bound it was cut to', () => {
    const title = badgedTitle({ cards: CARDS(2), csrfToken: SESSION.csrfToken, totalPending: 520 })

    expect(title).toBe('(520) Approvals · mcp-journal')
  })

  test('an untruncated read badges the plain pending count', () => {
    expect(badgedTitle({ cards: CARDS(3), csrfToken: SESSION.csrfToken })).toBe(
      '(3) Approvals · mcp-journal',
    )
    // A total that merely equals what is shown is not a truncation.
    expect(badgedTitle({ cards: CARDS(3), csrfToken: SESSION.csrfToken, totalPending: 3 })).toBe(
      '(3) Approvals · mcp-journal',
    )
  })

  test('an empty queue leaves the title unbadged', () => {
    expect(badgedTitle({ cards: [], csrfToken: SESSION.csrfToken })).toBe('Approvals · mcp-journal')
    expect(badgedTitle({ cards: [], csrfToken: SESSION.csrfToken, totalPending: 0 })).toBe(
      'Approvals · mcp-journal',
    )
  })

  test('the badge is replaced, not stacked, when a refresh re-runs it', () => {
    // `swapRegion` calls the badge sync on every SSE refresh; the leading
    // "(n) " it strips must still match the badge it writes.
    const documentStub = { title: 'Approvals · mcp-journal' }
    const sync = loadSyncPendingBadge(documentStub)
    const truncated = scopeOf(
      renderApprovalsPage({ cards: CARDS(2), csrfToken: SESSION.csrfToken, totalPending: 520 }),
    )
    sync(truncated)
    sync(truncated)
    expect(documentStub.title).toBe('(520) Approvals · mcp-journal')

    sync(scopeOf(renderApprovalsPage({ cards: CARDS(1), csrfToken: SESSION.csrfToken })))
    expect(documentStub.title).toBe('(1) Approvals · mcp-journal')
  })

  test('the truncated total rides on the same node the script already reads', () => {
    // `swapRegion` re-runs the sync against the REFETCHED document, finding the
    // node by `[data-pending-count]`. Carrying the total anywhere else (a
    // header, the layout) would leave the SSE path badging the bounded number.
    const document = renderApprovalsPage({
      cards: CARDS(2),
      csrfToken: SESSION.csrfToken,
      totalPending: 520,
    })
    const tag = /<[a-z]+[^>]*\sdata-pending-count="[^"]*"[^>]*>/i.exec(document)?.[0] ?? ''

    expect(tag).toContain('data-pending-total="520"')
    expect(document).toContain('data-live-region=') // the node is inside the live region
  })
})
