import { formatReadableField } from '../journal/format.js'
import type { ServerActivity } from '../probe/activity.js'
import type { ServerStatus, StoredServerStatus } from '../probe/status-schema.js'

/**
 * Text rendering of server probe statuses for the CLI (M5.5 п.1, Task 8):
 * the STATUS cell of `server list` and the one-line report `show`/`add`/
 * `refresh` print. Pure functions over the status-store shapes — no I/O, no
 * chain, so `server-status-cmd.ts` stays about commands and composition.
 *
 * Error strings arrive pre-redacted from the probe pipeline (names, never
 * values) but still pass `formatReadableField`: everything the CLI prints
 * from disk is neutralized the same way.
 */

/** Human-scale "how long ago" for status cells and report lines. */
function agoOf(tsIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(tsIso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** True for a settled entry younger than the staleness horizon (orchestrator's own rule). */
function isFreshSettled(
  entry: StoredServerStatus | undefined,
  nowMs: number,
  staleAfterMs: number,
): entry is Exclude<StoredServerStatus, { status: 'probing' }> {
  return (
    entry !== undefined && entry.status !== 'probing' && nowMs - Date.parse(entry.probedAt) < staleAfterMs
  )
}

/** One settled entry as a compact ✓/✗ cell. */
function settledCellOf(entry: Exclude<StoredServerStatus, { status: 'probing' }>, suffix: string): string {
  if (entry.status === 'alive') {
    return `✓ ${Math.round(entry.initializeLatencyMs)}ms${suffix}`
  }
  return `✗ ${entry.status}${suffix}`
}

/**
 * The `server list` STATUS cell (O1 hybrid, same precedence the orchestrator
 * probes by): a fresh probe result wins, then fresh journal traffic, then
 * whatever old state is left — marked `(stale)` so a multi-hour-old ✓ never
 * reads as "alive right now".
 */
export function statusCellOf(
  entry: StoredServerStatus | undefined,
  activity: ServerActivity | null,
  nowMs: number,
  staleAfterMs: number,
): string {
  if (isFreshSettled(entry, nowMs, staleAfterMs)) {
    return settledCellOf(entry, '')
  }
  if (activity !== null && activity.fresh) {
    return `✓ traffic ${agoOf(activity.lastActivityAt, nowMs)}`
  }
  if (entry === undefined) {
    return '- never checked'
  }
  if (entry.status === 'probing') {
    return '… probing'
  }
  return settledCellOf(entry, ' (stale)')
}

/** One readable status line for `show`/`refresh`/`add` output. */
export function statusLineOf(
  status: ServerStatus,
  activity: ServerActivity | null,
  nowMs: number,
  staleAfterMs: number,
): string {
  if (status.status === 'never-checked') {
    return activity !== null && activity.fresh
      ? `alive — traffic ${agoOf(activity.lastActivityAt, nowMs)} (journal, no probe)`
      : 'never checked'
  }
  if (status.status === 'probing') {
    return `probing (started ${agoOf(status.probeStartedAt, nowMs)})`
  }
  const stale = nowMs - Date.parse(status.probedAt) >= staleAfterMs ? ', stale' : ''
  const checked = `(checked ${agoOf(status.probedAt, nowMs)}${stale})`
  if (status.status === 'alive') {
    return `alive — ${Math.round(status.initializeLatencyMs)}ms via ${status.probedVia} ${checked}`
  }
  return `${status.status} — ${formatReadableField(status.error)} ${checked}`
}
