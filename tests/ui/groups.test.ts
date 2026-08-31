import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { createGroupsStore, type GroupsStore } from '../../src/groups/store.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import type { AccessEditInfo } from '../../src/journal/record.js'
import { createRegistryStore, type RegistryStore } from '../../src/registry/store.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import type { UiSession } from '../../src/ui/auth.js'
import type { UiAuditEvent } from '../../src/ui/handlers/agents.js'
import { createGroupsHandlers, type GroupsHandlers } from '../../src/ui/handlers/groups.js'
import { renderGroupsPage } from '../../src/ui/pages/groups.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * M5.5 п.2, wave 3 — the `/groups` page and its six action handlers.
 *
 * Written against the injectable `createGroupsHandlers` with the REAL stores
 * behind a temp journal dir: the point of these tests is the handler contract
 * (what is refused, what is written, what is attributed), and a fake store
 * would only pin the fake. The hostile-string cases render the page directly
 * from forged records, because the stores' name patterns make such a record
 * unreachable through the normal path — and the page must survive a forged
 * `groups.json` all the same.
 */

function session(role: UiSession['role'], adminName = 'alice'): UiSession {
  return { adminName, role, csrfToken: 'csrf-token-value-123456' }
}

function getCtx(sess: UiSession | undefined, query = ''): UiRequestContext {
  return {
    method: 'GET',
    path: '/groups',
    params: {},
    query: new URLSearchParams(query),
    session: sess,
    body: Buffer.alloc(0),
    headers: {},
  }
}

