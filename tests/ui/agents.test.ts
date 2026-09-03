import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import type { AgentRecord } from '../../src/agents/schema.js'
import {
  AgentsFileInvalidError,
  createAgentsStore,
  type AgentsStore,
} from '../../src/agents/store.js'
import { createGroupsStore, type GroupsStore } from '../../src/groups/store.js'
import { StoreWriteRejectedError } from '../../src/policy/store.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import type { AccessEditInfo } from '../../src/journal/record.js'
import type { UiSession } from '../../src/ui/auth.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import {
  createAgentsHandlers,
  type AgentsHandlers,
  type UiAuditEvent,
} from '../../src/ui/handlers/agents.js'
import { renderAgentsPage } from '../../src/ui/pages/agents.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * M4 Task 14 — agent permission matrix (page + grant/ungrant/revoke/create).
 * Tests are written against the injectable factory `createAgentsHandlers` with
 * the real `agents/store.ts` behind a temp journal dir; no HTTP server needed
 * to exercise the handler contract.
 */

function session(role: UiSession['role'], adminName = 'op-admin'): UiSession {
  return { adminName, role, csrfToken: 'csrf-token-value-123456' }
}

/** Builds a POST context carrying a urlencoded form body and a session. */
function postCtx(form: Record<string, string>, sess: UiSession | undefined): UiRequestContext {
  const body = Buffer.from(new URLSearchParams(form).toString(), 'utf8')
  return {
    method: 'POST',
    path: '/agents/action',
    params: {},
    query: new URLSearchParams(),
    session: sess,
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

function getCtx(sess: UiSession | undefined): UiRequestContext {
  return {
    method: 'GET',
    path: '/agents',
    params: {},
    query: new URLSearchParams(),
    session: sess,
    body: Buffer.alloc(0),
    headers: {},
  }
}

function asResponseStatus(result: UiResult): number {
  if (result.kind !== 'response') throw new Error('expected a buffered response, got a stream')
  return result.status
}

function bodyOf(result: UiResult): string {
  if (result.kind !== 'response') throw new Error('expected a buffered response, got a stream')
  return String(result.body ?? '')
}

let journalDir: string
let store: AgentsStore
let groups: GroupsStore
let audit: UiAuditEvent[]
/** Every `access-edit` the handlers handed to the injected journal port. */
let accessEdits: AccessEditInfo[]
let handlers: AgentsHandlers

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-agents-'))
  store = createAgentsStore({ journalDir })
  groups = createGroupsStore({ journalDir })
  audit = []
  accessEdits = []
  handlers = createAgentsHandlers({
    agentsStore: store,
    groups,
    audit: (event) => audit.push(event),
    journalAccessEdit: async (info) => {
      accessEdits.push(info)
      return { written: true }
    },
  })
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

describe('agent matrix rendering', () => {
  test('renders agent × server × (tools/resources/prompts) from agents.json', async () => {
    await store.createAgent('research-bot')
    await store.grantServer('research-bot', 'github', ['create_issue', 'list_*'], {
      resources: ['file:///project/*'],
      prompts: '*',
    })

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('research-bot')
    expect(html).toContain('github')
    expect(html).toContain('create_issue')
    expect(html).toContain('list_*')
    expect(html).toContain('file:///project/*')
    // prompts: '*' renders as the "all" marker.
    expect(html).toContain('all')
  })

  test('hostile agent/server/tool strings are HTML-escaped, not executable', () => {
    const evil: AgentRecord = {
      name: 'evil<script>',
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-08-11T00:00:00.000Z',
      grants: { 'srv"<x>': { tools: ['t<img>'] } },
    } as AgentRecord

    const html = renderAgentsPage({ agents: [evil], session: session('owner') })

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img>')
    expect(html).toContain('evil&lt;script&gt;')
    expect(html).toContain('t&lt;img&gt;')
  })
})

describe('grant / ungrant / revoke through the store', () => {
  test('grant writes through the store and is visible after reload', async () => {
    await store.createAgent('bot')

    const granted = await handlers.agentsGrant(
      postCtx({ agent: 'bot', server: 'github', tools: 'create_issue', csrf_token: 'x' }, session('owner')),
    )
    expect(granted.kind).toBe('response')

    const stored = await store.getAgent('bot')
    expect(stored?.grants.github).toEqual({ tools: ['create_issue'] })

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))
    expect(html).toContain('github')
    expect(html).toContain('create_issue')
  })

  test('a lone * grants everything; resources/prompts stay unset when blank', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'gh', tools: '*' }, session('owner')))

    const stored = await store.getAgent('bot')
    expect(stored?.grants.gh).toEqual({ tools: '*' })
  })

  test('ungrant removes the grant', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['create_issue'])

    await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, session('owner')))

    const stored = await store.getAgent('bot')
    expect(stored?.grants.github).toBeUndefined()
  })

  test('revoke is a single action reflected in the store and UI', async () => {
    await store.createAgent('bot')

    const result = await handlers.agentsRevoke(postCtx({ agent: 'bot' }, session('owner')))
    expect(result.kind).toBe('response')

    const stored = await store.getAgent('bot')
    expect(stored?.revokedAt).toBeDefined()
    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))
    expect(html).toContain('revoked')
  })

  test('a concurrent CLI edit is not lost (store lock serializes writes)', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'ui-server', tools: 'a' }, session('owner')))
    // A separate store instance == a separate process editing the same file.
    const cli = createAgentsStore({ journalDir })
    await cli.grantServer('bot', 'cli-server', ['b'])

    const stored = await store.getAgent('bot')
    expect(Object.keys(stored?.grants ?? {}).sort()).toEqual(['cli-server', 'ui-server'])
  })
})

