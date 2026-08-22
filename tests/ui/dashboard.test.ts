import { describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import type { CrossSessionSearchResult } from '../../src/journal/search.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import type { PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalsHandlers, type DashboardSummaryPorts } from '../../src/ui/handlers/approvals.js'
import { renderDashboardPage, toRecentDecisions, type DashboardSummary } from '../../src/ui/pages/dashboard.js'
import { renderApprovalsPage } from '../../src/ui/pages/approvals.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * The dashboard at `/` (McpCut redesign): tiles, the approval queue panel
 * (unchanged live-region contract), recent journal decisions and the servers
 * strip. The summary is OPTIONAL — without it the page is the M4 queue page.
 */

const SESSION = { adminName: 'alice', role: 'owner', csrfToken: 'csrf-1' } as const

function decisionRecord(ts: string, over: Partial<NonNullable<JournalRecord['decision']>> = {}): JournalRecord {
  return {
    id: `r-${ts}`,
    ts,
    sessionId: 's1',
    direction: 'client->server',
    kind: 'decision',
    payload: null,
    decision: {
      outcome: 'allow',
      rule: 'allow:read',
      serverName: 'github',
      toolName: 'list_issues',
      toolClass: 'read',
      quarantineState: 'approved',
      argsHash: 'h',
      agentName: 'research-bot',
      ...over,
    } as NonNullable<JournalRecord['decision']>,
  }
}

const SUMMARY: DashboardSummary = {
  servers: [
    { name: 'github', transport: 'stdio', command: 'gh-mcp' },
    { name: 'pg', transport: 'http', url: 'https://pg.internal/mcp', protocol: 'auto' },
  ],
  quarantinedCount: 2,
  quarantinedServers: new Set(['pg']),
  approvedToolCount: 7,
  agentsActive: 3,
  agentsTotal: 4,
  recentDecisions: toRecentDecisions(
    [
      { sessionId: 's1', record: decisionRecord('2026-08-22T10:00:01.000Z') },
      { sessionId: 's1', record: decisionRecord('2026-08-22T10:00:05.000Z', { outcome: 'deny', toolName: 'rm_rf' }) },
    ],
    12,
  ),
  recentTruncated: false,
}

describe('dashboard rendering', () => {
  test('without a summary it is the plain queue page (M4 contract)', () => {
    const doc = renderApprovalsPage({ cards: [], csrfToken: 'c' })
    expect(doc).toContain('No pending approvals.')
    expect(doc).toContain('data-live-region="approval-pending approval-resolved"')
    expect(doc).toContain('data-live-src="/"')
    expect(doc).toContain('data-pending-count="0"')
    expect(doc).not.toContain('Call journal')
    expect(doc).not.toContain('dash-servers')
  })

  test('with a summary it renders tiles, recent decisions and the servers strip', () => {
    const doc = renderDashboardPage({
      cards: [],
      csrfToken: 'c',
      currentAdmin: { name: 'alice', role: 'owner' },
      summary: SUMMARY,
    })
    // tiles
    expect(doc).toContain('Quarantined')
    expect(doc).toContain('7 tools approved')
    expect(doc).toContain('of 4 active')
    // recent decisions: newest first, deny marked, linking into the journal session
    const rmIndex = doc.indexOf('rm_rf')
    const listIndex = doc.indexOf('list_issues')
    expect(rmIndex).toBeGreaterThan(-1)
    expect(listIndex).toBeGreaterThan(rmIndex)
    expect(doc).toContain('outcome-deny')
    expect(doc).toContain('href="/journal?session=s1"')
    // servers strip: the quarantined server is flagged
    expect(doc).toContain('gh-mcp')
    expect(doc).toContain('https://pg.internal/mcp')
    expect(doc).toContain('quarantined')
    expect(doc).toContain('2 tool(s) quarantined')
    // the shell is the authenticated one
    expect(doc).toContain('class="tabs"')
    expect(doc).toContain('<title>Dashboard · McpCut</title>')
  })

  test('escapes hostile registry and journal values', () => {
    const doc = renderDashboardPage({
      cards: [],
      csrfToken: 'c',
      summary: {
        ...SUMMARY,
        servers: [{ name: '<img src=x onerror=alert(1)>', transport: 'stdio', command: 'x' }],
        recentDecisions: toRecentDecisions(
          [{ sessionId: 's"1', record: decisionRecord('2026-08-22T10:00:01.000Z', { toolName: '<script>evil()</script>' }) }],
          5,
        ),
      },
    })
    expect(doc).not.toContain('<img src=x')
    expect(doc).not.toContain('<script>evil()')
    expect(doc).toContain('&lt;script&gt;evil()&lt;/script&gt;')
    expect(doc).toContain('href="/journal?session=s%221"')
  })

  test('toRecentDecisions ignores non-decision records and caps the list', () => {
    const notDecision: JournalRecord = { ...decisionRecord('2026-08-22T10:00:00.000Z'), kind: 'request', decision: undefined }
    const hits = [
      { sessionId: 's', record: notDecision },
      { sessionId: 's', record: decisionRecord('2026-08-22T10:00:01.000Z') },
      { sessionId: 's', record: decisionRecord('2026-08-22T10:00:02.000Z') },
      { sessionId: 's', record: decisionRecord('2026-08-22T10:00:03.000Z') },
    ]
    const out = toRecentDecisions(hits, 2)
    expect(out.map((d) => d.ts)).toEqual(['2026-08-22T10:00:03.000Z', '2026-08-22T10:00:02.000Z'])
  })
})

describe('dashboard handler composition', () => {
  function ctx(): UiRequestContext {
    return {
      method: 'GET',
      path: '/',
      params: {},
      query: new URLSearchParams(),
      session: SESSION,
      body: Buffer.alloc(0),
      headers: {},
    }
  }
  function bodyOf(result: UiResult): string {
    if (result.kind !== 'response') throw new Error('expected response')
    return String(result.body)
  }
  const pending: PendingApproval = {
    approvalId: '01J0000000000000000000000A',
    agentName: 'research-bot',
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    argsRedacted: { title: 'x' },
    requestedAt: '2026-08-22T10:00:00.000Z',
    expiresAt: '2026-08-22T10:05:00.000Z',
    expired: false,
  } as unknown as PendingApproval
  const queue = {
    list: async () => [pending],
    countPending: async () => 1,
    resolve: async () => ({ ok: false as const }),
  }
  const inventory: InventoryStoreData = {
    servers: {
      github: {
        approved: { list_issues: { approvedAt: 't', schemaHash: 'h' } },
        quarantined: {
          create_issue: {
            state: 'new',
            firstSeenAt: 't',
            schemaHash: 'h2',
            descriptor: { name: 'create_issue' },
          },
        },
      },
    },
  } as unknown as InventoryStoreData
  const decisions: CrossSessionSearchResult = {
    hits: [{ sessionId: 's1', record: decisionRecord('2026-08-22T10:00:01.000Z') }],
    truncated: true,
    stoppedBy: 'deadline',
    filesScanned: 1,
    filesTotal: 3,
    bytesRead: 10,
    skippedLineCount: 0,
  }
  const ports: DashboardSummaryPorts = {
    listServers: async () => [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
    readInventory: async () => inventory,
    listAgents: async () =>
      [
        { name: 'a', tokenHash: 'x', grants: {}, createdAt: 't' },
        { name: 'b', tokenHash: 'y', grants: {}, createdAt: 't', revokedAt: 't' },
      ] as never,
    recentDecisions: async () => decisions,
  }

  test('renders queue + summary from the read ports and reports a truncated decisions walk honestly', async () => {
    const handlers = createApprovalsHandlers({ queue, summary: ports })
    const doc = bodyOf(await handlers.approvalsPage(ctx()))
    expect(doc).toContain('create_issue') // the queue card
    expect(doc).toContain('1 pending')
    expect(doc).toContain('1 tools approved')
    expect(doc).toContain('of 2 active')
    expect(doc).toContain('list_issues') // recent decision
    expect(doc).toContain('read stopped early')
  })

  test('without summary ports the handler renders the queue alone', async () => {
    const handlers = createApprovalsHandlers({ queue })
    const doc = bodyOf(await handlers.approvalsPage(ctx()))
    expect(doc).toContain('create_issue')
    expect(doc).not.toContain('Call journal')
  })
})
