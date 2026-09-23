import { describe, expect, test } from 'vitest'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { matchRoute } from '../../src/ui/authz.js'
import { renderAdminsPage } from '../../src/ui/pages/admins.js'
import { renderAgentsPage } from '../../src/ui/pages/agents.js'
import {
  renderGroupRemoveConfirm,
  renderGroupRemoveRefusal,
  renderGroupsPage,
} from '../../src/ui/pages/groups.js'
import { renderApprovalsPage, type ApprovalCardView } from '../../src/ui/pages/approvals.js'
import { renderLoginPage } from '../../src/ui/pages/login.js'
import { renderQuarantinePage, type QuarantineCardView } from '../../src/ui/pages/quarantine.js'
import {
  renderServersPage,
  renderVaultPage,
  toServerToolsByName,
  type ServersView,
} from '../../src/ui/pages/servers.js'
import { renderPruneDangling, renderRemoveWarning } from '../../src/ui/pages/servers-holders.js'
import { serverToolsRegionKey } from '../../src/ui/pages/servers-tool-rule.js'
import type { AgentRecord } from '../../src/agents/schema.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import type { UiSession } from '../../src/ui/auth.js'
import type { PolicyView } from '../../src/policy/edit/policy-view.js'
import { parsePolicy } from '../../src/policy/schema.js'
import { policyHashOf } from '../../src/policy/provenance.js'

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

/**
 * The quarantine page renders its approve/reject forms only for a session that
 * may use them (UX-5), so every contract below that inspects those forms has to
 * render the page as such a session — the same reason the agents page's drawer
 * contracts pass an owner.
 */
const QUARANTINE_ADMIN = { name: SESSION.adminName, role: SESSION.role }

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

const POLICY_DOCUMENT = { version: 1, servers: { github: { tools: { create_issue: 'deny' } } } }
const POLICY = (() => {
  const parsed = parsePolicy(POLICY_DOCUMENT)
  if (!parsed.ok) throw new Error('bad policy fixture')
  return parsed.policy
})()
const POLICY_VIEW: PolicyView = {
  status: 'loaded',
  policy: POLICY,
  hash: policyHashOf(POLICY),
  sourcePath: '/state/policy.json',
  readers: { kind: 'every-entry-point' },
}

/** One group with a grant and a member — enough to render every card region. */
const GROUP: GroupRecord = {
  name: 'analytics',
  createdAt: '2026-08-31T00:00:00.000Z',
  grants: { notes: { tools: ['read_note'] } },
  members: ['research-bot'],
}

const GROUP_MEMBER: AgentRecord = {
  name: 'research-bot',
  createdAt: '2026-08-31T00:00:00.000Z',
  tokenHash: 'a'.repeat(64),
  grants: {},
}

