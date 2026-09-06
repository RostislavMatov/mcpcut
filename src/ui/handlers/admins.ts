import { type AdminRole, isAdminRole } from '../../admin/constants.js'
import {
  AdminExistsError,
  AdminNotFoundError,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
  type AdminStore,
} from '../../admin/store.js'
import type { AccessEditInfo } from '../../journal/access-edit-record.js'
import type { UiSession } from '../auth.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderAdminNotice, renderAdminsPage, renderAdminTokenOnce } from '../pages/admins.js'
import { renderNotice } from '../pages/notice.js'
import type { AccessEditJournalOutcome, AccessEditJournalPort, UiAuditSink } from './agents.js'
import { internalErrorResult, isKnownStoreError, type ErrorClass } from './store-errors.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'

/**
 * Owner-only admin-management action handlers (M4 Task 14). The route table
 * pins every `/admins*` route to `owner` and the server enforces it before
 * these run, so no role check is repeated here. Each handler adapts an
 * untrusted form body to `admin/store.ts`, whose last-owner guard and session
 * invalidation (via token-hash/role/revoked re-validation) are the real
 * enforcement — a demote/remove/rotate that reaches the store ends that admin's
 * live sessions. The last-owner guard surfaces as a readable notice, not a 500,
 * and add/rotate reveal the plaintext token exactly once.
 *
 * Since the owner decision of 2026-09-06 every successful mutation also
 * writes an `access-edit` journal record through the same port the agent and
 * group handlers use, so "who made this admin" is answered by one record
 * category whether the change came from the browser or from a shell. The
 * stderr audit line stays: it is what an operator watching the process sees
 * even when the journal cannot be reached.
 */

export interface AdminsHandlersDeps {
  readonly adminStore: AdminStore
  readonly audit?: UiAuditSink
  /**
   * Journal port for admin changes (owner decision 2026-09-06), injected by
   * `cli/ui-wiring.ts` — the same port the agent and group handlers take.
   * Optional: without it an edit still happens and is still attributed on the
   * audit sink, it simply leaves no journal record.
   *
   * The one-time token of `createAdmin`/`rotateAdmin` has NO field in
   * `AccessEditInfo` and must never acquire one: the record says an admin was
   * created or rotated, never with what key.
   */
  readonly journalAccessEdit?: AccessEditJournalPort
}

export interface AdminsHandlers {
  readonly adminsPage: UiHandler
  readonly adminsAdd: UiHandler
  readonly adminsRemove: UiHandler
  readonly adminsRotate: UiHandler
  readonly adminsRole: UiHandler
}

function htmlResult(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}

const FORBIDDEN: UiResult = { kind: 'response', status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN }

function fields(ctx: UiRequestContext): Readonly<Record<string, string>> {
  return parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
}

/**
 * Admin-store errors caused by what the operator typed. `AdminsFileInvalidError`
 * is deliberately ABSENT: a corrupt `admins.json` is a broken plane, not a bad
 * form, and must not be reported as the operator's mistake.
 */
const ADMIN_INPUT_ERRORS: readonly ErrorClass[] = [
  AdminExistsError,
  AdminNotFoundError,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
]

/**
 * Renders a store failure: a known input fault as a readable 400 notice,
 * anything else as the detail-free 500 the server's catch-all would have given.
 */
function storeFailure(error: unknown, session: UiSession): UiResult {
  if (!isKnownStoreError(error, ADMIN_INPUT_ERRORS)) return internalErrorResult()
  const message = error instanceof Error ? error.message : 'unexpected error'
  return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message, ok: false, session }))
}

