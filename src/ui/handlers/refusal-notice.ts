import { CONTENT_TYPE_HTML } from '../constants.js'
import { renderNotice } from '../pages/notice.js'
import type { UiRequestContext, UiResult } from '../routes.js'

/**
 * A refused form post a person can act on (owner's rule 2026-09-29): what
 * happened in one line and the link back to the list the form came from,
 * rendered as the shared notice page. It replaces bare bodies such as
 * `unknown server`, which a browser showed as plain text on a blank page with
 * no way on. The status stays what it was (404 or 400), and the message never
 * carries internals — it is one of the fixed sentences below.
 *
 * The session-less shape is impossible behind the route table (the context
 * type merely allows it); it keeps the plain-text body rather than render a
 * page under a fabricated identity, as `serverChangeApplied` does.
 */

/** Where a refusal leads back to: the list the refused form lives on. */
export interface RefusalTarget {
  readonly title: string
  readonly backHref: string
  readonly backLabel: string
}

export const SERVERS_LIST: RefusalTarget = {
  title: 'Servers — error',
  backHref: '/servers',
  backLabel: 'Back to servers',
}

export const GROUPS_LIST: RefusalTarget = {
  title: 'Groups — error',
  backHref: '/groups',
  backLabel: 'Back to groups',
}

export const UNKNOWN_SERVER_MESSAGE = 'That server is not registered — it may have been removed already.'
export const MISSING_SERVER_NAME_MESSAGE = "The form did not name a server — use the button on the server's card."
export const UNKNOWN_GROUP_MESSAGE = 'That group does not exist — it may have been removed already.'

export function refusalNotice(
  ctx: UiRequestContext,
  status: number,
  message: string,
  target: RefusalTarget,
): UiResult {
  const session = ctx.session
  if (session === undefined) return { kind: 'response', status, body: message }
  const body = renderNotice({
    title: target.title,
    message,
    ok: false,
    backHref: target.backHref,
    backLabel: target.backLabel,
    session,
  })
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}
