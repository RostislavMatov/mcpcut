import type { SessionSummaryEntry } from '../../journal/index-cache.js'
import type { JournalFilters } from '../../journal/search.js'
import type { JournalDirection } from '../../journal/record.js'
import { applyPick, applyPreset, defaultMonth, isDay, isMonth } from '../pages/journal-period.js'

/**
 * Query parsing for `GET /journal`: everything between the request line and
 * the read layer, kept pure so it can be reasoned about (and tested) without a
 * store.
 *
 * Two of its jobs carry weight beyond parsing:
 * - it folds the period control's one-shot buttons (`pick`, `period`, `pmnav`,
 *   `close`) into the `from`/`to` filters, which is what makes that control
 *   work with JavaScript switched off;
 * - it drops anything malformed instead of rejecting it. These values reach
 *   the filter layer, where a half-parsed day would narrow the journal to
 *   garbage; narrowing by nothing is the honest failure.
 */

/** The parsed view request: which panel, narrowed how, with the picker where. */
export interface JournalRequest {
  readonly sessionId?: string
  readonly view?: 'sessions' | 'records'
  readonly allSessions: boolean
  readonly filters: JournalFilters
  readonly page: number
  readonly month: string
  readonly pickerOpen: boolean
  readonly today: string
}

// --- Session-list narrowing -----------------------------------------------

/**
 * The session list can only answer what a summary row knows: its id and the
 * span of its activity. Text matches the id; a period keeps every session
 * whose activity OVERLAPS it, because a session that started before the
 * period and ran into it is part of that period's story.
 */
export function sessionMatches(entry: SessionSummaryEntry, filters: JournalFilters): boolean {
  if (filters.text !== undefined && !entry.sessionId.toLowerCase().includes(filters.text.toLowerCase())) {
    return false
  }
  if (filters.from !== undefined && entry.lastTs.slice(0, 10) < filters.from) return false
  if (filters.to !== undefined && entry.firstTs.slice(0, 10) > filters.to) return false
  return true
}

// --- Query parsing --------------------------------------------------------

export function parseRequest(query: URLSearchParams, now: Date): JournalRequest {
  const today = now.toISOString().slice(0, 10)
  const sessionId = firstNonEmpty(query.get('session'))
  const period = foldPeriod(query, today)
  const filters = buildFilters(query, period)
  const view = parseView(query.get('view'))
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(sessionId === undefined && view !== undefined ? { view } : {}),
    allSessions: sessionId === undefined && view === 'records',
    filters,
    page: parsePage(query.get('page')),
    month: period.month,
    pickerOpen: period.open,
    today,
  }
}

interface FoldedPeriod {
  readonly from: string
  readonly to: string
  readonly month: string
  readonly open: boolean
}

/**
 * Folds the period control's one-shot parameters into `from`/`to`. Only one
 * submit button fires per submit, so at most one of `period`/`pick`/`pmnav`
 * is present; `period` still wins if a crafted URL carries several, because a
 * preset is the coarser, more explicit intent.
 *
 * Anything malformed is dropped rather than rejected: these values reach the
 * filter layer, and an unparsable day must narrow nothing instead of
 * silently narrowing to garbage.
 */
function foldPeriod(query: URLSearchParams, today: string): FoldedPeriod {
  const current = { from: dayParam(query.get('from')), to: dayParam(query.get('to')) }
  const preset = firstNonEmpty(query.get('period'))
  const pick = dayParam(query.get('pick'))
  const nav = monthParam(query.get('pmnav'))
  const closed = query.get('close') !== null

  const span =
    preset !== undefined
      ? (applyPreset(preset, today) ?? current)
      : pick !== ''
        ? applyPick(current.from, current.to, pick)
        : current

  const carried = monthParam(query.get('pm'))
  const month = nav !== '' ? nav : carried !== '' ? carried : defaultMonth(span.from, span.to, today)
  const acted = preset !== undefined || pick !== '' || nav !== ''
  return { ...span, month, open: acted && !closed }
}

/** Reads the recognised filter fields from the query into a `JournalFilters`. */
function buildFilters(query: URLSearchParams, period: FoldedPeriod): JournalFilters {
  const direction = firstNonEmpty(query.get('direction'))
  return {
    ...maybe('kind', firstNonEmpty(query.get('kind'))),
    ...(direction !== undefined ? { direction: direction as JournalDirection } : {}),
    ...maybe('method', firstNonEmpty(query.get('method'))),
    ...maybe('toolName', firstNonEmpty(query.get('tool'))),
    ...maybe('outcome', firstNonEmpty(query.get('outcome'))),
    ...maybe('agentName', firstNonEmpty(query.get('agent'))),
    ...maybe('from', period.from === '' ? undefined : period.from),
    ...maybe('to', period.to === '' ? undefined : period.to),
    ...maybe('text', firstNonEmpty(query.get('q'))),
  }
}

function maybe(key: string, value: string | undefined): Record<string, string> {
  return value !== undefined ? { [key]: value } : {}
}

/** A `YYYY-MM-DD` query value, or `''` when absent or malformed. */
function dayParam(raw: string | null): string {
  const value = firstNonEmpty(raw)
  return value !== undefined && isDay(value) ? value : ''
}

/** A `YYYY-MM` query value, or `''` when absent or malformed. */
function monthParam(raw: string | null): string {
  const value = firstNonEmpty(raw)
  return value !== undefined && isMonth(value) ? value : ''
}

/**
 * The tab a request names, if any. `sessions` is what the session list's own
 * bar submits: it means "narrow the list", as opposed to the top bar's bare
 * `q`, which means "search every session's records".
 */
function parseView(raw: string | null): 'sessions' | 'records' | undefined {
  if (raw === 'records') return 'records'
  return raw === 'sessions' ? 'sessions' : undefined
}

/** Parses a 1-based page number, clamping anything invalid up to 1. */
function parsePage(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
}

/** Trims a query value and drops it to `undefined` when empty. */
function firstNonEmpty(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
