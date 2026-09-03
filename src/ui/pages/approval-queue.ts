import type { ToolClass } from '../../policy/schema.js'
import type { PendingApproval } from '../../policy/approvals/queue.js'
import { renderToolName } from '../display-name.js'
import { html, join, type Html } from '../html.js'
import type { CurrentAdmin } from './layout.js'

/**
 * The approval queue (M4 Task 12) — the region where the milestone gate is
 * measured: an operator approves/denies a write call before the agent's own
 * wait window closes. Since the McpCut redesign the queue is one panel of the
 * dashboard served at `/` (`pages/dashboard.ts`); this module owns the cards,
 * the live region and its count line, and nothing outside them. Every field shown here (agent, server, tool, redacted
 * args) is untrusted server/disk content and reaches markup only through the
 * escaping `html` template.
 *
 * The card separates two clocks the operator MUST not confuse:
 *  - the agent's remaining WAIT (`waitExpiresAt`): while > 0 an approval
 *    delivers the call NOW; at 0 the agent has given up and an approval only
 *    mints a grant for a retry;
 *  - the GRANT window (`expiresAt`): how long a fresh approval stays usable.
 */

/** Batch ("approve all") is only ever offered for the read class (ADR-0004 §Границы). */
const BATCH_ELIGIBLE_CLASS: ToolClass = 'read'

/** A single pending approval, projected for display. */
export interface ApprovalCardView {
  readonly approvalId: string
  readonly agentName?: string
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  /** Already-redacted call arguments (redaction happened at enqueue time). */
  readonly argsRedacted: unknown
  /** Seconds the agent will still wait, or `undefined` when no wait was recorded. */
  readonly waitRemainingSec?: number
  /** Seconds left in the grant window. */
  readonly grantRemainingSec: number
  /** `true` once the grant window itself has elapsed. */
  readonly expired: boolean
}

/** True when a card may take part in a bulk "approve all" (read-class only). */
export function eligibleForBatch(card: ApprovalCardView): boolean {
  return card.toolClass === BATCH_ELIGIBLE_CLASS
}

/** Whole seconds remaining until `isoTimestamp`, floored at 0; `undefined` if absent/unparseable. */
function remainingSeconds(isoTimestamp: string | undefined, nowMs: number): number | undefined {
  if (isoTimestamp === undefined) return undefined
  const targetMs = Date.parse(isoTimestamp)
  if (Number.isNaN(targetMs)) return undefined
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000))
}

/** Pure projection of a queue entry into the display shape at instant `nowMs`. */
export function toApprovalCard(pending: PendingApproval, nowMs: number): ApprovalCardView {
  const grant = remainingSeconds(pending.expiresAt, nowMs)
  return {
    approvalId: pending.approvalId,
    ...(pending.agentName !== undefined ? { agentName: pending.agentName } : {}),
    serverName: pending.serverName,
    toolName: pending.toolName,
    toolClass: pending.toolClass,
    argsRedacted: pending.argsRedacted,
    ...(pending.waitExpiresAt !== undefined
      ? { waitRemainingSec: remainingSeconds(pending.waitExpiresAt, nowMs) ?? 0 }
      : {}),
    grantRemainingSec: grant ?? 0,
    expired: pending.expired,
  }
}

/** Pretty-prints redacted args as JSON; never throws on odd values. */
function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? null, null, 2)
  } catch {
    return String(args)
  }
}

function renderWaitLine(card: ApprovalCardView): Html {
  if (card.waitRemainingSec === undefined) {
    return html`<span class="wait-remaining wait-unknown"><span class="dot dot-s dot-off"></span>Agent wait: unknown</span>`
  }
  if (card.waitRemainingSec <= 0) {
    return html`<span class="wait-remaining wait-elapsed"><span class="dot dot-s dot-off dot-blink"></span>Agent wait elapsed — approval only grants a retry</span>`
  }
  return html`<span class="wait-remaining"><span class="dot dot-s blink"></span>Agent still waiting: <span class="num">${card.waitRemainingSec}s</span></span>`
}

/**
 * One approve/deny control. `action=` (the no-JS native POST) and
 * `data-action=` (the URL `assets/app-js.ts` fetches) MUST carry the SAME full
 * path: the client script calls `preventDefault()` on the form and fetches
 * whatever `data-action` holds, so a bare verb there would resolve to a route
 * that does not exist and collapse into the uniform 403. Pinned by
 * `tests/ui/page-contracts.test.ts`.
 */
function renderActionForm(
  card: ApprovalCardView,
  action: string,
  label: string,
  csrfToken: string,
  buttonClass: string,
): Html {
  const target = `/approvals/${card.approvalId}/${action}`
  return html`<form method="post" action="${target}" data-action="${target}">
    <input type="hidden" name="csrf_token" value="${csrfToken}" />
    <button type="submit" class="${buttonClass}">${label}</button>
  </form>`
}

