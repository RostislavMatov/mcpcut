import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminRecord, type AdminStore } from '../../src/admin/store.js'
import type { UiSession } from '../../src/ui/auth.js'
import type { UiAuditEvent } from '../../src/ui/handlers/agents.js'
import { createAdminsHandlers, type AdminsHandlers } from '../../src/ui/handlers/admins.js'
import { renderAdminsPage } from '../../src/ui/pages/admins.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * M4 Task 14 — admin management (owner-only): page + add/remove/rotate/role.
 * Exercised through the injectable factory `createAdminsHandlers` against the
 * real `admin/store.ts` (which owns the last-owner guard and, via token-hash /
 * role / revoked re-validation, the session-invalidation guarantee).
 */

function session(role: UiSession['role'] = 'owner', adminName = 'owner-admin'): UiSession {
  return { adminName, role, csrfToken: 'csrf-token-value-abcdef' }
}

function postCtx(form: Record<string, string>, sess: UiSession | undefined): UiRequestContext {
  const body = Buffer.from(new URLSearchParams(form).toString(), 'utf8')
  return {
    method: 'POST',
    path: '/admins/action',
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
    path: '/admins',
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
let store: AdminStore
let audit: UiAuditEvent[]
let handlers: AdminsHandlers

beforeEach(async () => {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-admins-'))
  store = createAdminStore({ journalDir })
  audit = []
  handlers = createAdminsHandlers({ adminStore: store, audit: (event) => audit.push(event) })
  // A baseline owner so the roster is never empty and last-owner rules apply.
  await store.createAdmin('owner-admin', 'owner')
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

describe('admin roster rendering', () => {
  test('lists name, role and dates but never a token hash', async () => {
    const html = bodyOf(await handlers.adminsPage(getCtx(session())))
    expect(html).toContain('owner-admin')
    expect(html).toContain('owner')
    const full = await store.getActiveAdmin('owner-admin')
    expect(full?.tokenHash.length).toBe(64)
    expect(html).not.toContain(full?.tokenHash)
  })

  test('hostile admin names are HTML-escaped, not executable', () => {
    const evil: AdminRecord = {
      name: 'evil<script>',
      role: 'operator',
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-08-11T00:00:00.000Z',
    } as AdminRecord
    const html = renderAdminsPage({ admins: [evil], session: session() })
    expect(html).not.toContain('<script>')
    expect(html).toContain('evil&lt;script&gt;')
  })

  test('forms embed the per-session CSRF token', async () => {
    const html = bodyOf(await handlers.adminsPage(getCtx(session())))
    expect(html).toContain('name="csrf_token"')
    expect(html).toContain('csrf-token-value-abcdef')
  })
})

describe('add issues a one-time token', () => {
  test('add shows the token once and never persists it', async () => {
    const added = bodyOf(await handlers.adminsAdd(postCtx({ name: 'carol', role: 'operator' }, session())))
    expect(added).toContain('carol')
    expect(added).toMatch(/shown once/i)

    const match = added.match(/data-token>([^<]+)</)
    expect(match).not.toBeNull()
    const token = (match as RegExpMatchArray)[1] as string
    expect(token.startsWith('mcpa_')).toBe(true)

    const reload = bodyOf(await handlers.adminsPage(getCtx(session())))
    expect(reload).not.toContain(token)
    const stored = await store.getActiveAdmin('carol')
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(JSON.stringify(audit)).not.toContain(token)
  })

  test('rotate also reveals a fresh token once', async () => {
    await store.createAdmin('bob', 'operator')
    const rotated = bodyOf(await handlers.adminsRotate(postCtx({ name: 'bob' }, session())))
    expect(rotated).toMatch(/shown once/i)
    expect(rotated).toContain('mcpa_')
  })

  test('an invalid role is refused with a readable 400', async () => {
    const result = await handlers.adminsAdd(postCtx({ name: 'dave', role: 'superuser' }, session()))
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/invalid role/i)
  })
})

describe('remove / role go through the store (kills sessions) with last-owner guard', () => {
  test('remove marks the admin revoked in the store', async () => {
    await store.createAdmin('bob', 'operator')
    await handlers.adminsRemove(postCtx({ name: 'bob' }, session()))
    expect(await store.getActiveAdmin('bob')).toBeUndefined()
  })

  test('role change is written through the store', async () => {
    await store.createAdmin('bob', 'operator')
    await handlers.adminsRole(postCtx({ name: 'bob', role: 'viewer' }, session()))
    expect((await store.getActiveAdmin('bob'))?.role).toBe('viewer')
  })

  test('removing the last owner is refused with a clear message, not a 500', async () => {
    const result = await handlers.adminsRemove(postCtx({ name: 'owner-admin' }, session()))
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/owner/i)
    // The owner is still active — the system was not locked out.
    expect(await store.getActiveAdmin('owner-admin')).toBeDefined()
  })

  test('demoting the last owner is refused with a clear message', async () => {
    const result = await handlers.adminsRole(postCtx({ name: 'owner-admin', role: 'viewer' }, session()))
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/owner/i)
    expect((await store.getActiveAdmin('owner-admin'))?.role).toBe('owner')
  })

  test('an action on a nonexistent admin yields a readable 400', async () => {
    const result = await handlers.adminsRotate(postCtx({ name: 'ghost' }, session()))
    if (result.kind === 'response') expect(result.status).toBe(400)
    expect(bodyOf(result)).toMatch(/does not exist/i)
  })
})

describe('attribution', () => {
  test('every successful mutation is attributed to actor "ui" + admin name', async () => {
    await store.createAdmin('bob', 'operator')
    await handlers.adminsRole(postCtx({ name: 'bob', role: 'viewer' }, session('owner', 'alice')))
    expect(audit).toContainEqual({ actor: 'ui', adminName: 'alice', action: 'admins.role', target: 'bob:viewer' })
  })
})
