import type { CurrentAdmin } from '../pages/layout.js'
import { headerValue, parseBodyFields, type UiRequestContext, type UiResult } from '../routes.js'
import { HTTP_STATUS_SEE_OTHER } from '../constants.js'

/**
 * The four one-liners every form handler in this directory needs: the session
 * as the layout's nav model, its CSRF token, the parsed body, and a 303 back
 * to the page. They lived as private copies in `handlers/servers.ts`, and the
 * removal handler's move into its own module (U4) would have made a second
 * copy — which is how two spellings of "the empty session renders as what?"
 * get to disagree.
 */

/** The signed-in admin as the layout's untrusted-for-render nav model. */
export function currentAdminOf(ctx: UiRequestContext): CurrentAdmin {
  return { name: ctx.session?.adminName ?? '', role: ctx.session?.role ?? '' }
}

export function csrfTokenOf(ctx: UiRequestContext): string {
  return ctx.session?.csrfToken ?? ''
}

/** The request body as form fields, per its own content type. */
export function fieldsOf(ctx: UiRequestContext): Readonly<Record<string, string>> {
  return parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
}

export function redirect(location: string): UiResult {
  return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location } }
}