describe('create issues a one-time token', () => {
  test('create shows the token once with a warning and never persists it', async () => {
    const created = await handlers.agentsCreate(postCtx({ name: 'research-bot' }, session('owner')))
    const revealed = bodyOf(created)
    expect(revealed).toContain('research-bot')
    expect(revealed).toMatch(/shown once/i)

    // Extract the plaintext token from the reveal page.
    const match = revealed.match(/data-token>([^<]+)</)
    expect(match).not.toBeNull()
    const token = (match as RegExpMatchArray)[1] as string
    expect(token.length).toBeGreaterThan(20)

    // Marker: the token is absent from a subsequent page load...
    const reload = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))
    expect(reload).not.toContain(token)
    // ...from the store (only the hash is kept)...
    const stored = await store.getAgent('research-bot')
    expect(JSON.stringify(stored)).not.toContain(token)
    // ...and from the attribution audit trail.
    expect(JSON.stringify(audit)).not.toContain(token)
  })

  test('the end-to-end "issue a scoped key" flow works from the panel', async () => {
    await handlers.agentsCreate(postCtx({ name: 'scoped-bot' }, session('owner')))
    await handlers.agentsGrant(
      postCtx({ agent: 'scoped-bot', server: 'github', tools: 'read_*' }, session('owner')),
    )
    const stored = await store.getAgent('scoped-bot')
    expect(stored?.grants).toEqual({ github: { tools: ['read_*'] } })
  })
})

describe('error handling and attribution', () => {
  test('an action on a nonexistent agent yields a readable 400, not a 500', async () => {
    const result = await handlers.agentsGrant(
      postCtx({ agent: 'ghost', server: 'github', tools: 'x' }, session('owner')),
    )
    expect(result.kind).toBe('response')
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/does not exist/i)
  })

  test('every successful mutation is attributed to actor "ui" + admin name', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'gh', tools: 'a' }, session('owner', 'alice')))

    expect(audit).toContainEqual({ actor: 'ui', adminName: 'alice', action: 'agents.grant', target: 'bot/gh' })
  })

  test('a missing session is refused (server never dispatches this, but fail-closed)', async () => {
    const result = await handlers.agentsPage(getCtx(undefined))
    expect(result.kind).toBe('response')
    if (result.kind === 'response') expect(result.status).toBe(403)
  })
})

describe('CSRF and owner-only nav link', () => {
  test('forms embed the per-session CSRF token', async () => {
    await store.createAgent('bot')
    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))
    expect(html).toContain('name="csrf_token"')
    expect(html).toContain('csrf-token-value-123456')
  })

  test('the admins nav link shows for owner only', () => {
    const asOwner = renderAgentsPage({ agents: [], session: session('owner') })
    const asOperator = renderAgentsPage({ agents: [], session: session('operator') })
    const asViewer = renderAgentsPage({ agents: [], session: session('viewer') })
    expect(asOwner).toContain('/admins')
    expect(asOperator).not.toContain('/admins')
    expect(asViewer).not.toContain('/admins')
  })
})

