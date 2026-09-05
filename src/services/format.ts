import { formatReadableField } from '../journal/format.js'
import { canonicalJson } from '../policy/hash.js'
import { hostAuthority } from './authority.js'
import { SERVICE_NAMES, type ServiceName } from './constants.js'
import type { ServiceStatus, StartResult, StopResult } from './manager-types.js'

/**
 * How the service manager reads on a terminal (mcpcut phase 1, Task 11):
 * the `status` table, the one line each `start`/`stop` prints, and `--json`.
 *
 * Pure functions over the manager's result types — no I/O, so the CLI command
 * stays about commands and composition (the split `server-status-format.ts`
 * already makes). Every helper returns a ready-to-write block terminated by a
 * newline, so a caller never has to guess whether to add one.
 *
 * Everything printed here that did NOT originate in this process goes through
 * `formatReadableField` first (review SEC-M6). A status detail quotes a pid
 * file, a log tail is whatever the daemon wrote, and a host is read back out
 * of a pid file: a raw `ESC [ 2 K` in any of them clears the line the operator
 * was reading. `statusJson` is deliberately left alone — `canonicalJson`
 * escapes control characters on its own, and the `--json` view is the
 * authoritative one.
 */

/** Two spaces between columns: enough to read, narrow enough for an 80-column terminal. */
const COLUMN_GAP = '  '
/** What a cell shows when the service has no such value — never a bare blank. */
const EMPTY_CELL = '—'
const DETAIL_INDENT = '  '
/** Marks the lines that came out of the daemon's own log rather than from mcpcut. */
const LOG_LINE_PREFIX = '  log: '
/** `<name>:` plus one space, sized by the longest service name so both lines align. */
const SERVICE_LABEL_WIDTH = Math.max(...SERVICE_NAMES.map((name) => name.length)) + 2
/** Milliseconds an ISO stamp carries and an operator does not need. */
const MILLISECONDS_PATTERN = /\.\d{3}Z$/

/**
 * The `mcpcut status` table: one row per service, columns sized to their
 * contents, and a detail (why a state is what it is) indented beneath the row
 * it belongs to rather than pushed onto the end of the line, where a long
 * pid-reuse explanation would wrap and break the alignment of every column.
 */
export function formatStatusTable(statuses: readonly ServiceStatus[]): string {
  const rows = statuses.map((status) => ({ status, cells: cellsOf(status) }))
  const widths = columnWidths(rows.map((row) => row.cells))
  return rows.map(({ status, cells }) => `${renderRow(cells, widths)}\n${detailLineOf(status)}`).join('')
}

/** `status --json`: one document, keys sorted at every level so two runs diff cleanly. */
export function statusJson(statuses: readonly ServiceStatus[]): string {
  return `${canonicalJson(statuses)}\n`
}

/** The line `mcpcut start` prints for one service. */
export function formatStartResult(service: ServiceName, result: StartResult): string {
  switch (result.kind) {
    case 'started':
      return labelled(
        service,
        `started pid ${pidOf(result.status)} on ${urlOf(result.status)} (log ${result.status.logPath})`,
      )
    case 'already-running':
      return labelled(service, `already running pid ${pidOf(result.status)} on ${urlOf(result.status)}`)
    case 'external':
      return labelled(service, externalStartText(result.status))
    case 'unsupported':
      return labelled(service, `unsupported: ${result.reason}`)
    case 'failed':
      // The reason alone rarely explains a start; the daemon's own last words do.
      return (
        labelled(service, `failed to start: ${readable(result.reason)}`) +
        result.logTail.map((line) => `${LOG_LINE_PREFIX}${readable(line)}\n`).join('')
      )
  }
}

/** The line `mcpcut stop` prints for one service. */
export function formatStopResult(service: ServiceName, result: StopResult): string {
  switch (result.kind) {
    case 'stopped':
      return labelled(
        service,
        `stopped pid ${result.pid}${result.forced ? ' (forced: SIGKILL after SIGTERM)' : ''}`,
      )
    case 'not-running':
      return labelled(service, 'not running')
    case 'stale-cleared':
      return labelled(service, staleClearedText(result))
    case 'external':
      return labelled(service, 'external — not managed by mcpcut')
    case 'unsupported':
      return labelled(service, `unsupported: ${result.reason}`)
  }
}

function staleClearedText(result: Extract<StopResult, { kind: 'stale-cleared' }>): string {
  const pid = result.pid !== undefined ? ` (pid ${result.pid})` : ''
  const detail = result.detail !== undefined ? ` — ${result.detail}` : ''
  return `stale pid file cleared${pid}${detail}`
}

/**
 * Two different things arrive as `external`, and an operator needs to know
 * which: a port somebody else already answers on, or an install that hands
 * its services to another supervisor entirely.
 */
function externalStartText(status: ServiceStatus): string {
  return status.state === 'external'
    ? `external — something answers on ${addressOf(status)}; mcpcut did not start it`
    : 'external — this install hands its services to another supervisor'
}

function labelled(service: ServiceName, text: string): string {
  return `${`${service}:`.padEnd(SERVICE_LABEL_WIDTH)}${text}\n`
}

function cellsOf(status: ServiceStatus): readonly string[] {
  return [
    status.service,
    status.state,
    status.pid !== undefined ? `pid ${status.pid}` : EMPTY_CELL,
    addressOf(status),
    status.startedAt !== undefined ? `since ${withoutMilliseconds(status.startedAt)}` : EMPTY_CELL,
  ]
}

function detailLineOf(status: ServiceStatus): string {
  return status.detail !== undefined ? `${DETAIL_INDENT}${readable(status.detail)}\n` : ''
}

/** The width of each column, from the widest cell in it. */
function columnWidths(rows: readonly (readonly string[])[]): readonly number[] {
  const columnCount = rows[0]?.length ?? 0
  return Array.from({ length: columnCount }, (_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? '').length)),
  )
}

/** The last column is never padded: trailing blanks are invisible damage in a diff. */
function renderRow(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length)))
    .join(COLUMN_GAP)
}

/**
 * `host:port`, with a bare IPv6 address bracketed so the colons stay readable
 * — and bracketed only once, however the host was spelled (`authority.ts`).
 * The host itself came out of a pid file, so it is sanitized like any other
 * field read back from disk.
 */
function addressOf(status: ServiceStatus): string {
  return hostAuthority(readable(status.host), status.port)
}

/** Terminal-safe rendering of one field that this process did not write. */
function readable(value: string): string {
  return formatReadableField(value)
}

function urlOf(status: ServiceStatus): string {
  return `http://${addressOf(status)}`
}

function pidOf(status: ServiceStatus): string {
  return status.pid !== undefined ? String(status.pid) : EMPTY_CELL
}

/** `2026-09-04T09:12:03.000Z` -> `2026-09-04T09:12:03Z`; the full stamp stays in `--json`. */
function withoutMilliseconds(iso: string): string {
  return iso.replace(MILLISECONDS_PATTERN, 'Z')
}
