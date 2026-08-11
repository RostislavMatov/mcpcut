import type { JournalDirection, JournalRecord } from './record.js'

/**
 * Record-level filter matching for the journal search layer (`search.ts`,
 * split out for the <400-line file rule). One filter set serves both the
 * single-session page and the cross-session walk; the scan loops there
 * pre-compute the lowered text needle ONCE per scan (`textNeedleOf` +
 * `matchesWithNeedle`) instead of lowering it once per record.
 */

/** Filters shared by single-session and cross-session searches. */
export interface JournalFilters {
  readonly kind?: string
  readonly direction?: JournalDirection
  readonly method?: string
  /** Tool name of a `decision` record. */
  readonly toolName?: string
  /** Policy outcome of a `decision` record. */
  readonly outcome?: string
  /** Case-insensitive substring over payload, method and decision fields. */
  readonly text?: string
}

/** True when `record` satisfies every filter that was supplied. */
export function matchesFilters(record: JournalRecord, filters: JournalFilters): boolean {
  return matchesWithNeedle(record, filters, textNeedleOf(filters))
}

/**
 * Pre-lowered text needle, or `undefined` when no text filter applies.
 * Computed once per scan by the search loops instead of once per record.
 */
export function textNeedleOf(filters: JournalFilters): string | undefined {
  return filters.text !== undefined && filters.text.length > 0
    ? filters.text.toLowerCase()
    : undefined
}

/** Every filter is an early return on mismatch — including the text filter. */
export function matchesWithNeedle(
  record: JournalRecord,
  filters: JournalFilters,
  textNeedle: string | undefined,
): boolean {
  if (filters.kind !== undefined && record.kind !== filters.kind) {
    return false
  }
  if (filters.direction !== undefined && record.direction !== filters.direction) {
    return false
  }
  if (filters.method !== undefined && record.method !== filters.method) {
    return false
  }
  if (filters.toolName !== undefined && record.decision?.toolName !== filters.toolName) {
    return false
  }
  if (filters.outcome !== undefined && record.decision?.outcome !== filters.outcome) {
    return false
  }
  if (textNeedle !== undefined && !searchableText(record).includes(textNeedle)) {
    return false
  }
  return true
}

/**
 * The text a substring filter runs against: payload, method and the decision's
 * short fields. Built only when a substring filter is present, because
 * serializing every payload of every scanned record is the expensive part of a
 * text search.
 */
function searchableText(record: JournalRecord): string {
  const decision = record.decision
  const parts = [
    record.method ?? '',
    decision === undefined ? '' : `${decision.toolName} ${decision.rule} ${decision.serverName}`,
    stringifyPayload(record.payload),
  ]
  return parts.join(' ').toLowerCase()
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload
  }
  try {
    return JSON.stringify(payload) ?? ''
  } catch {
    // A payload that cannot be serialized (cyclic, BigInt) is not searchable,
    // but it must not break the scan it appears in.
    return ''
  }
}