describe('store failures are classified, not flattened to 400 (T-2)', () => {
  /** A store whose every mutation fails the way a broken plane fails. */
  function brokenStore(failure: Error): AgentsStore {
    return {
      ...store,
      createAgent: () => Promise.reject(failure),
      grantServer: () => Promise.reject(failure),
      ungrantServer: () => Promise.reject(failure),
      revokeAgent: () => Promise.reject(failure),
    } as AgentsStore
  }

  test('an unrecognized store error is a detail-free 500, not a 400 echoing it', async () => {
    const secretish = 'EACCES: /home/alice/.mcp-journal/agents.json.lock held by pid 4242'
    const failing = createAgentsHandlers({ agentsStore: brokenStore(new Error(secretish)), groups })
    const admin = session('owner')

    for (const result of [
      await failing.agentsCreate(postCtx({ name: 'bot' }, admin)),
      await failing.agentsGrant(postCtx({ agent: 'bot', server: 'github' }, admin)),
      await failing.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, admin)),
      await failing.agentsRevoke(postCtx({ agent: 'bot' }, admin)),
    ]) {
      if (result.kind === 'response') expect(result.status).toBe(500)
      expect(bodyOf(result)).not.toContain(secretish)
      expect(bodyOf(result)).not.toContain('agents.json')
    }
  })

  test('a corrupt agents.json is infrastructure (500), not operator error (400)', async () => {
    const failing = createAgentsHandlers({
      agentsStore: brokenStore(
        new AgentsFileInvalidError(new ZodError([{ code: 'custom', path: [], message: 'corrupt' }])),
      ),
      groups,
    })
    const result = await failing.agentsCreate(postCtx({ name: 'bot' }, session('owner')))
    if (result.kind === 'response') expect(result.status).toBe(500)
  })

  test('a capped write (StoreWriteRejectedError) is a readable 400, not a 500 (U6)', async () => {
    const rejected = new StoreWriteRejectedError('/tmp/agents.json', new Error('too many agents'))
    const failing = createAgentsHandlers({ agentsStore: brokenStore(rejected), groups })

    const result = await failing.agentsCreate(postCtx({ name: 'bot' }, session('owner')))

    expect(asResponseStatus(result)).toBe(400)
    expect(bodyOf(result)).toMatch(/Refusing to write/)
  })

  test('known validation errors still yield a 400 carrying their message', async () => {
    await store.createAgent('bot')
    const duplicate = await handlers.agentsCreate(postCtx({ name: 'bot' }, session('owner')))
    if (duplicate.kind === 'response') expect(duplicate.status).toBe(400)
    expect(bodyOf(duplicate)).toMatch(/exists/i)

    const missing = await handlers.agentsRevoke(postCtx({ agent: 'ghost' }, session('owner')))
    if (missing.kind === 'response') expect(missing.status).toBe(400)
    expect(bodyOf(missing)).toMatch(/ghost|not/i)
  })
})

/**
 * U1 — "Ungrant" on a row whose PERSONAL grant overrides a group grant is not
 * de-escalation: dropping it hands the agent back the (wider) group grant. The
 * operator must see that before it happens, and the audit line must not read
 * like a plain removal afterwards.
 */
