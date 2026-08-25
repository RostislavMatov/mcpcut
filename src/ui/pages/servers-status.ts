import type { ServerActivity } from '../../probe/activity.js'
import { ACTIVITY_BLINK_WINDOW_MS } from '../../probe/constants.js'
import type { ServerStatus } from '../../probe/status-schema.js'
import { html, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The per-server status dot of the Servers screen (M5.5 p.1, owner decision
 * O7): white = alive, white blinking = alive with fresh traffic, gray = not
 * alive (`error` / `unreachable` / `vault-refused`), gray blinking = probing,
 * hollow outline = never checked. The tooltip is mandatory (ADR-0008 §8): a
 * bare dot without a timestamp turns an hours-old probe into a false
 * "alive right now".
 *
 * This is the page-side VIEW model, deliberately not an import of
 * `src/probe/status-schema.ts`: the handler (Task 6) projects the stored
 * status + the passive activity signal into this flat shape, and the page
 * renders whatever it is handed. Every field is untrusted-for-render — the
 * `error` cause is server-influenced text — and reaches markup only through
 * the escaping `html` template.
 *
 * The rendered dot carries `data-server="<name>"`: the client script's
 * `applyServerStatus` (assets/app-js.ts) finds it by that hook when a
 * `server-status-changed` SSE event arrives and swaps class + tooltip without
 * a reload. Without JS the dot simply shows the last stored state.
 */

/** Mirror of `src/probe/status-schema.ts` statuses plus the synthetic never-checked. */
export const SERVER_STATUS_KINDS = [
  'never-checked',
  'probing',
  'alive',
  'error',
  'unreachable',
  'vault-refused',
] as const

export type ServerStatusKind = (typeof SERVER_STATUS_KINDS)[number]

/** One server's status as the page shows it (built by the handler). */
export interface ServerStatusView {
  readonly status: ServerStatusKind
  /** What the probe measured with (`initialize` or `tools/list`, O4). */
  readonly probedVia?: 'initialize' | 'tools/list'
  /** Probe latency in milliseconds (alive only). */
  readonly latencyMs?: number
  /** When the probe finished (ISO-8601; alive and the failure statuses). */
  readonly probedAt?: string
  /** When the running probe started (ISO-8601; probing only). */
  readonly probeStartedAt?: string
  /** Redacted human-readable cause (the failure statuses). Untrusted-for-render. */
  readonly error?: string
  /** Newest successful traffic for this server (passive signal, O1). */
  readonly lastActivityAt?: string
  /** True while that traffic is inside `ACTIVITY_BLINK_WINDOW_MS` → blink. */
  readonly activityFresh?: boolean
}

/** Per-server statuses, keyed by server name (Map for the same reason as tools). */
export type ServerStatusesByName = ReadonlyMap<string, ServerStatusView>

/**
 * What the handler side hands over per server (the shape Task 6's
 * `statusViewOf` builds): the stored probe entry — or the synthetic
 * never-checked — plus the passive activity signal when the journal has one.
 */
export interface ServerStatusViewEntry {
  readonly status: ServerStatus
  readonly activity?: ServerActivity
}

/**
 * Flattens handler entries into the render model and applies the BLINK
 * window: `ServerActivity.fresh` is the one-hour staleness horizon (O1/O2),
 * while the white-blink of O7 wants activity inside the much smaller
 * `ACTIVITY_BLINK_WINDOW_MS` — so blink is recomputed here from
 * `lastActivityAt` against `nowMs`. An unparseable timestamp never blinks.
 */
export function toServerStatusesByName(
  entries: Readonly<Record<string, ServerStatusViewEntry>>,
  nowMs: number = Date.now(),
): ServerStatusesByName {
  const out = new Map<string, ServerStatusView>()
  for (const [name, entry] of Object.entries(entries)) {
    out.set(name, toStatusView(entry, nowMs))
  }
  return out
}

function toStatusView(entry: ServerStatusViewEntry, nowMs: number): ServerStatusView {
  const { status } = entry
  const activity = entry.activity === undefined ? {} : activityFieldsOf(entry.activity, nowMs)
  if (status.status === 'never-checked') {
    return { status: 'never-checked', ...activity }
  }
  if (status.status === 'probing') {
    return { status: 'probing', probeStartedAt: status.probeStartedAt, ...activity }
  }
  if (status.status === 'alive') {
    return {
      status: 'alive',
      probedVia: status.probedVia,
      latencyMs: status.initializeLatencyMs,
      probedAt: status.probedAt,
      ...activity,
    }
  }
  return {
    status: status.status,
    error: status.error,
    probedAt: status.probedAt,
    ...(status.probedVia !== undefined ? { probedVia: status.probedVia } : {}),
    ...activity,
  }
}

function activityFieldsOf(
  activity: ServerActivity,
  nowMs: number,
): Pick<ServerStatusView, 'lastActivityAt' | 'activityFresh'> {
  const activityMs = Date.parse(activity.lastActivityAt)
  const withinBlinkWindow =
    !Number.isNaN(activityMs) && nowMs - activityMs <= ACTIVITY_BLINK_WINDOW_MS
  return { lastActivityAt: activity.lastActivityAt, activityFresh: withinBlinkWindow }
}

const NEVER_CHECKED_VIEW: ServerStatusView = { status: 'never-checked' }

/** The dot's class list for a status; absence of an entry IS never-checked. */
export function statusDotClassOf(view: ServerStatusView | undefined): string {
  const status = (view ?? NEVER_CHECKED_VIEW).status
  if (status === 'alive') {
    return view?.activityFresh === true ? 'dot srv-dot dot-blink' : 'dot srv-dot'
  }
  if (status === 'probing') return 'dot srv-dot dot-off dot-blink'
  if (status === 'never-checked') return 'dot srv-dot dot-hollow'
  return 'dot srv-dot dot-off'
}

/**
 * The tooltip: source (traffic / probe + `probedVia`), time, latency or the
 * failure cause (O7). Kept in the same shape as the client script's
 * `serverStatusTitle` so an SSE update reads like the server render.
 */
export function statusTitleOf(view: ServerStatusView | undefined): string {
  const v = view ?? NEVER_CHECKED_VIEW
  if (v.status === 'never-checked') return 'never checked'
  if (v.status === 'probing') {
    return v.probeStartedAt === undefined ? 'probing…' : `probing… · started ${v.probeStartedAt}`
  }
  const parts: string[] = [v.status]
  parts.push(v.probedVia === undefined ? 'probe' : `probe (${v.probedVia})`)
  if (v.probedAt !== undefined) parts.push(v.probedAt)
  if (v.latencyMs !== undefined) parts.push(`${Math.round(v.latencyMs)}ms`)
  if (v.error !== undefined) parts.push(v.error)
  if (v.lastActivityAt !== undefined) parts.push(`traffic ${v.lastActivityAt}`)
  return parts.join(' · ')
}

/**
 * The dot itself. `data-server` is the SSE updater's lookup hook; the name and
 * the whole tooltip go through the escaping template (the cause can be
 * hostile server output).
 */
export function renderStatusDot(serverName: string, view: ServerStatusView | undefined): Html {
  return html`<span class="${statusDotClassOf(view)}" data-server="${serverName}" title="${statusTitleOf(view)}"></span>`
}

/**
 * The Refresh route (flat, server named in the body — the shape ADR-0008's
 * table and Task 6's `serversRefresh` handler use, like `/servers/remove`).
 * Task 6 owns the matching ROUTE_TABLE row (operator+).
 */
export const REFRESH_ACTION = '/servers/refresh'

/**
 * The force-probe form (operator+, ADR-0008 §5). A plain CSRF-guarded POST —
 * it works without JS; rendered only when the handler says the viewer's role
 * may refresh (`canRefresh`), never for `viewer`.
 */
export function renderRefreshForm(serverName: string, csrfToken: string): Html {
  return html`<form method="post" action="${REFRESH_ACTION}" class="inline srv-refresh">
      ${csrfField(csrfToken)}
      <input type="hidden" name="name" value="${serverName}" />
      <button type="submit" class="secondary">Refresh</button>
    </form>`
}
