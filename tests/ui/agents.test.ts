import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import type { UiSession } from '../../src/ui/auth.js'
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

function bodyOf(result: UiResult): string {
  if (result.kind !== 'response') throw new Error('expected a buffered response, got a stream')
  return String(result.body ?? '')
}

let journalDir: string
let store: AgentsStore
let audit: UiAuditEvent[]
let handlers: AgentsHandlers

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-agents-'))
  store = createAgentsStore({ journalDir })
  audit = []
  handlers = createAgentsHandlers({ agentsStore: store, audit: (event) => audit.push(event) })
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

    const html = bodyOf(await handlers.agentsPage(getCtx(session('operator'))))

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

    const html = renderAgentsPage({ agents: [evil], session: session('operator') })

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
      postCtx({ agent: 'bot', server: 'github', tools: 'create_issue', csrf_token: 'x' }, session('operator')),
    )
    expect(granted.kind).toBe('response')

    const stored = await store.getAgent('bot')
    expect(stored?.grants.github).toEqual({ tools: ['create_issue'] })

    const html = bodyOf(await handlers.agentsPage(getCtx(session('operator'))))
    expect(html).toContain('github')
    expect(html).toContain('create_issue')
  })

  test('a lone * grants everything; resources/prompts stay unset when blank', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'gh', tools: '*' }, session('operator')))

    const stored = await store.getAgent('bot')
    expect(stored?.grants.gh).toEqual({ tools: '*' })
  })

  test('ungrant removes the grant', async () => {
    await store.createAgent('bot')
    await store.grantServer('bot', 'github', ['create_issue'])

    await handlers.agentsUngrant(postCtx({ agent: 'bot', server: 'github' }, session('operator')))

    const stored = await store.getAgent('bot')
    expect(stored?.grants.github).toBeUndefined()
  })

  test('revoke is a single action reflected in the store and UI', async () => {
    await store.createAgent('bot')

    const result = await handlers.agentsRevoke(postCtx({ agent: 'bot' }, session('operator')))
    expect(result.kind).toBe('response')

    const stored = await store.getAgent('bot')
    expect(stored?.revokedAt).toBeDefined()
    const html = bodyOf(await handlers.agentsPage(getCtx(session('operator'))))
    expect(html).toContain('revoked')
  })

  test('a concurrent CLI edit is not lost (store lock serializes writes)', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'ui-server', tools: 'a' }, session('operator')))
    // A separate store instance == a separate process editing the same file.
    const cli = createAgentsStore({ journalDir })
    await cli.grantServer('bot', 'cli-server', ['b'])

    const stored = await store.getAgent('bot')
    expect(Object.keys(stored?.grants ?? {}).sort()).toEqual(['cli-server', 'ui-server'])
  })
})

describe('create issues a one-time token', () => {
  test('create shows the token once with a warning and never persists it', async () => {
    const created = await handlers.agentsCreate(postCtx({ name: 'research-bot' }, session('operator')))
    const revealed = bodyOf(created)
    expect(revealed).toContain('research-bot')
    expect(revealed).toMatch(/shown once/i)

    // Extract the plaintext token from the reveal page.
    const match = revealed.match(/data-token>([^<]+)</)
    expect(match).not.toBeNull()
    const token = (match as RegExpMatchArray)[1] as string
    expect(token.length).toBeGreaterThan(20)

    // Marker: the token is absent from a subsequent page load...
    const reload = bodyOf(await handlers.agentsPage(getCtx(session('operator'))))
    expect(reload).not.toContain(token)
    // ...from the store (only the hash is kept)...
    const stored = await store.getAgent('research-bot')
    expect(JSON.stringify(stored)).not.toContain(token)
    // ...and from the attribution audit trail.
    expect(JSON.stringify(audit)).not.toContain(token)
  })

  test('the end-to-end "issue a scoped key" flow works from the panel', async () => {
    await handlers.agentsCreate(postCtx({ name: 'scoped-bot' }, session('operator')))
    await handlers.agentsGrant(
      postCtx({ agent: 'scoped-bot', server: 'github', tools: 'read_*' }, session('operator')),
    )
    const stored = await store.getAgent('scoped-bot')
    expect(stored?.grants).toEqual({ github: { tools: ['read_*'] } })
  })
})

describe('error handling and attribution', () => {
  test('an action on a nonexistent agent yields a readable 400, not a 500', async () => {
    const result = await handlers.agentsGrant(
      postCtx({ agent: 'ghost', server: 'github', tools: 'x' }, session('operator')),
    )
    expect(result.kind).toBe('response')
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/does not exist/i)
  })

  test('every successful mutation is attributed to actor "ui" + admin name', async () => {
    await store.createAgent('bot')
    await handlers.agentsGrant(postCtx({ agent: 'bot', server: 'gh', tools: 'a' }, session('operator', 'alice')))

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
    const html = bodyOf(await handlers.agentsPage(getCtx(session('operator'))))
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