describe('ungrant of an overriding personal grant (U1)', () => {
  async function seedShadowed(): Promise<void> {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['read_file'])
    await groups.createGroup('analytics')
    await groups.createGroup('ops')
    await groups.grantServer('analytics', 'github', ['read_file', 'create_issue'])
    await groups.grantServer('ops', 'github', '*')
    await groups.addMember('analytics', 'bot')
    await groups.addMember('ops', 'bot')
  }

  test('with no group behind it the ungrant happens immediately, as before', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['read_file'])
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'other', ['x'])
    await groups.addMember('analytics', 'bot')

    const result = await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, session('owner')))

    expect(asResponseStatus(result)).toBe(200)
    expect((await store.getAgent('bot'))?.grants.github).toBeUndefined()
    expect(audit).toEqual([
      { actor: 'ui', adminName: 'op-admin', action: 'agents.ungrant', target: 'bot/github' },
    ])
  })

  test('a shadowed group turns the ungrant into a confirmation, writing nothing', async () => {
    await seedShadowed()

    const result = await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, session('owner')))

    expect(asResponseStatus(result)).toBe(200)
    const body = bodyOf(result)
    expect(body).toContain('analytics')
    expect(body).toContain('ops')
    // The grant it would fall back to: the UNION of both groups, i.e. all tools.
    expect(body).toMatch(/all|\*/)
    expect(body).toContain('name="confirm" value="true"')
    expect(body).toContain('name="agent" value="bot"')
    expect(body).toContain('name="server" value="github"')
    // Nothing written, nothing attributed.
    expect((await store.getAgent('bot'))?.grants.github).toEqual({ tools: ['read_file'] })
    expect(audit).toEqual([])
  })

  test('confirming writes, and the audit target names what the agent now inherits', async () => {
    await seedShadowed()

    const result = await handlers.agentsUngrant(
      postCtx({ agent: 'bot', server: 'github', confirm: 'true' }, session('owner')),
    )

    expect(asResponseStatus(result)).toBe(200)
    expect((await store.getAgent('bot'))?.grants.github).toBeUndefined()
    expect(audit).toEqual([
      {
        actor: 'ui',
        adminName: 'op-admin',
        action: 'agents.ungrant',
        target: 'bot/github (inherits group:analytics, group:ops)',
      },
    ])
  })

  test('an unknown agent is still the store\'s 400, not a confirmation', async () => {
    const result = await handlers.agentsUngrant(postCtx({ agent: 'ghost', server: 'github' }, session('owner')))

    expect(asResponseStatus(result)).toBe(400)
  })

  test('the interstitial escapes a hostile group name', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['read_file'])
    const forged: GroupRecord = {
      name: 'evil<script>',
      createdAt: '2026-08-31T00:00:00.000Z',
      members: ['bot'],
      grants: { github: { tools: ['t<img>'] } },
    } as GroupRecord
    const forgedHandlers = createAgentsHandlers({
      agentsStore: store,
      groups: { listGroups: async () => [forged] },
      audit: (event) => audit.push(event),
    })

    const body = bodyOf(
      await forgedHandlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, session('owner'))),
    )

    expect(body).not.toContain('<script>')
    expect(body).not.toContain('<img>')
    expect(body).toContain('evil&lt;script&gt;')
  })
})

describe('McpCut agents page structure', () => {
  const bot = (name: string, extra: Partial<AgentRecord> = {}): AgentRecord =>
    ({
      name,
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-08-11T00:00:00.000Z',
      grants: {},
      ...extra,
    }) as AgentRecord

  test('the create and grant forms are drawers above the list, opened by the nav "+"', () => {
    const html = renderAgentsPage({ agents: [], session: session('owner') })
    expect(html).toContain('<details class="drawer" id="create-agent">')
    expect(html).toContain('<details class="drawer" id="grant-server">')
    expect(html).toContain('data-open-details="create-agent"')
    expect(html).toMatch(/<a class="tab" href="\/agents" aria-current="page">Agents<\/a>/)
    expect(html).toContain('action="/agents/create"')
    expect(html).toContain('action="/agents/grant"')
    expect(html).toContain('no agents yet')
  })

  test('the tab-bar meta counts agents and active agents', () => {
    const html = renderAgentsPage({
      agents: [bot('a'), bot('b', { revokedAt: '2026-08-12T00:00:00.000Z' })],
      session: session('owner'),
    })
    expect(html).toContain('2 agents · 1 active')
  })

  test('each agent is a card; "all" is an on-pill, an absent dimension is faint, revoked agents lose the revoke form', () => {
    const html = renderAgentsPage({
      agents: [
        bot('live', { grants: { gh: { tools: '*' } } }),
        bot('dead', { revokedAt: '2026-08-12T00:00:00.000Z', grants: { gh: { tools: ['x'] } } }),
      ],
      session: session('owner'),
    })
    expect(html).toMatch(/<section class="card agent ag-card" data-agent="live">/)
    expect(html).toMatch(/<span class="pill pill-on">all<\/span>/)
    expect(html).toMatch(/<span class="faint">—<\/span>/)
    expect(html).toMatch(/<span class="badge revoked">revoked<\/span>/)
    expect(html.match(/action="\/agents\/revoke"/g)).toHaveLength(1)
    expect(html).toMatch(/<tr data-server="gh">/)
    expect(html).toContain('action="/agents/ungrant"')
  })

  test('the owner-only Manage admins link sits in the panel header as a ghost link', () => {
    const html = renderAgentsPage({ agents: [], session: session('owner') })
    expect(html).toMatch(/<a class="btn-ghost" href="\/admins">Manage admins<\/a>/)
  })

  test('the token-once page keeps the data-token box and the warning callout', async () => {
    const created = bodyOf(await handlers.agentsCreate(postCtx({ name: 'tok-bot' }, session('owner'))))
    expect(created).toMatch(/<pre class="token" data-token>[^<]+<\/pre>/)
    expect(created).toContain('class="callout"')
    expect(created).toContain('class="panel panel-strong')
  })

  test('notices keep the ok / error semantics', async () => {
    const bad = bodyOf(await handlers.agentsRevoke(postCtx({ agent: 'ghost' }, session('owner'))))
    expect(bad).toContain('class="notice error')
    await store.createAgent('n-bot')
    const good = bodyOf(await handlers.agentsRevoke(postCtx({ agent: 'n-bot' }, session('owner'))))
    expect(good).toContain('class="notice ok')
  })
})