/** The servers page with an inventory and a loaded policy: tools panels, rule pills and controls. */
function serversWithRules(): ServersView {
  const inventory = {
    version: 1 as const,
    servers: {
      github: {
        approved: { create_issue: { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' } },
        quarantined: {},
      },
    },
  }
  return {
    servers: [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
    canManage: true,
    csrfToken: SESSION.csrfToken,
    currentAdmin: { name: SESSION.adminName, role: SESSION.role },
    tools: toServerToolsByName(inventory, POLICY),
    policyView: POLICY_VIEW,
  }
}

/**
 * A live region that names no SSE topic and carries `data-live-settle` is
 * settle-only: nothing publishes to it, an action inside it re-fetches it.
 * The per-server tools panel (`server-tools:<name>`) is the one such region.
 */
function isSettleOnlyRegion(key: string): boolean {
  return key === serverToolsRegionKey(key.slice('server-tools:'.length)) && key.startsWith('server-tools:')
}

/** Every page document the UI can serve, rendered with a representative view. */
function allPages(): ReadonlyArray<{ readonly name: string; readonly html: string }> {
  return [
    { name: 'servers-rules', html: renderServersPage(serversWithRules()) },
    {
      name: 'approvals',
      html: renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN }),
    },
    { name: 'approvals-empty', html: renderApprovalsPage({ cards: [], csrfToken: SESSION.csrfToken }) },
    {
      name: 'quarantine',
      html: renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN }),
    },
    {
      name: 'quarantine-empty',
      html: renderQuarantinePage({ cards: [], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN }),
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
      name: 'servers-prune-dangling',
      html: renderPruneDangling({
        serverName: 'github',
        agents: ['research-bot'],
        groups: ['analytics'],
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
    { name: 'agents', html: renderAgentsPage({ agents: [], session: SESSION, serveAddress: { url: 'https://plane.example', source: 'config' } }) },
    {
      name: 'groups',
      html: renderGroupsPage({
        groups: [GROUP],
        agents: [GROUP_MEMBER],
        servers: [{ name: 'notes', transport: 'stdio', command: 'notes-mcp' }],
        session: SESSION,
        canManage: true,
        drawer: 'create-group',
      }),
    },
    {
      name: 'groups-empty',
      html: renderGroupsPage({
        groups: [],
        agents: [],
        servers: [],
        session: SESSION,
        canManage: false,
      }),
    },
    {
      name: 'groups-remove-confirm',
      html: renderGroupRemoveConfirm({ group: GROUP, session: SESSION }),
    },
    {
      name: 'groups-remove-refusal',
      html: renderGroupRemoveRefusal({ group: GROUP, session: SESSION }),
    },
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
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
    const actions = attributeValues(document, 'data-action')
    expect(actions).toEqual([
      `/approvals/${APPROVAL_CARD.approvalId}/approve`,
      `/approvals/${APPROVAL_CARD.approvalId}/deny`,
    ])
  })

  test('the quarantine card wires approve and reject to the quarantine routes', () => {
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
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
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
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
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
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
        if (isSettleOnlyRegion(value)) {
          expect(page.html, `${page.name}: settle-only region "${value}" must opt in`).toMatch(
            new RegExp(`data-live-region="${value}"[^>]*data-live-settle`),
          )
          continue
        }
        for (const topic of value.split(/\s+/).filter((entry) => entry !== '')) {
          expect(topics, `${page.name}: topic "${topic}"`).toContain(topic)
        }
      }
    }
  })

  test('the servers tools modal is a settle-only region keyed per server, re-fetched from /servers', () => {
    const document = renderServersPage(serversWithRules())
    const regions = attributeValues(document, 'data-live-region')
    expect(regions).toEqual(['server-tools:github'])
    expect(document).toMatch(/<div class="rows srv-tool-rows" data-live-region="server-tools:github" data-live-src="\/servers" data-live-settle>/)
    // `swapRegion` finds the region again in the refetched document by its
    // exact key, through the script's own cssEscape — a colon needs none.
    expect(JS_SOURCE).toContain(`'[data-live-region="' + cssEscape(key) + '"]'`)
    expect(regions[0]).not.toMatch(/["\\]/)
    // The region is inside the modal <details>, so a swap never closes it.
    expect(document).toMatch(/<details class="drawer srv-tools-modal" id="tools-github">[\s\S]*?data-live-region="server-tools:github"[\s\S]*?<\/details>/)
  })

  test('every rule form carries the same encoded path in action and data-action, plus the CAS token', () => {
    const document = renderServersPage(serversWithRules())
    const forms = document.match(/<form[^>]*srv-rule-form[^>]*>[\s\S]*?<\/form>/g) ?? []
    expect(forms.length).toBe(4) // allow · approval · deny · reset (an exact rule exists)
    for (const form of forms) {
      const action = /action="([^"]*)"/.exec(form)?.[1]
      const dataAction = /data-action="([^"]*)"/.exec(form)?.[1]
      expect(action).toBe('/servers/github/tools/create_issue/rule')
      expect(dataAction).toBe(action)
      expect(matchRoute('POST', action ?? '')).not.toBeNull()
      expect(form).toContain('name="csrf_token"')
      expect(form).toContain(`name="expected_hash" value="${POLICY_VIEW.hash}"`)
    }
  })

  test('a live region can be found again in its own refetched document', () => {
    // `swapRegion` looks the region up by an EXACT attribute-value match in the
    // response fetched from `data-live-src`; both sides are this same render.
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
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
    const documentStub = { title: 'Approvals · mcpcut' }
    loadSyncPendingBadge(documentStub)(scopeOf(renderApprovalsPage(input)))
    return documentStub.title
  }

  const CARDS = (count: number): ApprovalCardView[] =>
    Array.from({ length: count }, (_unused, index) => ({
      ...APPROVAL_CARD,
      approvalId: `01J000000000000000000000${String(index).padStart(2, '0')}`,
    }))

  test('a truncated read badges the true total, never the bound it was cut to', () => {
    const title = badgedTitle({
      cards: CARDS(2),
      csrfToken: SESSION.csrfToken,
      totalPending: 520,
      truncated: true,
    })

    expect(title).toBe('(520) Approvals · mcpcut')
  })

  test('an untruncated read badges the plain pending count', () => {
    expect(badgedTitle({ cards: CARDS(3), csrfToken: SESSION.csrfToken })).toBe(
      '(3) Approvals · mcpcut',
    )
    // A total that merely equals what is shown is not a truncation.
    expect(badgedTitle({ cards: CARDS(3), csrfToken: SESSION.csrfToken, totalPending: 3 })).toBe(
      '(3) Approvals · mcpcut',
    )
  })

  test('a totalPending above cards.length with no explicit truncated flag is not truncation', () => {
    // This is the page renderer's half of the two-read-race fix: `totalPending`
    // exceeding `cards.length` is NOT sufficient on its own — `cards` and
    // `totalPending` can come from two separate queue reads with a commit
    // racing between them, or `cards` can be shorter than the raw row count for
    // reasons (malformed rows dropped) that have nothing to do with truncation.
    // Only the caller (`ui/handlers/approvals.ts`), which sees the raw `list()`
    // result before any of that, can tell — so this pure renderer trusts the
    // explicit `truncated` flag, never re-derives it from the two numbers.
    expect(
      badgedTitle({ cards: CARDS(2), csrfToken: SESSION.csrfToken, totalPending: 520 }),
    ).toBe('(2) Approvals · mcpcut')
  })

  test('an empty queue leaves the title unbadged', () => {
    expect(badgedTitle({ cards: [], csrfToken: SESSION.csrfToken })).toBe('Approvals · mcpcut')
    expect(badgedTitle({ cards: [], csrfToken: SESSION.csrfToken, totalPending: 0 })).toBe(
      'Approvals · mcpcut',
    )
  })

  test('the badge is replaced, not stacked, when a refresh re-runs it', () => {
    // `swapRegion` calls the badge sync on every SSE refresh; the leading
    // "(n) " it strips must still match the badge it writes.
    const documentStub = { title: 'Approvals · mcpcut' }
    const sync = loadSyncPendingBadge(documentStub)
    const truncated = scopeOf(
      renderApprovalsPage({
        cards: CARDS(2),
        csrfToken: SESSION.csrfToken,
        totalPending: 520,
        truncated: true,
      }),
    )
    sync(truncated)
    sync(truncated)
    expect(documentStub.title).toBe('(520) Approvals · mcpcut')

    sync(scopeOf(renderApprovalsPage({ cards: CARDS(1), csrfToken: SESSION.csrfToken })))
    expect(documentStub.title).toBe('(1) Approvals · mcpcut')
  })

  test('the truncated total rides on the same node the script already reads', () => {
    // `swapRegion` re-runs the sync against the REFETCHED document, finding the
    // node by `[data-pending-count]`. Carrying the total anywhere else (a
    // header, the layout) would leave the SSE path badging the bounded number.
    const document = renderApprovalsPage({
      cards: CARDS(2),
      csrfToken: SESSION.csrfToken,
      totalPending: 520,
      truncated: true,
    })
    const tag = /<[a-z]+[^>]*\sdata-pending-count="[^"]*"[^>]*>/i.exec(document)?.[0] ?? ''

    expect(tag).toContain('data-pending-total="520"')
    expect(document).toContain('data-live-region=') // the node is inside the live region
  })
})

