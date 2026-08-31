import { html, type Html, join } from '../html.js'

/**
 * The journal's period control (Claude Design `Journal.dc.html`, 2026-08-27):
 * a compact button reading `period · all` that opens a popover with three
 * presets, a month grid and a Done button.
 *
 * The design drives it from component state; here it is a `<details>` whose
 * cells are REAL submit buttons of the enclosing filter form, so it works with
 * JavaScript switched off like every other control in this console:
 *
 * - a day cell submits `pick=<YYYY-MM-DD>`; the handler folds that against the
 *   current `from`/`to` (start a period, or close the one already started —
 *   the design's `setPeriod` rule, moved server-side);
 * - a preset submits `period=24h|7d|30d`, and `All` submits `period=all`;
 * - the month arrows submit `pmnav=<YYYY-MM>` (the month itself rides along
 *   as a hidden `pm` field, so paging the calendar survives the next pick);
 * - `Done` submits `close=1`.
 *
 * Because the buttons submit the whole form, filter text typed but not yet
 * applied travels with the pick instead of being dropped — which is what the
 * design's in-memory version does too. The popover stays open across picks
 * because the handler re-opens it whenever the request carries `pick`, `pm` or
 * `period` without `close`; nothing here needs a hidden open-state field.
 *
 * Everything is escaped through the `html` template: `from`/`to` arrive from
 * the query string and are untrusted-for-render even after parsing.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

/** Preset spans, in the design's order; `days` counts back from today inclusive. */
export const PERIOD_PRESETS: readonly { readonly label: string; readonly days: number }[] = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

/** `YYYY-MM-DD`, the only day shape this module accepts or emits. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/** The period as the control renders it. */
export interface PeriodState {
  /** Inclusive start day, or `''` when open-ended. */
  readonly from: string
  /** Inclusive end day, or `''` when open-ended. */
  readonly to: string
  /** Month the grid shows, `YYYY-MM`. */
  readonly month: string
  /** True when the popover renders expanded. */
  readonly open: boolean
}

/** True for a well-formed `YYYY-MM-DD` that names a real calendar day. */
export function isDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** True for a well-formed `YYYY-MM`. */
export function isMonth(value: string): boolean {
  if (!MONTH_RE.test(value)) return false
  const month = Number(value.slice(5))
  return month >= 1 && month <= 12
}

/** `Aug 27 26` — the control's compact day label. */
export function dayLabel(iso: string): string {
  const [year, month, day] = iso.split('-')
  return `${MONTHS[Number(month) - 1] ?? '???'} ${day ?? ''} ${(year ?? '').slice(2)}`
}

/** `Aug 27 26 09:02:11` — month, day, 2-digit year, wall time of an ISO instant. */
export function shortTime(ts: string): string {
  const t = ts.indexOf('T')
  if (t === -1) return ts
  return `${dayLabel(ts.slice(0, t))} ${ts.slice(t + 1, t + 9)}`
}

/** The day `count` days back from `day`, inclusive of both ends (`span(d, 1) === d`). */
export function dayBefore(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - count)
  return date.toISOString().slice(0, 10)
}

