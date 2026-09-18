import type { AccessEditInfo } from '../../journal/record.js'
import { AUDIT_RECORD_DROPPED_WARNING, HTTP_STATUS_OK } from '../constants.js'
import { renderNotice } from '../pages/notice.js'
import type { UiRequestContext, UiResult } from '../routes.js'
import type { AccessEditJournalOutcome, AccessEditJournalPort } from './agents.js'
import { redirect } from './request-helpers.js'

/**
 * The journal half shared by the three registry mutations of the servers
 * surface — add, edit, remove (owner decision 2026-09-18: registering or
 * re-pointing a server is the same category of fact as removing one, and the
 * stderr audit line alone never reaches an exported report).
 *
 * The invariant both functions hold: when they run, the registry write has
 * LANDED. Nothing here may turn that into a 500 or hide that its record was
 * lost — a journal that cannot be reached answers as a dropped record, and a
 * dropped record is shown on the admin's success page (audit F1).
 */

/** What the change says about itself; the actor is read off the request. */
export type ServerChangeFacts = Omit<AccessEditInfo, 'actor'>

/**
 * Records one servers-surface change in the journal and says whether the
 * record landed. The injected writer never throws by contract
 * (`groups/journal-access-edit.ts` returns a drop indicator instead), and this
 * guard keeps that true for ANY injected port — a port that threw has not
 * written either, so it answers as a drop. No port at all is the composition
 * root's choice, not a lost record.
 */
export async function journalServerChange(
  write: AccessEditJournalPort | undefined,
  ctx: UiRequestContext,
  facts: ServerChangeFacts,
): Promise<AccessEditJournalOutcome> {
  if (write === undefined) return { written: true }
  const info: AccessEditInfo = {
    actor: {
      adminName: ctx.session?.adminName ?? null,
      role: ctx.session?.role ?? null,
      via: 'ui',
    },
    ...facts,
  }
  try {
    const { written } = await write(info)
    return { written }
  } catch {
    // Contained, not swallowed: the audit sink already recorded the attributed
    // change, the writer's own diagnostics report the fault, and the verdict
    // puts it on the admin's success page.
    return { written: false }
  }
}

/**
 * The answer once the change is done: the plain 303 when the audit record
 * landed, the success notice carrying the F1 warning when it was dropped — the
 * change stands either way, so never an error status. The notice needs the
 * signed-in admin for its layout; the route table guarantees one, and the
 * session-less shape (impossible in production, the context type merely
 * allows it) keeps the redirect rather than rendering a page under a
 * fabricated identity.
 */
export function serverChangeApplied(
  ctx: UiRequestContext,
  message: string,
  journal: AccessEditJournalOutcome,
): UiResult {
  const session = ctx.session
  if (journal.written || session === undefined) return redirect('/servers')
  const body = renderNotice({
    title: 'Servers',
    message,
    ok: true,
    backHref: '/servers',
    backLabel: 'Back to servers',
    session,
    warning: AUDIT_RECORD_DROPPED_WARNING,
  })
  return { kind: 'response', status: HTTP_STATUS_OK, body }
}