describe('group-derived rows and the by-group drawer (M5.5 п.2, Task 14)', () => {
  /** A hand-built group record — used where the store would reject the name. */
  const group = (name: string, extra: Partial<GroupRecord> = {}): GroupRecord =>
    ({
      name,
      createdAt: '2026-08-31T00:00:00.000Z',
      grants: {},
      members: [],
      ...extra,
    }) as GroupRecord

  const bot = (name: string, extra: Partial<AgentRecord> = {}): AgentRecord =>
    ({
      name,
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-08-11T00:00:00.000Z',
      grants: {},
      ...extra,
    }) as AgentRecord

  test('the matrix carries a Source column between Prompts and the action column', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['x'])

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('<th>Prompts</th><th>Source</th><th></th>')
    expect(html).toContain('<td class="ag-source">agent')
  })

  test('the empty matrix row spans every column', async () => {
    await store.createAgent('bare')

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('<td colspan="6" class="faint">no grants</td>')
  })

  test('a server held only through a group renders as group:<name> with no ungrant form', async () => {
    await store.createAgent('bot')
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'postgres', ['select'])
    await groups.addMember('analytics', 'bot')

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('<tr data-server="postgres">')
    expect(html).toContain('group:analytics')
    expect(html).not.toContain('action="/agents/ungrant"')
    expect(html).toContain('href="/groups#group-analytics"')
    expect(html).toContain('manage in groups')
    // The group's grant is what the row shows.
    expect(html).toContain('select')
  })

  test('a personal grant on the same server wins and names the group it overrides', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'postgres', ['personal_tool'])
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'postgres', ['group_tool'])
    await groups.addMember('analytics', 'bot')

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('overrides group:analytics')
    expect(html).toContain('personal_tool')
    expect(html).not.toContain('group_tool')
    // The personal row keeps its ungrant control.
    expect(html).toContain('action="/agents/ungrant"')
  })

  test('two contributing groups are both named on the row', async () => {
    await store.createAgent('bot')
    for (const name of ['analytics', 'reporting']) {
      await groups.createGroup(name)
      await groups.grantServer(name, 'clickhouse', ['q'])
      await groups.addMember(name, 'bot')
    }

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('group:analytics, group:reporting')
  })

  test('an agent in no group renders exactly the personal matrix', async () => {
    await store.createAgent('lonely')
    await store.grantServer('lonely', 'gh', ['a'])
    await groups.createGroup('other')
    await groups.grantServer('other', 'postgres', ['b'])

    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    expect(html).toContain('<tr data-server="gh">')
    expect(html).not.toContain('postgres')
    expect(html).not.toContain('group:other')
  })

  test('the by-group drawer is owner-only and lists groups and live agents', () => {
    const view = {
      agents: [bot('live'), bot('dead', { revokedAt: '2026-08-12T00:00:00.000Z' })],
      groups: [group('analytics')],
    }
    const asOwner = renderAgentsPage({ ...view, session: session('owner') })
    const asOperator = renderAgentsPage({ ...view, session: session('operator') })

    expect(asOwner).toContain('<details class="drawer" id="grant-group">')
    expect(asOwner).toContain('action="/groups/join"')
    expect(asOwner).toContain('<option value="analytics">analytics</option>')
    expect(asOwner).toContain('<option value="live">live</option>')
    expect(asOwner).not.toContain('<option value="dead">dead</option>')

    expect(asOperator).not.toContain('id="grant-group"')
    expect(asOperator).not.toContain('/groups/join')
  })

  test('with no groups the owner drawer explains where to create one and offers no select', () => {
    const html = renderAgentsPage({ agents: [bot('live')], groups: [], session: session('owner') })

    expect(html).toContain('id="grant-group"')
    expect(html).toContain('no groups yet')
    expect(html).not.toContain('name="group"')
  })

  test('a hostile group name is escaped everywhere it appears', () => {
    const evil = group('g<script>', { grants: { srv: { tools: ['t'] } }, members: ['bot'] })
    const html = renderAgentsPage({
      agents: [bot('bot')],
      groups: [evil],
      session: session('owner'),
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('group:g&lt;script&gt;')
    expect(html).toContain('<option value="g&lt;script&gt;">')
  })
})

