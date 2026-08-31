import { html, type Html, join, safeUrl } from '../html.js'
import type { JournalRecord } from '../../journal/record.js'
import type { JournalFilters } from '../../journal/search.js'
import { renderPeriodControl, shortTime, type PeriodState } from './journal-period.js'

/**
 * Building blocks of the journal browser in the McpCut "Call journal" row
 * grammar (Claude Design `Journal.dc.html`, redrawn 2026-08-27): a 10px
 * tracked-caps header row, hair-line rows with hover, `Sessions`/`Records`
 * tabs in the panel head, a one-line filter bar ending in the period control,
 * and one `<details class="disclosure">` per record whose summary IS the row
 * and whose body is the redacted payload.
 *
 * Everything here is pure and escaped through the `html` template — journal
 * values come off disk and from proxied servers and are untrusted-for-render.
 */

/** Re-exported so callers keep one import surface for the row grammar. */
export { shortTime } from './journal-period.js'

/** Which of the two tabs in the panel head is current. */
export type JournalTab = 'sessions' | 'records'

/** The current filter/paging/period state, echoed into the form and links. */
export interface JournalViewState {
  readonly sessionId?: string
  readonly filters: JournalFilters
  readonly page: number
  /** Month the period calendar shows, `YYYY-MM`. */
  readonly month: string
  /** True when the period popover renders open (a pick is in progress). */
  readonly pickerOpen: boolean
  /** Today as `YYYY-MM-DD`; the anchor the period presets count back from. */
  readonly today: string
  /** Names offered by the agent dropdown (from the agent registry). */
  readonly agentNames: readonly string[]
  /**
   * Which tab's own form produced this view, when it matters. `records` is the
   * cross-session stream; `sessions` marks a request from the session list's
   * reduced bar, so its text narrows the LIST by id instead of starting a
   * cross-session text search (which is the top bar's job).
   */
  readonly view?: 'sessions' | 'records'
}

/** Per-list rendering options: the session-link prefix column. */
export interface RecordRowOptions {
  /** True in cross-session lists: each row leads with a session link. */
  readonly withSession: boolean
}

/** Outcomes whose pill is drawn in the alert weight (white rule). */
const ALERT_OUTCOMES: ReadonlySet<string> = new Set([
  'deny',
  'denied-by-operator',
  'quarantined',
  'timeout',
])

export function sessionHref(sessionId: string): string {
  return `/journal?session=${encodeURIComponent(sessionId)}`
}

// --- Links ----------------------------------------------------------------

/**
 * A `/journal` URL carrying the whole current view — session, tab, every
 * filter and the period — with `extra` applied on top. Pager links and tab
 * links are built through this so narrowing a view and then paging it does
 * not silently drop the filters (the picker's own `pick`/`pm`/`period`
 * parameters are deliberately NOT carried: they are one-shot actions).
 */