/**
 * A scripted <form data-action> is submitted by `runAction` over fetch, not by
 * the browser — so its hidden fields reach the server only if the script
 * serialises them itself. The approval forms carry their identity in the URL
 * and were never affected; the quarantine forms carry `server`/`tool` as
 * hidden inputs and posted an EMPTY body (→ 400, "Action failed") from the
 * day they shipped. Like the badge tests above, these run the REAL
 * `formPayload` lifted out of `APP_JS` against a stub built from the REAL
 * rendered form.
 */
describe('scripted forms post their hidden fields (quarantine approve/reject)', () => {
  /** The shipped `formPayload`, lifted from the script source. */
  function loadFormPayload(): (form: unknown) => string | null {
    const source = /\n {2}function formPayload\(el\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'formPayload not found in APP_JS').toBeDefined()
    return new Function(`${source ?? ''}\nreturn formPayload;`)() as (form: unknown) => string | null
  }

  /** A `form.elements`-alike for the first `<form data-action="…">` in a document. */
  function formStubOf(documentHtml: string, action: string): unknown {
    const block = new RegExp(`<form[^>]*data-action="${action}"[^>]*>[\\s\\S]*?</form>`).exec(documentHtml)?.[0]
    expect(block, `no form for ${action}`).toBeDefined()
    const elements: Array<{ name: string; value: string }> = []
    for (const input of (block ?? '').matchAll(/<input[^>]*>/g)) {
      const name = /\sname="([^"]*)"/.exec(input[0])?.[1] ?? ''
      const value = /\svalue="([^"]*)"/.exec(input[0])?.[1] ?? ''
      elements.push({ name, value })
    }
    return { elements, getAttribute: () => null }
  }

  test('the quarantine approve form serialises server and tool into the JSON body', () => {
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
    const payload = loadFormPayload()(formStubOf(document, '/quarantine/approve'))
    expect(payload).not.toBeNull()
    expect(JSON.parse(payload ?? '{}')).toEqual({ server: 'github', tool: 'create_issue' })
  })

  test('the csrf field stays out of the body — it rides in the header', () => {
    const document = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
    const payload = loadFormPayload()(formStubOf(document, '/quarantine/reject'))
    expect(payload).not.toContain(SESSION.csrfToken)
  })

  test('an approval form (identity in the URL) keeps posting no body', () => {
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })
    const payload = loadFormPayload()(formStubOf(document, `/approvals/${APPROVAL_CARD.approvalId}/approve`))
    expect(payload).toBeNull()
  })

  test('runAction falls back to the form fields when no data-payload is set', () => {
    expect(JS_SOURCE).toMatch(/if \(payload === null\) payload = formPayload\(el\);/)
  })
})

