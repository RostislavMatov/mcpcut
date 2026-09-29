import { describe, expect, test } from 'vitest'
import type { GroupRecord } from '../../src/groups/schema.js'
import type { UiSession } from '../../src/ui/auth.js'
import { ROUTE_TABLE } from '../../src/ui/authz.js'
import { renderAdminTokenOnce } from '../../src/ui/pages/admins.js'
import { renderDashboardPage, type DashboardSummary, type RecentDecisionView } from '../../src/ui/pages/dashboard.js'
import { renderGroupsPage } from '../../src/ui/pages/groups.js'
import { renderQuarantinePage } from '../../src/ui/pages/quarantine.js'

/**
 * The second pass of the owner's rule of 2026-09-29 over the console: the
 * dashboard panels, quarantine, groups and the admin token reveal each end
 * with the next step — a link to the action, or, for a role that cannot take
 * it, who can. `empty-states-next-step.test.ts` covers the first pass.
 */

type Role = UiSession['role']

function session(role: Role): UiSession {
  return { adminName: 'alice', role, csrfToken: 'csrf' }
}

const EMPTY_SUMMARY: DashboardSummary = {
  servers: [],
  quarantinedCount: 0,
  quarantinedServers: new Set(),
  approvedToolCount: 0,
  agentsActive: 0,
  agentsTotal: 0,
  recentDecisions: [],
  recentTruncated: false,
}

const DECISION: RecentDecisionView = {
  id: 'r-1',
  ts: '2026-09-29T10:00:01.000Z',
  sessionId: 's1',
  serverName: 'github',
  toolName: 'list_issues',
  outcome: 'allow',
  rule: 'allow:read',
}

function dashboard(role: Role, summary: Partial<DashboardSummary> = {}, journalServer?: string): string {
  return renderDashboardPage({
    cards: [],
    csrfToken: 'c',
    currentAdmin: { name: 'alice', role },
    summary: { ...EMPTY_SUMMARY, ...summary },
    ...(journalServer !== undefined ? { journalServer } : {}),
  })
}

describe('dashboard: the call journal panel', () => {
  test('empty: names the first call that fills it and links to Agents', () => {
    const page = dashboard('owner')
    expect(page).toMatch(/<p class="empty">No decisions journalled yet\.[^<]*<a href="\/agents">/)
    expect(page).toContain('mcpcut wrap -- &lt;server command&gt;')
  })

  test('a filter that matches nothing links back to all servers', () => {
    const servers = [{ name: 'github', transport: 'stdio', command: 'gh' } as const, { name: 'pg', transport: 'stdio', command: 'pg' } as const]
    const page = dashboard('owner', { servers, recentDecisions: [DECISION] }, 'pg')
    expect(page).toMatch(/<p class="empty">No calls match this filter\.[^<]*<a href="\/">Show all servers<\/a>/)
  })

  test('a truncated read links to the journal for the rest', () => {
    const page = dashboard('owner', { recentDecisions: [DECISION], recentTruncated: true })
    expect(page).toMatch(/read stopped early — <a href="\/journal">open the journal<\/a> for the rest/)
  })

  test('with no call at all the detail card does not ask to pick a row', () => {
    const page = dashboard('owner')
    expect(page).not.toContain('Pick a row')
    expect(page).toContain('The newest call shows here')
  })
})

describe('dashboard: the servers panel', () => {
  test('empty, owner: links to Register a server', () => {
    const page = dashboard('owner')
    expect(page).toMatch(/<p class="empty">No servers registered\.[^<]*<a href="\/servers\?add=1#add-server">Register a server<\/a>/)
  })

  test('the link follows the route table: registering a server is an owner action', () => {
    // The dashboard copies this threshold; a change to the row must revisit it.
    const row = ROUTE_TABLE.find((entry) => entry.method === 'POST' && entry.pattern === '/servers/add')
    expect(row?.minRole).toBe('owner')
  })

  test('empty, operator: an owner registers them, no link it cannot use', () => {
    const page = dashboard('operator')
    expect(page).toContain('No servers registered. An owner registers them.')
    expect(page).not.toContain('href="/servers?add=1#add-server"')
  })
})

describe('quarantine', () => {
  test('empty: says what lands here and links to the servers', () => {
    const page = renderQuarantinePage({ cards: [], csrfToken: 'c', currentAdmin: { name: 'alice', role: 'viewer' } })
    expect(page).toMatch(/<p class="empty">No quarantined tools\.[^<]*first lists it or changes its schema[^<]*<a href="\/servers">Servers<\/a>/)
  })
})

function group(over: Partial<GroupRecord> = {}): GroupRecord {
  return { name: 'analytics', grants: {}, members: [], createdAt: '2026-09-29T00:00:00.000Z', ...over } as GroupRecord
}

function groupsPage(role: Role, groups: readonly GroupRecord[]): string {
  return renderGroupsPage({ groups, agents: [], servers: [], session: session(role), canManage: role === 'owner' })
}

describe('groups', () => {
  test('no groups, owner: the create drawer', () => {
    const page = groupsPage('owner', [])
    expect(page).toMatch(/<p class="empty">No groups yet\.[^<]*<a href="\/groups\?add=1#create-group" data-open-details="create-group">Create a group<\/a>/)
  })

  test('no groups, viewer: an owner creates them', () => {
    const page = groupsPage('viewer', [])
    expect(page).toContain('No groups yet. An owner creates them.')
    expect(page).not.toContain('#create-group')
  })

  test('an empty group, owner: grant a server and add an agent from the card', () => {
    const page = groupsPage('owner', [group()])
    expect(page).toMatch(/No servers granted\.[^<]*<a href="\/groups\?grant=1#grant-group" data-open-details="grant-group">Grant a server<\/a>/)
    expect(page).toMatch(/No members\.[^<]*<a href="\/groups\?join=1#join-group" data-open-details="join-group">Add an agent<\/a>/)
  })

  test('an empty group, viewer: an owner fills it', () => {
    const page = groupsPage('viewer', [group()])
    expect(page).toContain('No servers granted. An owner grants them.')
    expect(page).toContain('No members. An owner adds agents.')
    expect(page).not.toContain('data-open-details')
  })
})

describe('admins: the one-time token reveal', () => {
  test('a new admin: hand it over, they sign in on the sign-in page', () => {
    const page = renderAdminTokenOnce({ admin: 'carol', token: 't0k', action: 'created', session: session('owner') })
    expect(page).toMatch(/Give it to carol: they sign in on <a href="\/login">the sign-in page<\/a> with it\./)
  })

  test('a rotated token: the old one is dead, sign in again with this one', () => {
    const page = renderAdminTokenOnce({ admin: 'carol', token: 't0k', action: 'rotated', session: session('owner') })
    expect(page).toMatch(/The old token no longer works: carol signs in again on <a href="\/login">the sign-in page<\/a> with this one\./)
  })
})