/**
 * T4 (owner decision, 2026-09-01) — every personal-grant mutation is an OWNER
 * action. `ROUTE_TABLE` is the enforcement (pinned by the matrix test in
 * `ui-hardening.test.ts`); this page must not offer controls that the route
 * would then refuse, while the matrix itself stays readable to everyone.
 */
describe('the permission matrix is owner-editable, read-only below (T4)', () => {
  /** An agent with one personal grant and one inherited through a group. */
  async function seedMatrix(): Promise<void> {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['create_issue'])
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'postgres', ['select'])
    await groups.addMember('analytics', 'bot')
  }

  test.each(['operator', 'viewer'] as const)(
    'a %s reads the whole matrix and is offered no edit control',
    async (role) => {
      // Arrange
      await seedMatrix()

      // Act
      const html = bodyOf(await handlers.agentsPage(getCtx(session(role))))

      // Assert — the data is all there...
      expect(html).toContain('data-agent="bot"')
      expect(html).toContain('<tr data-server="github">')
      expect(html).toContain('create_issue')
      expect(html).toContain('<tr data-server="postgres">')
      expect(html).toContain('group:analytics')
      // ...and not one control that posts a mutation.
      expect(html).not.toContain('action="/agents/create"')
      expect(html).not.toContain('action="/agents/grant"')
      expect(html).not.toContain('action="/agents/ungrant"')
      expect(html).not.toContain('action="/agents/revoke"')
      expect(html).not.toContain('action="/groups/join"')
      expect(html).not.toContain('id="create-agent"')
      expect(html).not.toContain('data-open-details="create-agent"')
    },
  )

  test('an owner keeps every control on the same matrix', async () => {
    // Arrange
    await seedMatrix()

    // Act
    const html = bodyOf(await handlers.agentsPage(getCtx(session('owner'))))

    // Assert
    expect(html).toContain('action="/agents/create"')
    expect(html).toContain('action="/agents/grant"')
    expect(html).toContain('action="/agents/ungrant"')
    expect(html).toContain('action="/agents/revoke"')
    expect(html).toContain('action="/groups/join"')
  })

  test('the read-only matrix keeps all six columns on every row', async () => {
    // Arrange
    await seedMatrix()

    // Act
    const html = bodyOf(await handlers.agentsPage(getCtx(session('viewer'))))

    // Assert — the personal row keeps an (empty) action cell, so the row does
    // not shrink out of alignment with the header.
    expect(html).toContain('<td class="ag-ungrant"></td>')
    expect(html).toContain('<th>Prompts</th><th>Source</th><th></th>')
    // The inherited row still points at where its grant is managed.
    expect(html).toContain('manage in groups')
  })
})

/**
 * T1 (owner decision, 2026-09-01) — a personal grant edit made from the panel
 * leaves the same `access-edit` record a group edit does. Before this, the
 * journal could answer "who changed this group" but not "who changed this
 * agent", and the two halves of the same question have to be answered
 * together.
 */