export function journalHref(
  state: JournalViewState,
  extra: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const f = state.filters
  const params: Record<string, string | number | undefined> = {
    session: state.sessionId,
    view: state.view,
    q: f.text,
    kind: f.kind,
    direction: f.direction,
    method: f.method,
    tool: f.toolName,
    agent: f.agentName,
    outcome: f.outcome,
    from: f.from,
    to: f.to,
    ...extra,
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix === '' ? '/journal' : `/journal?${suffix}`
}

// --- Tabs -----------------------------------------------------------------

/**
 * The `Sessions` / `Records` pair in the panel head. `Records` is the
 * cross-session record stream; a single session's records are still the
 * `Records` tab, so opening a session from the list keeps the tab lit.
 */
export function renderJournalTabs(state: JournalViewState, active: JournalTab): Html {
  // Both tabs drop the session and the page: switching tab is a fresh view of
  // the whole journal, narrowed by whatever filters still apply to it.
  //
  // The `Sessions` link additionally drops every record-level filter: a session
  // list cannot honour `tool=` or `outcome=`, and carrying them would put a
  // narrowing in the URL that the page neither shows nor applies. It keeps
  // `view=sessions` whenever text is set, because a bare `q` is the top bar's
  // cross-session search and would otherwise land on the search panel rather
  // than on the tab the operator actually clicked.
  const sessions = journalHref(state, {
    session: '',
    view: state.filters.text !== undefined ? 'sessions' : '',
    kind: '',
    direction: '',
    method: '',
    tool: '',
    agent: '',
    outcome: '',
  })
  const records = journalHref(state, { session: '', view: 'records' })
  return html`<div class="jr-tabs">${tabLink('Sessions', sessions, active === 'sessions')}${tabLink('Records', records, active === 'records')}</div>`
}

function tabLink(label: string, href: string, on: boolean): Html {
  const cls = on ? 'jr-tab is-on' : 'jr-tab'
  const current = on ? html` aria-current="page"` : html``
  return html`<a class="${cls}" href="${safeUrl(href)}"${current}>${label}</a>`
}

// --- Header row -----------------------------------------------------------

/**
 * The caps header above a record list; mirrors the row grid of the options.
 * `Lat` is unconditional now (the design keeps the column and writes `—` for
 * records without a measured latency) so the grid does not reflow between
 * pages of the same session.
 */
export function renderRecordsHeader(options: RecordRowOptions): Html {
  const session = options.withSession ? html`<span>Session</span>` : html``
  return html`<div class="jr-row jr-row-hd label">${session}<span>Time</span><span>Message</span><span>State</span><span>Lat</span></div>`
}

// --- Records --------------------------------------------------------------

/** One journal record as a disclosure row; `decision` records get the decision layout. */
export function renderRecordRow(
  record: JournalRecord,
  options: RecordRowOptions,
  sessionId?: string,
): Html {
  const isDecision = record.kind === 'decision' && record.decision !== undefined
  const cls = isDecision ? 'disclosure jr-rec jr-decision' : `disclosure jr-rec jr-kind-${record.kind}`
  const summary = isDecision ? decisionCells(record) : trafficCells(record)
  return html`<details class="${cls}">
    <summary class="jr-row jr-record">${sessionCell(options, sessionId)}${timeCell(record)}${summary}${latCell(record)}</summary>
    <div class="jr-rec-bd">${decisionDetail(record)}<pre class="payload">${stringifyPayload(record.payload)}</pre></div>
  </details>`
}

function sessionCell(options: RecordRowOptions, sessionId: string | undefined): Html {
  if (!options.withSession) return html``
  const id = sessionId ?? ''
  return html`<a class="session-link ellipsis" href="${safeUrl(sessionHref(id))}">${id}</a>`
}

function timeCell(record: JournalRecord): Html {
  return html`<span class="muted num jr-time ellipsis" title="${record.ts}">${shortTime(record.ts)}</span>`
}

function latCell(record: JournalRecord): Html {
  return record.durationMs !== undefined
    ? html`<span class="jr-lat num">${String(record.durationMs)} ms</span>`
    : html`<span class="jr-lat faint">—</span>`
}

/** Message + state cells of a traffic (non-decision) record. */
function trafficCells(record: JournalRecord): Html {
  return html`<span class="ellipsis jr-what"><span class="direction dim">${record.direction}</span> <span class="method">${record.method ?? ''}</span></span>
      <span class="jr-state"><span class="pill jr-kind">${record.kind}</span></span>`
}

/** Message + state cells of a decision record: `server/tool · agent` and class/outcome pills. */
function decisionCells(record: JournalRecord): Html {
  const d = record.decision
  if (d === undefined) return html``
  const agent = d.agentName !== undefined ? html` <span class="muted jr-agent">· ${d.agentName}</span>` : html``
  const outcomeCls = ALERT_OUTCOMES.has(d.outcome) ? 'pill pill-alert jr-outcome' : 'pill jr-outcome'
  return html`<span class="ellipsis jr-what"><span class="server">${d.serverName}</span>/<span class="tool-name">${d.toolName}</span>${agent}</span>
      <span class="jr-state"><span class="pill jr-class">${d.toolClass}</span> <span class="${outcomeCls}">${d.outcome}</span></span>`
}

/**
 * The rule line of a decision and, when present, the link to its approval
 * resolution: the approvals feed lives at `/` and the id rides as a fragment so
 * an operator lands on the resolution context. Empty for traffic records.
 */
function decisionDetail(record: JournalRecord): Html {
  const d = record.decision
  if (record.kind !== 'decision' || d === undefined) return html``
  const approval =
    d.approvalId !== undefined
      ? html` · <a href="/#approval-${encodeURIComponent(d.approvalId)}">approval ${d.approvalId}</a>`
      : html``
  return html`<p class="rule small">rule: ${d.rule}${approval}</p>`
}

/** A list of records as rows, with its header; `sessionId` supplies the prefix link per record. */
export function renderRecordRows(
  entries: readonly { readonly record: JournalRecord; readonly sessionId?: string }[],
  options: RecordRowOptions,
  emptyText: string,
): Html {
  if (entries.length === 0) return html`<p class="empty">${emptyText}</p>`
  const rows = join(entries.map((e) => renderRecordRow(e.record, options, e.sessionId)))
  return html`${renderRecordsHeader(options)}<div class="jr-rows">${rows}</div>`
}

// --- Filters --------------------------------------------------------------

/** The record-list filter fields, in the design's order. `agent` is the dropdown. */
const RECORD_FIELDS: readonly { readonly name: string; readonly key: keyof JournalFilters; readonly aria: string }[] = [
  { name: 'kind', key: 'kind', aria: 'Kind' },
  { name: 'direction', key: 'direction', aria: 'Direction' },
  { name: 'method', key: 'method', aria: 'Method' },
  { name: 'tool', key: 'toolName', aria: 'Tool' },
  { name: 'outcome', key: 'outcome', aria: 'Outcome' },
]

/**
 * The in-panel filter form. It is a real GET to `/journal` and carries EVERY
 * field (including `q`, the hidden `session`/`view` and the period) so a
 * filtered view can be narrowed further — the top-bar search box submits only
 * `q` and so resets the rest, which is fine for a fresh search but not for
 * refinement.
 *
 * The `sessions` variant is the design's reduced bar: the session list can
 * only be narrowed by id/text and by period, because the other fields are
 * record-level and answering them per session would mean reading every
 * session's records to draw a list.
 */
export function renderFilterForm(state: JournalViewState, variant: JournalTab = 'records'): Html {
  const f = state.filters
  const textPlaceholder = variant === 'sessions' ? 'session id or text' : 'text'
  const fields =
    variant === 'sessions'
      ? html``
      : html`${join(RECORD_FIELDS.map((field) => renderTextField(field, f)))}${renderAgentField(state)}`
  return html`<form class="filters jr-filters" method="get" action="/journal">
    ${hiddenFields(state, variant)}
    <input type="search" name="q" value="${f.text ?? ''}" placeholder="${textPlaceholder}" aria-label="Text">
    ${fields}
    ${renderPeriodControl(periodStateOf(state), state.today)}
    <button type="submit" class="secondary">Filter</button>
  </form>`
}

/** The period as the control needs it: the filters own `from`/`to`, the view owns the rest. */
function periodStateOf(state: JournalViewState): PeriodState {
  return {
    from: state.filters.from ?? '',
    to: state.filters.to ?? '',
    month: state.month,
    open: state.pickerOpen,
  }
}

/**
 * The fields the form must carry but not show: which view it belongs to, the
 * period (so pressing `Filter` after picking days keeps what the picker set)
 * and the calendar's current month (so the arrows' effect survives the next
 * pick). `pm` is the carry; the arrows submit `pmnav`, which is also what
 * tells the handler to keep the popover open.
 */
function hiddenFields(state: JournalViewState, variant: JournalTab): Html {
  const session =
    state.sessionId !== undefined
      ? html`<input type="hidden" name="session" value="${state.sessionId}">`
      : html``
  // A session's own records view is addressed by `session=`, so it needs no
  // `view`; the two tab-level lists each name themselves.
  const named =
    state.sessionId !== undefined ? undefined : variant === 'sessions' ? 'sessions' : state.view
  const view =
    named !== undefined ? html`<input type="hidden" name="view" value="${named}">` : html``
  const f = state.filters
  return html`${session}${view}<input type="hidden" name="from" value="${f.from ?? ''}"><input type="hidden" name="to" value="${f.to ?? ''}"><input type="hidden" name="pm" value="${state.month}">`
}

function renderTextField(
  field: { readonly name: string; readonly key: keyof JournalFilters; readonly aria: string },
  filters: JournalFilters,
): Html {
  const value = filters[field.key] ?? ''
  return html`<input type="text" name="${field.name}" value="${value}" placeholder="${field.name}" aria-label="${field.aria}">`
}

/**
 * The agent field is an enumeration, so it is a real `<select>` rather than a
 * free-text box: the plane knows every agent that can appear in a decision,
 * and a native control keeps the whole bar working with JavaScript off and
 * with a keyboard. A name that is filtered for but no longer registered is
 * still offered, so a filtered URL never silently widens.
 */
function renderAgentField(state: JournalViewState): Html {
  const current = state.filters.agentName ?? ''
  const names = [...state.agentNames]
  if (current !== '' && !names.includes(current)) names.push(current)
  const cls = current === '' ? 'jr-select' : 'jr-select is-set'
  const options = join(
    names.map(
      (name) =>
        html`<option value="${name}"${name === current ? html` selected` : html``}>${name}</option>`,
    ),
  )
  return html`<span class="${cls}"><select name="agent" aria-label="Agent">
      <option value=""${current === '' ? html` selected` : html``}>agent · any</option>${options}
    </select><span class="caret">▼</span></span>`
}

// --- Pager and shared bits ------------------------------------------------

/** Prev/next pager over a 1-based page number, keeping the current filters. */
export function renderPager(state: JournalViewState, pageCount: number): Html {
  const page = state.page
  const prev =
    page > 1
      ? html`<a class="prev" href="${safeUrl(journalHref(state, { page: page - 1 }))}">Prev</a>`
      : html`<span class="prev disabled">Prev</span>`
  const next =
    page < pageCount
      ? html`<a class="next" href="${safeUrl(journalHref(state, { page: page + 1 }))}">Next</a>`
      : html`<span class="next disabled">Next</span>`
  return html`<nav class="pager">${prev}<span class="page">Page ${page}</span>${next}</nav>`
}

/** Shows an unreadable-line count, emphasised when non-zero (never hidden). */
export function renderSkipped(count: number): Html {
  return count > 0 ? html`<strong class="skipped">${count}</strong>` : html`${0}`
}

/** JSON-stringifies a payload for display; non-serializable payloads degrade safely. */
export function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2) ?? ''
  } catch {
    return '[unserializable payload]'
  }
}
