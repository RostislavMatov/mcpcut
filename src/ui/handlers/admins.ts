import { type AdminRole, isAdminRole } from '../../admin/constants.js'
import {
  AdminExistsError,
  AdminNotFoundError,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
  type AdminStore,
} from '../../admin/store.js'
import type { UiSession } from '../auth.js'
import {
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderAdminNotice, renderAdminsPage, renderAdminTokenOnce } from '../pages/admins.js'
import type { UiAuditSink } from './agents.js'
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
 */

export interface AdminsHandlersDeps {
  readonly adminStore: AdminStore
  readonly audit?: UiAuditSink
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
      return htmlResult(HTTP_STATUS_OK, renderAdminNotice({ message: `removed ${name}`, ok: true, session }))
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
      return htmlResult(HTTP_STATUS_OK, renderAdminNotice({ message: `set ${name} to ${role}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  return { adminsPage, adminsAdd, adminsRemove, adminsRotate, adminsRole }
}