/**
 * A scripted action used to `location.reload()` after every 2xx, so each
 * quarantine approve/reject flashed the whole page even though the list is a
 * live region the script already knows how to re-fetch. Now a 2xx re-fetches
 * the enclosing live region IF that region opts in with `data-live-settle`
 * (the page is fully live: everything the action changes is inside the region
 * or marked `data-live-text`) and falls back to a reload otherwise — the
 * dashboard keeps reloading, because its tiles, decisions and servers strip
 * all sit outside its queue region. Like the badge tests, these run the REAL
 * functions lifted out of `APP_JS`.
 */
describe('scripted actions settle by refreshing an opted-in live region', () => {
  type Settle = (el: unknown) => Promise<void> | void

  interface SettleHarness {
    settle: Settle
    readonly refreshed: unknown[]
    readonly busy: Array<[unknown, boolean]>
    reloads: number
  }

  /** The shipped `settleAction`, with `refreshRegion`, `setBusy` and `window` stubbed. */
  function loadSettleAction(): SettleHarness {
    const source = /\n {2}function settleAction\(el\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'settleAction not found in APP_JS').toBeDefined()
    const harness: SettleHarness = { settle: () => undefined, refreshed: [], busy: [], reloads: 0 }
    harness.settle = new Function(
      'refreshRegion',
      'setBusy',
      'window',
      `${source ?? ''}\nreturn settleAction;`,
    )(
      (r: unknown) => { harness.refreshed.push(r); return Promise.resolve() },
      (el: unknown, on: boolean) => { harness.busy.push([el, on]) },
      { location: { reload: () => { harness.reloads += 1 } } },
    ) as Settle
    return harness
  }

  /** An element whose `closest` answers only a selector that demands the opt-in. */
  function elementStub(region: unknown, attrs: readonly string[] = []): unknown {
    return {
      closest: (selector: string) => (selector.includes('[data-live-settle]') ? region : null),
      hasAttribute: (name: string) => attrs.includes(name),
    }
  }

  test('a 2xx inside an opted-in live region re-fetches it and does not reload', async () => {
    const h = loadSettleAction()
    const region = { id: 'quarantine-region' }
    const el = elementStub(region)
    await h.settle(el)
    expect(h.refreshed).toEqual([region])
    expect(h.reloads).toBe(0)
    // the control is released once the refresh settled (a failed re-fetch
    // must not leave it stuck; a successful one replaced it anyway)
    expect(h.busy).toEqual([[el, false]])
  })

  test('a 2xx outside an opted-in region still reloads the page', () => {
    const h = loadSettleAction()
    h.settle(elementStub(null))
    expect(h.refreshed).toEqual([])
    expect(h.reloads).toBe(1)
  })

  test('data-no-reload suppresses both the refresh and the reload', () => {
    const h = loadSettleAction()
    h.settle(elementStub({ id: 'r' }, ['data-no-reload']))
    expect(h.refreshed).toEqual([])
    expect(h.reloads).toBe(0)
  })

  test('a refusal toast carries the server\'s message when the JSON body has one', async () => {
    const source = /\n {2}function failureMessage\(res\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'failureMessage not found in APP_JS').toBeDefined()
    const failureMessage = new Function(`${source ?? ''}\nreturn failureMessage;`)() as (res: unknown) => Promise<string>
    await expect(failureMessage({ json: () => Promise.resolve({ message: 'policy changed on disk' }) })).resolves.toBe('policy changed on disk')
    await expect(failureMessage({ json: () => Promise.reject(new Error('not json')) })).resolves.toBe('')
    await expect(failureMessage({ json: () => Promise.resolve({ message: 42 }) })).resolves.toBe('')
    expect(JS_SOURCE).toMatch(/announce\(refusalText\(res, message\)\)/)
  })

  /**
   * A bare "Action failed (403)" tells the operator nothing they can act on.
   * A dead session is a 401 of its own now (the script leaves for `/login`),
   * so a 403 that reaches the toast is an insufficient role or a page whose
   * CSRF token went stale — and the next move differs: ask an owner, or
   * reload. The toast names both instead of the number.
   */
  test('a 403 toast explains itself; other statuses keep the code', () => {
    const source = /\n {2}function refusalText\(res, message\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'refusalText not found in APP_JS').toBeDefined()
    const refusalText = new Function(`${source ?? ''}\nreturn refusalText;`)() as (
      res: { status: number },
      message: string,
    ) => string

    const forbidden = refusalText({ status: 403 }, '')
    expect(forbidden).toContain('role')
    expect(forbidden).toContain('reload')
    expect(forbidden).not.toContain('403')
    // A server that bothered to explain itself is quoted verbatim.
    expect(refusalText({ status: 409 }, 'policy changed on disk')).toContain('policy changed on disk')
    expect(refusalText({ status: 500 }, '')).toBe('Action failed (500)')
  })

  /**
   * The session died under an open tab (TTL, `admin rotate`, `admin remove`, a
   * role change). The server clears the cookie and answers 401 to a script's
   * fetch and a redirect to `/login` to a navigation; the script must act on
   * BOTH — a redirect is followed transparently by `fetch`, so a signed-out
   * region refresh arrives as a 200 carrying the login page.
   */
  describe('a dead session sends the page to /login', () => {
    function loadSignedOut(): (res: unknown) => boolean {
      const helpers = /\n {2}function isLoginUrl\(url\) \{[\s\S]*?\n {2}function isSignedOut\(res\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
      expect(helpers, 'isSignedOut not found in APP_JS').toBeDefined()
      return new Function(
        'window',
        `${helpers ?? ''}\nreturn isSignedOut;`,
      )({ location: { href: 'http://ui.test/servers' } }) as (res: unknown) => boolean
    }

    test('401 and a redirect that landed on /login both count; a plain 200 does not', () => {
      const isSignedOut = loadSignedOut()
      expect(isSignedOut({ status: 401, redirected: false, url: 'http://ui.test/servers' })).toBe(true)
      expect(isSignedOut({ status: 200, redirected: true, url: 'http://ui.test/login' })).toBe(true)
      expect(isSignedOut({ status: 200, redirected: false, url: 'http://ui.test/servers' })).toBe(false)
      // A redirect somewhere else is not a sign-out (and must not become one).
      expect(isSignedOut({ status: 200, redirected: true, url: 'http://ui.test/servers' })).toBe(false)
    })

    test('goToLogin does not bounce a page that is already the login page', () => {
      const source = /\n {2}function goToLogin\(\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
      expect(source, 'goToLogin not found in APP_JS').toBeDefined()
      const replaced: string[] = []
      const load = (pathname: string): (() => void) =>
        new Function('window', `${source ?? ''}\nreturn goToLogin;`)({
          location: { pathname, replace: (url: string) => replaced.push(url) },
        }) as () => void

      load('/servers')()
      expect(replaced).toEqual(['/login'])
      load('/login')()
      expect(replaced).toEqual(['/login'])
    })

    test('a signed-out action leaves for /login instead of toasting', () => {
      // Ordering matters: the check precedes `res.ok`, because a followed
      // redirect reaches the handler as a 200.
      expect(JS_SOURCE).toMatch(/if \(isSignedOut\(res\)\) \{\s*goToLogin\(\);\s*\} else if \(res\.ok\)/)
    })

    test('a signed-out region refresh leaves for /login and swaps nothing', async () => {
      const source = /\n {2}function refreshRegion\(region\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
      expect(source, 'refreshRegion not found in APP_JS').toBeDefined()
      const swaps: string[] = []
      let departures = 0
      const refreshRegion = new Function(
        'fetch',
        'swapRegion',
        'window',
        'isSignedOut',
        'goToLogin',
        `${source ?? ''}\nreturn refreshRegion;`,
      )(
        () => Promise.resolve({ ok: true, status: 200, redirected: true, url: 'http://ui.test/login', text: () => Promise.resolve('LOGIN PAGE') }),
        (_r: unknown, text: string) => { swaps.push(text) },
        { location: { href: 'http://ui.test/quarantine' } },
        (res: { redirected: boolean }) => res.redirected,
        () => { departures += 1 },
      ) as (region: unknown) => Promise<void>
      const attrs: Record<string, string> = {}
      await refreshRegion({
        getAttribute: (k: string) => attrs[k] ?? null,
        setAttribute: (k: string, v: string) => { attrs[k] = v },
      })

      expect(departures).toBe(1)
      expect(swaps).toEqual([])
    })
  })

  test('runAction settles a 2xx through settleAction and never reloads directly', () => {
    expect(JS_SOURCE).toMatch(/if \(res\.ok\) \{\s*settleAction\(el\);/)
    expect(JS_SOURCE.match(/window\.location\.reload\(\)/g)).toHaveLength(1)
  })

  /**
   * `disabled` on a <form> disables nothing — and every action form carries
   * `data-action` on the form. `setBusy` toggles the buttons inside instead.
   */
  test('setBusy disables the buttons inside a form, not just the form', () => {
    const source = /\n {2}function setBusy\(el, busy\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'setBusy not found in APP_JS').toBeDefined()
    const setBusy = new Function(`${source ?? ''}\nreturn setBusy;`)() as (el: unknown, busy: boolean) => void
    const button = { disabled: false }
    const form = { disabled: false, querySelectorAll: () => [button] }
    setBusy(form, true)
    expect(button.disabled).toBe(true)
    setBusy(form, false)
    expect(button.disabled).toBe(false)
    expect(JS_SOURCE).toMatch(/setBusy\(el, true\);\s*fetch\(url/)
    expect(JS_SOURCE).not.toMatch(/el\.setAttribute\("disabled"/)
  })

  /**
   * Two re-fetches of one region can now overlap (the operator's own settle
   * and the SSE watcher's within the same second); a late OLDER response must
   * not overwrite a newer swap with stale cards.
   */
  test('refreshRegion drops a response that a later refresh of the same region superseded', async () => {
    const source = /\n {2}function refreshRegion\(region\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'refreshRegion not found in APP_JS').toBeDefined()
    const swaps: string[] = []
    const pending: Array<(text: string) => void> = []
    const fetchStub = () =>
      new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve) => {
        pending.push((text) => resolve({ ok: true, status: 200, text: () => Promise.resolve(text) }))
      })
    const refreshRegion = new Function(
      'fetch',
      'swapRegion',
      'window',
      'isSignedOut',
      'goToLogin',
      `${source ?? ''}\nreturn refreshRegion;`,
    )(
      fetchStub,
      (_r: unknown, text: string) => { swaps.push(text) },
      { location: { href: '/quarantine' } },
      () => false,
      () => undefined,
    ) as (region: unknown) => Promise<void>
    const attrs: Record<string, string> = {}
    const region = {
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => { attrs[k] = v },
    }
    const first = refreshRegion(region)
    const second = refreshRegion(region)
    pending[1]?.('NEWER')
    await second
    pending[0]?.('OLDER')
    await first
    expect(swaps).toEqual(['NEWER'])
  })

  /** The shipped `syncLiveText`, run against stub documents. */
  function loadSyncLiveText(): (scope: unknown, document: unknown) => void {
    const source = /\n {2}function syncLiveText\(scope\) \{[\s\S]*?\n {2}\}/.exec(JS_SOURCE)?.[0]
    expect(source, 'syncLiveText not found in APP_JS').toBeDefined()
    return new Function(
      'scope',
      'document',
      `var cssEscape = function (v) { return v; };\n${source ?? ''}\nsyncLiveText(scope);`,
    ) as (scope: unknown, document: unknown) => void
  }

  interface TextNode { key: string; textContent: string }
  function docStub(nodes: TextNode[]): unknown {
    return {
      querySelectorAll: () => nodes.map((n) => ({ getAttribute: () => n.key, get textContent() { return n.textContent }, set textContent(v: string) { n.textContent = v } })),
      querySelector: (selector: string) => {
        const key = /data-live-text="([^"]*)"/.exec(selector)?.[1]
        const hit = nodes.find((n) => n.key === key)
        return hit === undefined ? null : { textContent: hit.textContent }
      },
    }
  }

  test('every data-live-text node takes its text from the matching node in the fresh document', () => {
    const live = [{ key: 'quarantine-held', textContent: '3 held' }, { key: 'nav-meta', textContent: '3 held' }]
    const fresh = docStub([{ key: 'quarantine-held', textContent: '2 held' }, { key: 'nav-meta', textContent: '2 held' }])
    loadSyncLiveText()(fresh, docStub(live))
    expect(live.map((n) => n.textContent)).toEqual(['2 held', '2 held'])
  })

  test('a node with no counterpart in the fresh document keeps its text', () => {
    const live = [{ key: 'nav-meta', textContent: '3 held' }]
    loadSyncLiveText()(docStub([]), docStub(live))
    expect(live[0]?.textContent).toBe('3 held')
  })

  test('swapRegion syncs live text after swapping the region', () => {
    expect(JS_SOURCE).toMatch(/region\.innerHTML = fresh\.innerHTML;\s*syncPendingBadge\(doc\);\s*syncLiveText\(doc\);/)
  })

  test('the quarantine region opts in, and its held count and the nav meta are live-text nodes', () => {
    const document = renderQuarantinePage({
      cards: [QUARANTINE_CARD],
      csrfToken: SESSION.csrfToken,
      currentAdmin: { name: SESSION.adminName, role: SESSION.role },
    })
    expect(document).toMatch(/<section[^>]*data-live-region="quarantine-changed"[^>]*data-live-settle/)
    expect(document).toMatch(/<span class="small dim num" data-live-text="quarantine-held">1 held<\/span>/)
    expect(document).toMatch(/<span class="meta num" data-live-text="nav-meta">1 held<\/span>/)
  })

  /**
   * The dashboard queue settles in place too (user-journey smoke 2026-09-18,
   * UX-12): approve/deny used to reload the whole page, while the quarantine
   * list — the same mechanism, the same kind of action — did not.
   *
   * What makes it safe is that an SSE `approval-resolved` event ALREADY swaps
   * exactly this region and nothing else, so the panels outside it (the journal
   * table, the call detail, the servers strip) have never been refreshed by
   * another operator's decision either. Opting in makes one's own decision
   * behave like everybody else's; the two counts that DO describe the queue
   * follow along as `data-live-text`.
   */
  test('the approval queue region opts in, and both queue counts outside it are live-text nodes', () => {
    const document = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: SESSION.csrfToken, currentAdmin: QUARANTINE_ADMIN })

    expect(document).toMatch(
      /<section[^>]*data-live-region="approval-pending approval-resolved"[^>]*data-live-settle/,
    )
    expect(document).toMatch(/data-live-text="queue-held">1 held</)
    expect(document).toMatch(/data-live-text="tile-held">1</)
  })
})

/**
 * The two pages whose mutating controls live inside a live region, and so
 * cannot be tucked into a role-gated drawer the way `/agents` and `/groups` do
 * it. Both used to offer them to a `viewer`, who then read a bare 403 (the
 * browser leg of the user-journey smoke, 2026-09-18, UX-5 — the dashboard half
 * the smoke itself had missed).
 */
describe('a page offers no control the role cannot use', () => {
  const VIEWER = { name: 'val', role: 'viewer' }
  const OPERATOR = { name: 'op', role: 'operator' }

  test('the dashboard queue hides Approve/Deny and the bulk control below operator', () => {
    const document = renderApprovalsPage({
      cards: [APPROVAL_CARD],
      csrfToken: SESSION.csrfToken,
      currentAdmin: VIEWER,
    })

    expect(document).not.toContain('/approve"')
    expect(document).not.toContain('/deny"')
    expect(document).not.toContain('data-bulk-approve')
    // The queue is still readable: the point of a viewer's dashboard.
    expect(document).toContain(APPROVAL_CARD.toolName)
    expect(document).toContain('1 held')
  })

  test('an operator keeps every control on both pages', () => {
    const dashboard = renderApprovalsPage({
      cards: [APPROVAL_CARD],
      csrfToken: SESSION.csrfToken,
      currentAdmin: OPERATOR,
    })
    const quarantine = renderQuarantinePage({
      cards: [QUARANTINE_CARD],
      csrfToken: SESSION.csrfToken,
      currentAdmin: OPERATOR,
    })

    expect(dashboard).toContain(`/approvals/${APPROVAL_CARD.approvalId}/approve`)
    expect(dashboard).toContain(`/approvals/${APPROVAL_CARD.approvalId}/deny`)
    expect(quarantine).toContain('action="/quarantine/approve"')
  })

  test('a page rendered with no session at all offers nothing: fail closed in the display too', () => {
    const dashboard = renderApprovalsPage({ cards: [APPROVAL_CARD], csrfToken: '' })
    const quarantine = renderQuarantinePage({ cards: [QUARANTINE_CARD], csrfToken: '' })

    expect(dashboard).not.toContain('/approve"')
    expect(quarantine).not.toContain('/quarantine/approve')
  })
})