export function createAdminsHandlers(deps: AdminsHandlersDeps): AdminsHandlers {
  const { adminStore, audit } = deps

  function record(session: UiSession, action: string, target: string): void {
    audit?.({ actor: 'ui', adminName: session.adminName, action, target })
  }

  /**
   * Records one admin change in the journal and says whether the record
   * landed. Same shape and same ordering as `handlers/agents.ts`: the store
   * write has already happened, so a journal that cannot be reached must not
   * turn it into a 500 — a port that threw has not written either, so it
   * answers as a drop. No port at all is the composition root's choice, not a
   * record that was lost, and earns no warning.
   */
  async function journal(
    session: UiSession,
    info: Omit<AccessEditInfo, 'actor'>,
  ): Promise<AccessEditJournalOutcome> {
    const write = deps.journalAccessEdit
    if (write === undefined) return { written: true }
    try {
      const { written } = await write({
        actor: { adminName: session.adminName, role: session.role, via: 'ui' },
        ...info,
      })
      return { written }
    } catch {
      // Contained, not swallowed: the audit sink above already recorded the
      // attributed edit, the writer's own diagnostics report the fault, and
      // the verdict below puts it on the admin's success page.
      return { written: false }
    }
  }

  /**
   * The success notice, carrying the F1 warning line when the audit record
   * was dropped. Rendered through the shared `renderNotice` rather than
   * `renderAdminNotice` because only the shared page has the warning slot;
   * with `backHref: '/admins'` it yields the same section, class and nav tab.
   */
  function applied(
    session: UiSession,
    message: string,
    journaled: AccessEditJournalOutcome,
  ): UiResult {
    return htmlResult(
      HTTP_STATUS_OK,
      renderNotice({
        title: 'Admins',
        message,
        ok: true,
        backHref: '/admins',
        backLabel: 'Back to admins',
        session,
        ...(journaled.written ? {} : { warning: AUDIT_RECORD_DROPPED_WARNING }),
      }),
    )
  }

  async function adminsPage(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const admins = await adminStore.listAdmins()
    return htmlResult(HTTP_STATUS_OK, renderAdminsPage({ admins, session }))
  }

  async function adminsAdd(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fields(ctx)
    const name = form.name?.trim() ?? ''
    const role = form.role?.trim() ?? ''
    if (name === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: 'admin name is required', ok: false, session }))
    }
    if (!isAdminRole(role)) {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: `invalid role "${role}"`, ok: false, session }))
    }
    try {
      const created = await adminStore.createAdmin(name, role)
      record(session, 'admins.add', name)
      // `created.token` is deliberately NOT passed on: the record says the
      // admin exists, the reveal page is the only place the token is
      // rendered. That page has no warning slot, so a dropped `admin.add`
      // record is reported on the process's stderr only — the reveal cannot
      // be swapped for a notice without losing the one-time token.
      await journal(session, { action: 'admin.add', admin: created.admin.name, targetRole: role })
      return htmlResult(HTTP_STATUS_OK, renderAdminTokenOnce({ admin: created.admin.name, token: created.token, action: 'created', session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  async function adminsRotate(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const name = fields(ctx).name?.trim() ?? ''
    if (name === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: 'admin name is required', ok: false, session }))
    }
    try {
      const rotated = await adminStore.rotateAdmin(name)
      record(session, 'admins.rotate', name)
      // Same reveal, same reason as `add` above: no warning slot on the page
      // that carries the one-time token.
      await journal(session, { action: 'admin.rotate', admin: rotated.admin.name })
      return htmlResult(HTTP_STATUS_OK, renderAdminTokenOnce({ admin: rotated.admin.name, token: rotated.token, action: 'rotated', session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  async function adminsRemove(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const name = fields(ctx).name?.trim() ?? ''
    if (name === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: 'admin name is required', ok: false, session }))
    }
    try {
      await adminStore.removeAdmin(name)
      record(session, 'admins.remove', name)
      const journaled = await journal(session, { action: 'admin.remove', admin: name })
      return applied(session, `removed ${name}`, journaled)
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  async function adminsRole(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fields(ctx)
    const name = form.name?.trim() ?? ''
    const role = form.role?.trim() ?? ''
    if (name === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: 'admin name is required', ok: false, session }))
    }
    if (!isAdminRole(role)) {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAdminNotice({ message: `invalid role "${role}"`, ok: false, session }))
    }
    return applyRole(session, name, role)
  }

  async function applyRole(session: UiSession, name: string, role: AdminRole): Promise<UiResult> {
    try {
      await adminStore.setRole(name, role)
      record(session, 'admins.role', `${name}:${role}`)
      const journaled = await journal(session, { action: 'admin.role', admin: name, targetRole: role })
      return applied(session, `set ${name} to ${role}`, journaled)
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  return { adminsPage, adminsAdd, adminsRemove, adminsRotate, adminsRole }
}