describe('personal grant edits are journalled (T1)', () => {
  const actor = { adminName: 'alice', role: 'owner', via: 'ui' }
  const admin = (): UiSession => session('owner', 'alice')

  test('create records agent.create and carries no token anywhere in the info', async () => {
    // Act
    const revealed = bodyOf(await handlers.agentsCreate(postCtx({ name: 'research-bot' }, admin())))
    const token = (revealed.match(/data-token>([^<]+)</) as RegExpMatchArray)[1] as string

    // Assert
    expect(accessEdits).toHaveLength(1)
    expect(accessEdits[0]).toEqual({ actor, action: 'agent.create', agent: 'research-bot' })
    // The one-time key has no field in the record and must never gain one.
    expect(JSON.stringify(accessEdits)).not.toContain(token)
    expect(Object.keys(accessEdits[0] as object)).not.toContain('token')
  })

  test('grant records agent.grant with the grant that was actually written', async () => {
    // Arrange
    await store.createAgent('bot')

    // Act
    await handlers.agentsGrant(
      postCtx({ agent: 'bot', server: 'github', tools: 'create_issue', prompts: '*' }, admin()),
    )

    // Assert
    expect(accessEdits).toEqual([
      {
        actor,
        action: 'agent.grant',
        agent: 'bot',
        server: 'github',
        grant: { tools: ['create_issue'], prompts: '*' },
      },
    ])
  })

  test('ungrant and revoke record their own actions', async () => {
    // Arrange
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['create_issue'])

    // Act
    await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, admin()))
    await handlers.agentsRevoke(postCtx({ agent: 'bot' }, admin()))

    // Assert
    expect(accessEdits).toEqual([
      { actor, action: 'agent.ungrant', agent: 'bot', server: 'github' },
      { actor, action: 'agent.revoke', agent: 'bot' },
    ])
  })

  test('a refused edit leaves no record — the journal must not show a phantom grant', async () => {
    // Act — no such agent, so nothing was written.
    const result = await handlers.agentsGrant(postCtx({ agent: 'ghost', server: 'gh', tools: 'x' }, admin()))

    // Assert
    expect(asResponseStatus(result)).toBe(400)
    expect(accessEdits).toEqual([])
  })

  test('an ungrant stopped by the confirmation interstitial is not journalled yet', async () => {
    // Arrange — a personal grant shadowing a group grant needs a confirm (U1).
    await store.createAgent('bot')
    await store.grantServer('bot', 'postgres', ['personal_tool'])
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'postgres', ['group_tool'])
    await groups.addMember('analytics', 'bot')

    // Act
    const shown = await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'postgres' }, admin()))

    // Assert
    expect(asResponseStatus(shown)).toBe(200)
    expect(accessEdits).toEqual([])

    // Act — confirmed, the record lands exactly once.
    await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'postgres', confirm: 'true' }, admin()))

    // Assert
    expect(accessEdits).toEqual([
      { actor, action: 'agent.ungrant', agent: 'bot', server: 'postgres' },
    ])
  })

  test('a journal port that rejects cannot turn a completed write into a 500', async () => {
    // Arrange
    const failing = createAgentsHandlers({
      agentsStore: store,
      groups,
      journalAccessEdit: () => Promise.reject(new Error('journal sink is down')),
    })
    await store.createAgent('bot')

    // Act
    const result = await failing.agentsRevoke(postCtx({ agent: 'bot' }, admin()))

    // Assert — the revoke stands; the notice says its record was lost.
    expect(asResponseStatus(result)).toBe(200)
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect((await store.getAgent('bot'))?.revokedAt).toBeDefined()
  })

  test('a writer answering written: false → the grant stands and the 200 notice carries the warning (audit F1)', async () => {
    // Arrange
    const dropping = createAgentsHandlers({
      agentsStore: store,
      groups,
      journalAccessEdit: async () => ({ written: false }),
    })
    await store.createAgent('bot')

    // Act
    const result = await dropping.agentsGrant(postCtx({ agent: 'bot', server: 'postgres', tools: 'query' }, admin()))

    // Assert
    expect(asResponseStatus(result)).toBe(200)
    expect(bodyOf(result)).toContain('granted postgres to bot')
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(bodyOf(result)).toContain('class="notice ok ag-notice"')
    expect((await store.getAgent('bot'))?.grants.postgres).toBeDefined()
  })

  test('a writer answering written: true → the same notice without the warning', async () => {
    // Arrange
    await store.createAgent('bot')

    // Act
    const result = await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'postgres', tools: 'query' }, admin()))

    // Assert
    expect(asResponseStatus(result)).toBe(200)
    expect(bodyOf(result)).toContain('granted postgres to bot')
    expect(bodyOf(result)).not.toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(bodyOf(result)).not.toContain('notice-warning')
  })

  test('without the port the handlers still work (a plane wired before T1)', async () => {
    // Arrange
    const portless = createAgentsHandlers({ agentsStore: store, groups })

    // Act
    const result = await portless.agentsCreate(postCtx({ name: 'bot' }, admin()))

    // Assert
    expect(asResponseStatus(result)).toBe(200)
    expect(accessEdits).toEqual([])
  })
})
