import type { UiSession } from '../auth.js'
import { html, safeUrl } from '../html.js'
import { renderLayout, type CurrentAdmin } from './layout.js'

/**
 * The shared "the action succeeded / could not be completed" page.
 *
 * It is the generalisation of what was `renderAgentNotice` (`pages/agents.ts`):
 * the same markup, with the page it returns to made a parameter so `/groups`
 * (M5.5 п.2) and `/agents` render one notice, not two that drift. Every value
 * is untrusted for render and goes through the escaping `html` template.
 */

/** Nav identity for the shared layout (both fields escaped downstream). */
function currentAdmin(session: UiSession): CurrentAdmin {
  return { name: session.adminName, role: session.role }
}

/**
 * Page-family class per back-link, so a notice keeps the padding and spacing
 * of the page it belongs to without every caller having to name it. A caller
 * may still pass `noticeClass` explicitly; an unknown href simply gets none.
 */
const NOTICE_CLASS_BY_HREF: Readonly<Record<string, string>> = {
  '/agents': 'ag-notice',
  '/admins': 'ad-notice',
  '/groups': 'gr-notice',
}

/**
 * The family class for `backHref`, or `''`. The `Object.hasOwn` guard is not
 * decoration: a plain object literal inherits `constructor`, `toString` and
 * friends, so an unguarded lookup for a caller-supplied href named after one
 * of them yields a FUNCTION, which then gets stringified into the class
 * attribute. Own properties only, always.
 */
function noticeClassOf(backHref: string): string {
  return Object.hasOwn(NOTICE_CLASS_BY_HREF, backHref) ? (NOTICE_CLASS_BY_HREF[backHref] ?? '') : ''
}

/** Nav key of the page the notice belongs to (`/groups` → `groups`). */
function navKeyOf(backHref: string): string | undefined {
  const key = backHref.replace(/^\//, '').split(/[/?#]/)[0] ?? ''
  return key === '' ? undefined : key
}

export interface NoticeView {
  /** Document title, e.g. `Groups` or `Groups — error`. */
  readonly title: string
  readonly message: string
  readonly ok: boolean
  /** Where "back" goes — also what picks the nav tab and the family class. */
  readonly backHref: string
  readonly backLabel: string
  readonly session: UiSession
  /** Optional override of the page-family class (see `NOTICE_CLASS_BY_HREF`). */
  readonly noticeClass?: string
  /**
   * A caveat under the message of a SUCCESS notice — today only "applied, but
   * its audit record was dropped" (`AUDIT_RECORD_DROPPED_WARNING`, audit F1).
   * Rendered as its own `role="alert"` paragraph so assistive tech announces
   * it and it cannot be read as part of the message. It never flips `ok`: the
   * change the notice reports has happened, the warning qualifies the evidence.
   */
  readonly warning?: string
}

/** A success/failure notice with a link back to the page that raised it. */
export function renderNotice(view: NoticeView): string {
  const noticeClass = view.noticeClass ?? noticeClassOf(view.backHref)
  const activeNav = navKeyOf(view.backHref)
  const warning =
    view.warning === undefined ? '' : html`<p class="notice-warning" role="alert">${view.warning}</p>`
  const content = html`<section class="notice ${view.ok ? 'ok' : 'error'} ${noticeClass}" role="status">
    <h1>${view.ok ? 'Done' : 'Could not complete the action'}</h1>
    <p>${view.message}</p>
    ${warning}
    <p><a href="${safeUrl(view.backHref)}">${view.backLabel}</a></p>
  </section>`
  return renderLayout({
    title: view.title,
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: currentAdmin(view.session),
    ...(activeNav !== undefined ? { activeNav } : {}),
  })
}