/** `YYYY-MM` shifted by whole months; used by the calendar's arrows. */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Days of `month` laid out Monday-first; leading blanks are `null`. */
export function monthGrid(month: string): readonly (string | null)[] {
  const [year, index] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year ?? 1970, index ?? 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let day = 1; day <= days; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, '0')}`)
  }
  return cells
}

/**
 * Folds one day click into a period, exactly as the design's `setPeriod`
 * does: no start (or a closed period) begins a new one, and a second click
 * closes it — before the start, the two swap so a period is never inverted.
 */
export function applyPick(from: string, to: string, pick: string): { from: string; to: string } {
  if (from === '' || to !== '') return { from: pick, to: '' }
  return pick < from ? { from: pick, to: from } : { from, to: pick }
}

/** The preset named by `label`, resolved against `today`; `all` clears the period. */
export function applyPreset(label: string, today: string): { from: string; to: string } | undefined {
  if (label === 'all') return { from: '', to: '' }
  const preset = PERIOD_PRESETS.find((entry) => entry.label === label)
  return preset === undefined ? undefined : { from: dayBefore(today, preset.days - 1), to: today }
}

/** The month the grid opens on: the period's start, else its end, else `today`. */
export function defaultMonth(from: string, to: string, today: string): string {
  const anchor = from !== '' ? from : to !== '' ? to : today
  return anchor.slice(0, 7)
}

/** The button's label: a range, a half-open bound, or `period · all`. */
export function periodLabel(from: string, to: string): string {
  if (from !== '' && to !== '') return `${dayLabel(from)} → ${dayLabel(to)}`
  if (from !== '') return `from ${dayLabel(from)}`
  if (to !== '') return `to ${dayLabel(to)}`
  return 'period · all'
}

// --- Rendering ------------------------------------------------------------

/**
 * The whole control: the summary button plus the popover. Rendered inside the
 * filter form, so its buttons submit that form; the caller is responsible for
 * carrying `from`/`to` as hidden fields so a plain `Filter` keeps the period.
 */
export function renderPeriodControl(state: PeriodState, today: string): Html {
  const set = state.from !== '' || state.to !== ''
  const cls = set ? 'jr-period is-set' : 'jr-period'
  const openAttr = state.open ? html` open` : html``
  return html`<details class="${cls}"${openAttr}>
    <summary class="jr-period-btn">${periodLabel(state.from, state.to)}<span class="caret">▼</span></summary>
    <div class="jr-picker">
      <div class="jr-picker-presets">${renderPresets(state, today)}<span class="grow"></span><button type="submit" class="jr-picker-all" name="period" value="all">All</button></div>
      ${renderMonthNav(state.month)}
      <div class="jr-weekdays">${join(WEEKDAYS.map((day) => html`<span>${day}</span>`))}</div>
      <div class="jr-days">${renderDays(state)}</div>
      <div class="jr-picker-ft"><span class="label">${hintFor(state)}</span><button type="submit" name="close" value="1">Done</button></div>
    </div>
  </details>`
}

function hintFor(state: PeriodState): string {
  return state.from !== '' && state.to === ''
    ? 'pick the end of the period'
    : 'click a day to start a period'
}

function renderPresets(state: PeriodState, today: string): Html {
  return join(
    PERIOD_PRESETS.map((preset) => {
      const span = applyPreset(preset.label, today)
      const on = span !== undefined && span.from === state.from && span.to === state.to
      const cls = on ? 'jr-preset is-on' : 'jr-preset'
      return html`<button type="submit" class="${cls}" name="period" value="${preset.label}">${preset.label}</button>`
    }),
  )
}

function renderMonthNav(month: string): Html {
  const [year, index] = month.split('-')
  const label = `${(MONTHS[Number(index) - 1] ?? '???').toUpperCase()} ${year ?? ''}`
  return html`<div class="jr-picker-nav">
      <button type="submit" class="icon" name="pmnav" value="${shiftMonth(month, -1)}" aria-label="Previous month">‹</button>
      <span class="jr-picker-month">${label}</span>
      <button type="submit" class="icon" name="pmnav" value="${shiftMonth(month, 1)}" aria-label="Next month">›</button>
    </div>`
}

function renderDays(state: PeriodState): Html {
  return join(
    monthGrid(state.month).map((iso) => {
      if (iso === null) return html`<span class="jr-day-blank"></span>`
      const edge = iso === state.from || iso === state.to
      const inRange = state.from !== '' && state.to !== '' && iso > state.from && iso < state.to
      const cls = edge ? 'jr-day is-edge' : inRange ? 'jr-day in-range' : 'jr-day'
      const current = edge ? html` aria-current="date"` : html``
      return html`<button type="submit" class="${cls}" name="pick" value="${iso}" title="${dayLabel(iso)}"${current}>${String(Number(iso.slice(8)))}</button>`
    }),
  )
}