function postCtx(form: Record<string, string>, sess: UiSession | undefined): UiRequestContext {
  const body = Buffer.from(new URLSearchParams(form).toString(), 'utf8')
  return {
    method: 'POST',
    path: '/groups/action',
    params: {},
    query: new URLSearchParams(),
    session: sess,
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

/** A POST with a completely EMPTY body — what the hardening matrix sends. */
function emptyPost(sess: UiSession | undefined): UiRequestContext {
  return {
    method: 'POST',
    path: '/groups/action',
    params: {},
    query: new URLSearchParams(),
    session: sess,
    body: Buffer.alloc(0),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response, got a stream')
  return result
}

function bodyOf(result: UiResult): string {
  return String(asResponse(result).body ?? '')
}

const SERVER: ServerRecord = { name: 'notes', transport: 'stdio', command: 'notes-mcp' }

let journalDir: string
let groups: GroupsStore
let agents: AgentsStore
let registry: RegistryStore
let audit: UiAuditEvent[]
let edits: AccessEditInfo[]
let handlers: GroupsHandlers

beforeEach(async () => {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-groups-'))
  groups = createGroupsStore({ journalDir })
  agents = createAgentsStore({ journalDir })
  registry = createRegistryStore(journalDir)
  audit = []
  edits = []
  handlers = createGroupsHandlers({
    groups,
    agents,
    registry,
    audit: (event) => audit.push(event),
    journalAccessEdit: async (info) => {
      edits.push(info)
    },
  })
  await registry.addServer(SERVER)
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// GET /groups
// ---------------------------------------------------------------------------

describe('GET /groups', () => {
  test('renders each group with its grants and its members', async () => {
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'notes', ['read_note', 'list_*'], {
      resources: ['file:///notes/*'],
      prompts: '*',
    })
    await agents.createAgent('bot-a')
    await groups.addMember('analytics', 'bot-a')

    const html = bodyOf(await handlers.groupsPage(getCtx(session('viewer'))))

    expect(html).toContain('analytics')
    expect(html).toContain('id="group-analytics"')
    expect(html).toContain('read_note')
    expect(html).toContain('list_*')
    expect(html).toContain('file:///notes/*')
    expect(html).toContain('bot-a')
    expect(html).toContain('grant-matrix gr-matrix')
  })

  test('an empty registry of groups renders the empty state, not a broken table', async () => {
    const html = bodyOf(await handlers.groupsPage(getCtx(session('owner'))))
    expect(html).toContain('no groups yet')
  })

  test('viewer and operator see no owner controls; owner sees all three drawers', async () => {
    await groups.createGroup('analytics')

    for (const role of ['viewer', 'operator'] as const) {
      const html = bodyOf(await handlers.groupsPage(getCtx(session(role))))
      expect(html, role).not.toContain('/groups/create')
      expect(html, role).not.toContain('/groups/remove')
      expect(html, role).not.toContain('/groups/grant')
      expect(html, role).not.toContain('/groups/join')
      expect(html, role).not.toContain('id="create-group"')
    }

    const asOwner = bodyOf(await handlers.groupsPage(getCtx(session('owner'))))
    expect(asOwner).toContain('id="create-group"')
    expect(asOwner).toContain('id="grant-group"')
    expect(asOwner).toContain('id="join-group"')
    expect(asOwner).toContain('/groups/remove')
  })

  test('?add=1 / ?grant=1 / ?join=1 render the matching drawer OPEN (the no-JS path)', async () => {
    const closed = bodyOf(await handlers.groupsPage(getCtx(session('owner'))))
    expect(closed).toContain('id="create-group"')
    expect(closed).not.toMatch(/id="create-group" open/)

    const add = bodyOf(await handlers.groupsPage(getCtx(session('owner'), 'add=1')))
    expect(add).toMatch(/id="create-group" open/)

    const grant = bodyOf(await handlers.groupsPage(getCtx(session('owner'), 'grant=1')))
    expect(grant).toMatch(/id="grant-group" open/)

    const joinPage = bodyOf(await handlers.groupsPage(getCtx(session('owner'), 'join=1')))
    expect(joinPage).toMatch(/id="join-group" open/)
  })

  test('a viewer cannot open a drawer by asking for one in the query string', async () => {
    const html = bodyOf(await handlers.groupsPage(getCtx(session('viewer'), 'add=1')))
    expect(html).not.toContain('id="create-group"')
  })

  test('the grant drawer offers the registry servers and the join drawer skips revoked agents', async () => {
    await groups.createGroup('analytics')
    await agents.createAgent('bot-a')
    await agents.createAgent('bot-gone')
    await agents.revokeAgent('bot-gone')

    const html = bodyOf(await handlers.groupsPage(getCtx(session('owner'))))
    const joinDrawer = html.slice(html.indexOf('id="join-group"'))

    expect(html).toContain('value="notes"')
    expect(joinDrawer).toContain('value="bot-a"')
    expect(joinDrawer).not.toContain('value="bot-gone"')
  })

  test('a revoked member is still listed on the card, marked revoked', async () => {
    await groups.createGroup('analytics')
    await agents.createAgent('bot-gone')
    await groups.addMember('analytics', 'bot-gone')
    await agents.revokeAgent('bot-gone')

    const html = bodyOf(await handlers.groupsPage(getCtx(session('owner'))))
    expect(html).toContain('bot-gone')
    expect(html).toContain('badge revoked')
  })

  test('a missing session is refused, never rendered', async () => {
    expect(asResponse(await handlers.groupsPage(getCtx(undefined))).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Hostile strings
// ---------------------------------------------------------------------------

describe('hostile names are escaped everywhere they appear', () => {
  test('group, member and server names from a forged document cannot inject markup', () => {
    const group: GroupRecord = {
      name: 'evil<script>',
      createdAt: '2026-08-31T00:00:00.000Z',
      grants: { 'srv"onload=x': { tools: ['<img src=x>'] } },
      members: ["bot'></span><script>alert(1)</script>"],
    }
    const agent: AgentRecord = {
      name: "bot'></span><script>alert(1)</script>",
      createdAt: '2026-08-31T00:00:00.000Z',
      tokenHash: 'x'.repeat(64),
      grants: {},
    }
    const server: ServerRecord = { name: 'srv"onload=x', transport: 'stdio', command: 'x' }

    const html = renderGroupsPage({
      groups: [group],
      agents: [agent],
      servers: [server],
      session: session('owner'),
      canManage: true,
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;onload=x')
  })
})

// ---------------------------------------------------------------------------
// POST /groups/create
// ---------------------------------------------------------------------------

describe('POST /groups/create', () => {
  test('creates the group, attributes it and journals it once, then redirects', async () => {
    const result = asResponse(await handlers.groupsCreate(postCtx({ name: 'analytics' }, session('owner'))))

    expect(result.status).toBe(303)
    expect(result.headers?.location).toBe('/groups')
    expect(await groups.getGroup('analytics')).toBeDefined()
    expect(audit).toEqual([
      { actor: 'ui', adminName: 'alice', action: 'group.create', target: 'analytics' },
    ])
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({
      action: 'group.create',
      group: 'analytics',
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
    })
  })

  test('an empty body is a 400, never a 500, and writes nothing', async () => {
    const result = asResponse(await handlers.groupsCreate(emptyPost(session('owner'))))
    expect(result.status).toBe(400)
    expect(await groups.listGroups()).toEqual([])
    expect(audit).toEqual([])
    expect(edits).toEqual([])
  })

  test('a duplicate name is a readable 400, not a 500', async () => {
    await groups.createGroup('analytics')
    const result = asResponse(await handlers.groupsCreate(postCtx({ name: 'analytics' }, session('owner'))))
    expect(result.status).toBe(400)
    expect(bodyOf(result)).toContain('already exists')
  })

  test('an invalid name is a readable 400', async () => {
    const result = asResponse(await handlers.groupsCreate(postCtx({ name: 'NOT VALID' }, session('owner'))))
    expect(result.status).toBe(400)
    expect(audit).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// POST /groups/grant · ungrant
// ---------------------------------------------------------------------------

describe('POST /groups/grant', () => {
  beforeEach(async () => {
    await groups.createGroup('analytics')
  })

  test('stores the grant with the agents-page field semantics and journals it', async () => {
    const result = asResponse(
      await handlers.groupsGrant(
        postCtx({ group: 'analytics', server: 'notes', tools: 'read_note, list_*', prompts: '*' }, session('owner')),
      ),
    )

    expect(result.status).toBe(303)
    const record = await groups.getGroup('analytics')
    expect(record?.grants.notes).toEqual({ tools: ['read_note', 'list_*'], prompts: '*' })
    expect(audit[0]).toMatchObject({ action: 'group.grant', target: 'analytics/notes' })
    expect(edits[0]).toMatchObject({
      action: 'group.grant',
      group: 'analytics',
      server: 'notes',
      grant: { tools: ['read_note', 'list_*'], prompts: '*' },
    })
  })

  test('an empty tools field grants no tools rather than everything', async () => {
    await handlers.groupsGrant(postCtx({ group: 'analytics', server: 'notes' }, session('owner')))
    expect((await groups.getGroup('analytics'))?.grants.notes).toEqual({ tools: [] })
  })

  test('an unknown server is refused with a 400 and writes nothing', async () => {
    const result = asResponse(
      await handlers.groupsGrant(postCtx({ group: 'analytics', server: 'ghost', tools: '*' }, session('owner'))),
    )
    expect(result.status).toBe(400)
    expect(bodyOf(result)).toContain('ghost')
    expect((await groups.getGroup('analytics'))?.grants).toEqual({})
    expect(edits).toEqual([])
  })

  test('an unknown group is a 400, not a 500', async () => {
    const result = asResponse(
      await handlers.groupsGrant(postCtx({ group: 'ghosts', server: 'notes', tools: '*' }, session('owner'))),
    )
    expect(result.status).toBe(400)
  })

  test('an empty body is a 400', async () => {
    expect(asResponse(await handlers.groupsGrant(emptyPost(session('owner')))).status).toBe(400)
  })
})

describe('POST /groups/ungrant', () => {
  test('drops the grant, attributes and journals it', async () => {
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', 'notes', '*')

    const result = asResponse(
      await handlers.groupsUngrant(postCtx({ group: 'analytics', server: 'notes' }, session('owner'))),
    )

    expect(result.status).toBe(303)
    expect((await groups.getGroup('analytics'))?.grants).toEqual({})
    expect(audit[0]).toMatchObject({ action: 'group.ungrant', target: 'analytics/notes' })
    expect(edits[0]).toMatchObject({ action: 'group.ungrant', group: 'analytics', server: 'notes' })
  })

  test('an empty body is a 400', async () => {
    expect(asResponse(await handlers.groupsUngrant(emptyPost(session('owner')))).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /groups/join · leave
// ---------------------------------------------------------------------------

describe('POST /groups/join', () => {
  beforeEach(async () => {
    await groups.createGroup('analytics')
    await agents.createAgent('bot-a')
  })

  test('adds the member, attributes and journals it', async () => {
    const result = asResponse(
      await handlers.groupsJoin(postCtx({ group: 'analytics', agent: 'bot-a' }, session('owner'))),
    )

    expect(result.status).toBe(303)
    expect((await groups.getGroup('analytics'))?.members).toEqual(['bot-a'])
    expect(audit[0]).toMatchObject({ action: 'group.join', target: 'analytics/bot-a' })
    expect(edits[0]).toMatchObject({ action: 'group.join', group: 'analytics', agent: 'bot-a' })
  })

  test('an unknown agent is refused with a 400 and adds nobody', async () => {
    const result = asResponse(
      await handlers.groupsJoin(postCtx({ group: 'analytics', agent: 'nobody' }, session('owner'))),
    )
    expect(result.status).toBe(400)
    expect((await groups.getGroup('analytics'))?.members).toEqual([])
  })

  test('a revoked agent cannot be added — the group would hand it access back', async () => {
    await agents.createAgent('bot-gone')
    await agents.revokeAgent('bot-gone')

    const result = asResponse(
      await handlers.groupsJoin(postCtx({ group: 'analytics', agent: 'bot-gone' }, session('owner'))),
    )
    expect(result.status).toBe(400)
    expect(bodyOf(result)).toContain('revoked')
    expect((await groups.getGroup('analytics'))?.members).toEqual([])
    expect(edits).toEqual([])
  })

  test('an empty body is a 400', async () => {
    expect(asResponse(await handlers.groupsJoin(emptyPost(session('owner')))).status).toBe(400)
  })
})

describe('POST /groups/leave', () => {
  test('removes the member, attributes and journals it', async () => {
    await groups.createGroup('analytics')
    await agents.createAgent('bot-a')
    await groups.addMember('analytics', 'bot-a')

    const result = asResponse(
      await handlers.groupsLeave(postCtx({ group: 'analytics', agent: 'bot-a' }, session('owner'))),
    )

    expect(result.status).toBe(303)
    expect((await groups.getGroup('analytics'))?.members).toEqual([])
    expect(audit[0]).toMatchObject({ action: 'group.leave', target: 'analytics/bot-a' })
    expect(edits[0]).toMatchObject({ action: 'group.leave', group: 'analytics', agent: 'bot-a' })
  })

  test('an empty body is a 400', async () => {
    expect(asResponse(await handlers.groupsLeave(emptyPost(session('owner')))).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /groups/remove
// ---------------------------------------------------------------------------

describe('POST /groups/remove', () => {
  test('without confirm it shows the interstitial and removes nothing', async () => {
    await groups.createGroup('analytics')

    const result = asResponse(await handlers.groupsRemove(postCtx({ name: 'analytics' }, session('owner'))))

    expect(result.status).toBe(200)
    const body = bodyOf(result)
    expect(body).toContain('analytics')
    expect(body).toContain('name="confirm" value="true"')
    expect(await groups.getGroup('analytics')).toBeDefined()
    expect(audit).toEqual([])
  })

  test('confirming removes the group, attributes and journals it', async () => {
    await groups.createGroup('analytics')

    const result = asResponse(
      await handlers.groupsRemove(postCtx({ name: 'analytics', confirm: 'true' }, session('owner'))),
    )

    expect(result.status).toBe(303)
    expect(await groups.getGroup('analytics')).toBeUndefined()
    expect(audit[0]).toMatchObject({ action: 'group.remove', target: 'analytics' })
    expect(edits[0]).toMatchObject({ action: 'group.remove', group: 'analytics' })
  })

  test('a group with members is REFUSED with the member list and no confirm form', async () => {
    await groups.createGroup('analytics')
    await agents.createAgent('bot-a')
    await groups.addMember('analytics', 'bot-a')

    const result = asResponse(
      await handlers.groupsRemove(postCtx({ name: 'analytics', confirm: 'true' }, session('owner'))),
    )

    expect(result.status).toBe(200)
    const body = bodyOf(result)
    expect(body).toContain('bot-a')
    expect(body).not.toContain('name="confirm" value="true"')
    expect(await groups.getGroup('analytics')).toBeDefined()
    expect(audit).toEqual([])
    expect(edits).toEqual([])
  })

  test('an unknown group is a 404', async () => {
    const result = asResponse(
      await handlers.groupsRemove(postCtx({ name: 'ghosts', confirm: 'true' }, session('owner'))),
    )
    expect(result.status).toBe(404)
  })

  test('an empty body is a 400, never a 500', async () => {
    expect(asResponse(await handlers.groupsRemove(emptyPost(session('owner')))).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Journal containment
// ---------------------------------------------------------------------------

describe('the journal port cannot turn a completed write into a 500', () => {
  test('a rejecting journal writer still leaves the group created and redirects', async () => {
    const failing = createGroupsHandlers({
      groups,
      agents,
      registry,
      audit: (event) => audit.push(event),
      journalAccessEdit: async () => {
        throw new Error('journal unreachable')
      },
    })

    const result = asResponse(await failing.groupsCreate(postCtx({ name: 'analytics' }, session('owner'))))

    expect(result.status).toBe(303)
    expect(await groups.getGroup('analytics')).toBeDefined()
    expect(audit[0]).toMatchObject({ action: 'group.create' })
  })
})
