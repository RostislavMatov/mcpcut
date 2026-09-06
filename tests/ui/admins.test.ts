import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import {
  AdminsFileInvalidError,
  createAdminStore,
  type AdminRecord,
  type AdminStore,
} from '../../src/admin/store.js'
import type { AccessEditInfo } from '../../src/journal/access-edit-record.js'
import type { UiSession } from '../../src/ui/auth.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
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
let accessEdits: AccessEditInfo[]
let handlers: AdminsHandlers

beforeEach(async () => {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-admins-'))
  store = createAdminStore({ journalDir })
  audit = []
  accessEdits = []
  handlers = createAdminsHandlers({
    adminStore: store,
    audit: (event) => audit.push(event),
    journalAccessEdit: async (info) => {
      accessEdits.push(info)
      return { written: true }
    },
  })
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

describe('the access-edit record every admin mutation leaves (owner decision 2026-09-06)', () => {
  /** The actor of every record below: the signed-in admin of `session()`. */
  const actor = { adminName: 'alice', role: 'owner', via: 'ui' } as const

  test('add names the admin and the role given', async () => {
    await handlers.adminsAdd(postCtx({ name: 'carol', role: 'operator' }, session('owner', 'alice')))

    expect(accessEdits).toEqual([
      { actor, action: 'admin.add', admin: 'carol', targetRole: 'operator' },
    ])
  })

  test('rotate, role and remove each leave exactly one record', async () => {
    await store.createAdmin('bob', 'operator')

    await handlers.adminsRotate(postCtx({ name: 'bob' }, session('owner', 'alice')))
    await handlers.adminsRole(postCtx({ name: 'bob', role: 'viewer' }, session('owner', 'alice')))
    await handlers.adminsRemove(postCtx({ name: 'bob' }, session('owner', 'alice')))

    expect(accessEdits).toEqual([
      { actor, action: 'admin.rotate', admin: 'bob' },
      { actor, action: 'admin.role', admin: 'bob', targetRole: 'viewer' },
      { actor, action: 'admin.remove', admin: 'bob' },
    ])
  })

  test('the one-time token never reaches a record', async () => {
    await handlers.adminsAdd(postCtx({ name: 'carol', role: 'operator' }, session('owner', 'alice')))
    await handlers.adminsRotate(postCtx({ name: 'carol' }, session('owner', 'alice')))

    expect(JSON.stringify(accessEdits)).not.toContain('mcpa_')
  })

  test('reading the roster writes no record', async () => {
    await handlers.adminsPage(getCtx(session()))

    expect(accessEdits).toEqual([])
  })

  test('a refused mutation writes no record', async () => {
    await handlers.adminsRemove(postCtx({ name: 'owner-admin' }, session()))
    await handlers.adminsAdd(postCtx({ name: 'dave', role: 'superuser' }, session()))

    expect(accessEdits).toEqual([])
  })

  test('a writer answering written: false → the change stands and the notice carries the warning', async () => {
    const dropping = createAdminsHandlers({
      adminStore: store,
      journalAccessEdit: async () => ({ written: false }),
    })
    await store.createAdmin('bob', 'operator')

    const result = await dropping.adminsRole(postCtx({ name: 'bob', role: 'viewer' }, session()))

    if (result.kind === 'response') expect(result.status).toBe(200)
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(bodyOf(result)).toContain('class="notice ok ad-notice"')
    expect((await store.getActiveAdmin('bob'))?.role).toBe('viewer')
  })

  test('a journal port that rejects cannot turn a completed change into a 500', async () => {
    const failing = createAdminsHandlers({
      adminStore: store,
      journalAccessEdit: () => Promise.reject(new Error('journal sink is down')),
    })
    await store.createAdmin('bob', 'operator')

    const result = await failing.adminsRemove(postCtx({ name: 'bob' }, session()))

    if (result.kind === 'response') expect(result.status).toBe(200)
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(await store.getActiveAdmin('bob')).toBeUndefined()
  })

  test('a plane assembled without a journal port still applies the change, with no warning', async () => {
    const portless = createAdminsHandlers({ adminStore: store })
    await store.createAdmin('bob', 'operator')

    const result = await portless.adminsRemove(postCtx({ name: 'bob' }, session()))

    if (result.kind === 'response') expect(result.status).toBe(200)
    expect(bodyOf(result)).not.toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(await store.getActiveAdmin('bob')).toBeUndefined()
  })
})

describe('store failures are classified, not flattened to 400 (T-2)', () => {
  /** A store whose every mutation fails the way a broken plane fails. */
  function brokenStore(failure: Error): AdminStore {
    return {
      ...store,
      createAdmin: () => Promise.reject(failure),
      rotateAdmin: () => Promise.reject(failure),
      removeAdmin: () => Promise.reject(failure),
      setRole: () => Promise.reject(failure),
    } as AdminStore
  }

  test('an unrecognized store error is a detail-free 500, not a 400 echoing it', async () => {
    const secretish = 'ENOENT: /home/alice/.mcp-journal/admins.json.lock held by pid 4242'
    const failing = createAdminsHandlers({ adminStore: brokenStore(new Error(secretish)) })

    for (const result of [
      await failing.adminsAdd(postCtx({ name: 'bob', role: 'operator' }, session())),
      await failing.adminsRotate(postCtx({ name: 'bob' }, session())),
      await failing.adminsRemove(postCtx({ name: 'bob' }, session())),
      await failing.adminsRole(postCtx({ name: 'bob', role: 'viewer' }, session())),
    ]) {
      if (result.kind === 'response') expect(result.status).toBe(500)
      expect(bodyOf(result)).not.toContain(secretish)
      expect(bodyOf(result)).not.toContain('admins.json')
    }
  })

  test('a corrupt admins.json is infrastructure (500), not operator error (400)', async () => {
    const failing = createAdminsHandlers({
      adminStore: brokenStore(
        new AdminsFileInvalidError(new ZodError([{ code: 'custom', path: [], message: 'corrupt' }])),
      ),
    })
    const result = await failing.adminsAdd(postCtx({ name: 'bob', role: 'operator' }, session()))
    if (result.kind === 'response') expect(result.status).toBe(500)
  })

  test('known validation errors still yield a 400 carrying their message', async () => {
    await store.createAdmin('bob', 'operator')
    const duplicate = await handlers.adminsAdd(postCtx({ name: 'bob', role: 'operator' }, session()))
    if (duplicate.kind === 'response') expect(duplicate.status).toBe(400)
    expect(bodyOf(duplicate)).toMatch(/exists/i)

    const lastOwner = await handlers.adminsRemove(postCtx({ name: 'owner-admin' }, session()))
    if (lastOwner.kind === 'response') expect(lastOwner.status).toBe(400)
    expect(bodyOf(lastOwner)).toMatch(/owner/i)
  })
})

describe('McpCut admins page structure', () => {
  const admin = (name: string, role: AdminRecord['role'], extra: Partial<AdminRecord> = {}): AdminRecord =>
    ({ name, role, tokenHash: 'a'.repeat(64), createdAt: '2026-08-11T00:00:00.000Z', ...extra }) as AdminRecord

  test('the add form is a drawer above the roster, opened by the nav "+"', () => {
    const html = renderAdminsPage({ admins: [], session: session() })
    expect(html).toContain('<details class="drawer" id="add-admin">')
    expect(html).toContain('data-open-details="add-admin"')
    expect(html).toContain('action="/admins/add"')
    expect(html).toContain('0 admins')
    expect(html).toContain('no admins')
  })

  test('the roster is a table with pill roles, dates and the three per-admin actions', () => {
    const html = renderAdminsPage({
      admins: [admin('root', 'owner', { rotatedAt: '2026-08-12T00:00:00.000Z' }), admin('bob', 'viewer')],
      session: session(),
    })
    expect(html).toContain('2 admins')
    expect(html).toContain('<table class="admin-roster ad-roster">')
    expect(html).toMatch(/<tr data-admin="root">/)
    expect(html).toMatch(/<span class="pill pill-on ad-role">owner<\/span>/)
    expect(html).toMatch(/<span class="pill ad-role">viewer<\/span>/)
    expect(html).toContain('2026-08-12')
    expect(html).toMatch(/<span class="faint">—<\/span>/)
    expect(html).toContain('action="/admins/role"')
    expect(html).toContain('action="/admins/rotate"')
    expect(html).toContain('action="/admins/remove"')
    expect(html).toMatch(/<button type="submit" class="danger">Remove<\/button>/)
    expect(html).toMatch(/<option value="owner" selected>owner<\/option>/)
  })

  test('the add form offers the role vocabulary as pill radios, operator preselected', () => {
    const html = renderAdminsPage({ admins: [], session: session() })
    expect(html).toMatch(/<input type="radio" name="role" value="operator" checked>/)
    expect(html).toMatch(/<input type="radio" name="role" value="owner">/)
    expect(html).toMatch(/<input type="radio" name="role" value="viewer">/)
  })

  test('the token-once page keeps the data-token box and the warning callout', async () => {
    const added = bodyOf(await handlers.adminsAdd(postCtx({ name: 'dora', role: 'viewer' }, session())))
    expect(added).toMatch(/<pre class="token" data-token>mcpa_[^<]+<\/pre>/)
    expect(added).toContain('class="callout"')
    expect(added).toContain('class="panel panel-strong')
  })

  test('notices keep the ok / error semantics', async () => {
    const bad = bodyOf(await handlers.adminsRemove(postCtx({ name: 'ghost' }, session())))
    expect(bad).toContain('class="notice error')
  })
})
