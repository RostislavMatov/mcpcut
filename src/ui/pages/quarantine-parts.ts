import { html, join, type Html } from '../html.js'
import type { QuarantineCardView } from './quarantine.js'

/**
 * The quarantine card (McpCut front): the sibling of the approval card in
 * `approval-queue.ts`. Head row (server/tool · state · surfaceDelta · first
 * seen), the tool's description, the structural schema diff as a bordered
 * row list, and the approve/reject forms.
 *
 * Two places here deliberately REFUSE to look confident:
 *  - a description longer than `DESCRIPTION_MAX_CHARS` is cut and carries a
 *    visible `… (truncated)` marker — a hostile server may stuff kilobytes of
 *    prose here, and an operator must never mistake a cut-off for the whole;
 *  - a truncated diff gets an alert pill plus a sentence saying the change
 *    list is incomplete. This is the M5 lesson: a truncated schema diff that
 *    read as "confident" let a hostile server hold onto a stale `allow`.
 */

/** Description length beyond which the text is cut and marked (untrusted server prose). */
const DESCRIPTION_MAX_CHARS = 280

/** `2026-08-11T12:34:56.000Z` → `2026-08-11 12:34`; anything else is shown verbatim. */
function shortStamp(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts) ? `${ts.slice(0, 10)} ${ts.slice(11, 16)}` : ts
}

function renderStatePill(state: QuarantineCardView['state']): Html {
  if (state === 'new') {
    return html`<span class="pill pill-on qr-state qr-state-new"><span class="dot dot-s dot-blink"></span>new</span>`
  }
  return html`<span class="pill qr-state qr-state-changed">changed</span>`
}

/** The surfaceDelta verdict; `widened` is the dangerous direction and is alert-styled. */
function renderDeltaPill(card: QuarantineCardView): Html {
  if (card.surfaceDelta === undefined) return html``
  const alert = card.surfaceDelta === 'widened' ? ' pill-alert' : ''
  return html`<span class="pill${alert} surface-delta surface-delta-${card.surfaceDelta}">surfaceDelta: ${card.surfaceDelta}</span>`
}

/** The description, cut with an explicit marker when over the bound. */
function renderDescription(card: QuarantineCardView): Html {
  if (card.description === undefined) return html``
  // Cut by code point, not UTF-16 unit, so the marker never lands inside a
  // surrogate pair (same rule as `servers-parts.ts`).
  const points = Array.from(card.description)
  if (points.length <= DESCRIPTION_MAX_CHARS) {
    return html`<p class="qr-desc description pretty">${card.description}</p>`
  }
  const cut = points.slice(0, DESCRIPTION_MAX_CHARS).join('')
  return html`<p class="qr-desc description pretty">${cut} <span class="pill pill-alert qr-trunc">… (truncated)</span></p>`
}

function renderChangeRow(change: QuarantineCardView['changes'][number]): Html {
  return html`<div class="qr-change change change-${change.kind}"><code>${change.path}</code><span class="label">${change.kind}</span></div>`
}

/** The explicit, loud truncation row — never a quiet footnote. */
function renderTruncatedRow(): Html {
  return html`<div class="qr-change qr-change-truncated change-truncated">
      <span class="pill pill-alert">diff truncated</span>
      <span class="small">schema too deep or large — the change list above is incomplete; do not read it as the whole surface</span>
    </div>`
}

function renderChanges(card: QuarantineCardView): Html {
  if (card.changes.length === 0) {
    const note = card.state === 'new' ? 'New tool — no prior schema to diff.' : 'No structural change detected.'
    return html`<div class="rows qr-diff"><div class="empty no-diff">${note}</div></div>`
  }
  const rows = card.changes.map(renderChangeRow)
  const truncated = card.truncated ? renderTruncatedRow() : html``
  return html`<div class="rows qr-diff schema-diff">${join(rows)}${truncated}</div>`
}

/**
 * One approve/reject control. `action=` and `data-action=` carry the SAME full
 * path — see the note in `pages/approval-queue.ts`: the client script fetches
 * the `data-action` value verbatim, so a bare verb is a dead button. Pinned by
 * `tests/ui/page-contracts.test.ts`.
 */
function renderActionForm(
  card: QuarantineCardView,
  action: string,
  label: string,
  csrfToken: string,
  buttonClass: string,
): Html {
  const target = `/quarantine/${action}`
  return html`<form method="post" action="${target}" data-action="${target}">
    <input type="hidden" name="csrf_token" value="${csrfToken}" />
    <input type="hidden" name="server" value="${card.serverName}" />
    <input type="hidden" name="tool" value="${card.toolName}" />
    <button type="submit" class="${buttonClass}">${label}</button>
  </form>`
}

/** One quarantined tool as a card; `data-server`/`data-tool` are the row identity. */
export function renderQuarantineCard(card: QuarantineCardView, csrfToken: string): Html {
  return html`<article class="quarantine-card qr-card row-in" data-server="${card.serverName}" data-tool="${card.toolName}">
    <div class="qr-head">
      <span class="qr-tool pixel ellipsis"><span class="server">${card.serverName}</span>/<span class="tool-name">${card.toolName}</span></span>
      ${renderStatePill(card.state)}
      ${renderDeltaPill(card)}
      <span class="qr-seen muted small num" title="${card.firstSeenAt}">first seen ${shortStamp(card.firstSeenAt)}</span>
    </div>
    ${renderDescription(card)}
    ${renderChanges(card)}
    <div class="actions">
      ${renderActionForm(card, 'approve', 'Approve', csrfToken, 'approve')}
      ${renderActionForm(card, 'reject', 'Reject', csrfToken, 'secondary')}
    </div>
  </article>`
}