function renderCard(card: ApprovalCardView, csrfToken: string): Html {
  const batchControl = eligibleForBatch(card)
    ? html`<label class="bulk-select check"
        ><input type="checkbox" data-bulk-approve value="${card.approvalId}" /> include in bulk
        approve</label
      >`
    : html``
  return html`<article class="approval-card row-in" data-approval-id="${card.approvalId}" data-tool-class="${card.toolClass}">
    <div class="approval-head">
      <span class="tool ellipsis"><span class="server">${card.serverName}</span>/<span class="tool-name">${renderToolName(card.toolName)}</span></span>
      <span class="badge tool-class tool-class-${card.toolClass} ${card.toolClass}">${card.toolClass}</span>
      <span class="agent muted ellipsis">${card.agentName ?? '(unnamed agent)'}</span>
    </div>
    <pre class="args">${formatArgs(card.argsRedacted)}</pre>
    <div class="clocks">
      ${renderWaitLine(card)}
      <span class="grant-remaining">Grant window: <span class="num">${card.grantRemainingSec}s</span> left</span>
    </div>
    <div class="actions">
      ${renderActionForm(card, 'approve', 'Approve', csrfToken, 'approve')}
      ${renderActionForm(card, 'deny', 'Deny', csrfToken, 'secondary deny')}
    </div>
    ${batchControl}
  </article>`
}

export interface ApprovalsPageInput {
  readonly cards: readonly ApprovalCardView[]
  readonly csrfToken: string
  readonly currentAdmin?: CurrentAdmin
  /**
   * Total pending requests, when it exceeds what `cards` holds. Reads of the
   * queue are bounded, and an operator must never be left believing a truncated
   * page is the whole queue.
   */
  readonly totalPending?: number
  /**
   * True only when `cards` is a genuinely bounded/partial view: the read that
   * produced it hit its own row bound (`APPROVALS_LIST_MAX_ROWS`) AND
   * `totalPending` exceeds what is shown. Deliberately NOT derived in this
   * module from `totalPending > cards.length` alone — that comparison is
   * unsound here for two separate reasons:
   *  - `cards` and `totalPending` come from two independent queue reads
   *    (`list()` then `countPending()`); a request committing between them can
   *    make `totalPending > cards.length` true on a queue nowhere near
   *    truncated (the identical mistake shipped in the CLI's `approvals list
   *    --json`, fixed in commit f05c6d2).
   *  - `cards` is already the POST-filter view: `list()` drops rows that fail
   *    to parse, so `cards.length` can sit BELOW the bound even though nothing
   *    beyond the bound was missed — comparing it to `totalPending` alone
   *    would then report truncation for a read that fetched everything there
   *    was to fetch.
   * The caller (`ui/handlers/approvals.ts`) is the one place that sees the raw
   * `list()` result before any of that and can apply the honest test; this
   * module only renders the verdict it is handed.
   */
  readonly truncated?: boolean
}

/**
 * SSE topics that must re-render the approvals list, in the exact form
 * `assets/app-js.ts` reads them (`data-live-region` holds a space-separated
 * topic list; the script also looks the region up by this exact value in the
 * refetched document, so it must stay stable between the two renders).
 */
const APPROVALS_LIVE_TOPICS = 'approval-pending approval-resolved'

/** Where the client refetches this region from (`GET /` serves this page). */
const APPROVALS_LIVE_SRC = '/'

/**
 * True when the queue holds more pending requests than this page renders.
 * Trusts the caller's verdict (see `ApprovalsPageInput.truncated`) rather than
 * re-deriving it from `totalPending`/`cards.length` — that comparison is
 * unsound in this module, which never sees the raw, pre-filter read.
 */
function isTruncated(input: ApprovalsPageInput): boolean {
  return input.truncated === true && input.totalPending !== undefined
}

/**
 * The count line. When the read was truncated it says so explicitly — showing
 * a bare "500 pending" on a queue of 900 would tell an operator the backlog is
 * drained when it is not.
 */
function renderPendingCount(input: ApprovalsPageInput): Html {
  const shown = String(input.cards.length)
  if (!isTruncated(input)) {
    return html`${shown} pending`
  }
  return html`${shown} of ${String(input.totalPending)} pending (showing the oldest)`
}

/**
 * The truncated total, as an extra attribute on the very node the client
 * script already reads for the tab badge. Emitted ONLY when the read was cut
 * short: without it `assets/app-js.ts` badges the bounded card count, i.e. the
 * exact number the count line above exists to correct, and an operator
 * glancing at the tab (rather than the page) reads the backlog as drained down
 * to the bound. Absent on an untruncated read, so that path is unchanged.
 */
function renderPendingTotalAttribute(input: ApprovalsPageInput): Html {
  if (!isTruncated(input)) return html``
  return html` data-pending-total="${String(input.totalPending)}"`
}

/**
 * The live queue region: count line plus cards (or the empty state). This is
 * the node `assets/app-js.ts` re-fetches and swaps on `approval-pending` /
 * `approval-resolved`, so its `data-live-region` value and `data-live-src`
 * must stay exactly what the script looks up.
 */
export function renderQueueRegion(input: ApprovalsPageInput): Html {
  const body =
    input.cards.length === 0
      ? html`<p class="empty">No pending approvals.</p>`
      : html`<div class="queue-cards">${join(input.cards.map((card) => renderCard(card, input.csrfToken)))}</div>`
  return html`<section
    class="approvals"
    data-live-region="${APPROVALS_LIVE_TOPICS}"
    data-live-src="${APPROVALS_LIVE_SRC}"
  >
    <p class="pending-count label" data-pending-count="${input.cards.length}"${renderPendingTotalAttribute(input)}>
      ${renderPendingCount(input)}
    </p>
    ${body}
  </section>`
}

/** Number shown on the "Held" tile: the true queue depth when the read was truncated. */
export function pendingTotalOf(input: ApprovalsPageInput): number {
  return isTruncated(input) ? (input.totalPending ?? input.cards.length) : input.cards.length
}
