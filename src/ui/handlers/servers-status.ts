import type { ServerActivity } from '../../probe/activity.js'
import { ACTIVITY_BLINK_WINDOW_MS } from '../../probe/constants.js'
import type {
  ProbeInitiator,
  ProbeTrigger,
  ServerStatus,
  StoredServerStatus,
} from '../../probe/status-schema.js'
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_SEE_OTHER,
} from '../constants.js'
import type { ServerStatusesByName, ServerStatusView } from '../pages/servers-status.js'
import {
  parseBodyFields,
  headerValue,
  type UiHandler,
  type UiRequestContext,
  type UiResult,
} from '../routes.js'

/**
 * The UI side of the server-status probe (M5.5 п.1, Task 6; threat model:
 * ADR-0008). This module owns the `POST /servers/refresh` handler and
 * the helpers `handlers/servers.ts` uses to project statuses into the page
 * view and to start probes — all through `ServerStatusPort`, a port INJECTED
 * by the composition root (`cli/ui-wiring.ts`).
 *
 * Layering: nothing in `src/ui/**` may reach the vault's value-resolution
 * path (`tests/architecture/imports.test.ts`), and a probe needs vault
 * secrets for a child's env / http headers. The port is how the two coexist:
 * the orchestrator + engine + vault live behind it, composed outside the UI;
 * this module only asks "keep these fresh" / "probe now" and renders what
 * the status store already holds pre-redacted.
 */

/** What the UI may ask of the probe machinery; bound in `cli/ui-wiring.ts`. */
export interface ServerStatusPort {
  /** Lazy trigger (O2/O5): probes only stale servers; per-server faults never reject. */
  ensureFresh(serverNames: readonly string[], initiator: ProbeInitiator): Promise<void>
  /** Forced trigger (registration, refresh): probes regardless of freshness. */
  probeNow(serverName: string, initiator: ProbeInitiator): Promise<ServerStatus>
  /** All persisted status entries, keyed by server name. */
  listStatuses(): Promise<Readonly<Record<string, StoredServerStatus>>>
  /** The passive signal: the server's last allowed/approved journal activity. */
  lastSuccessfulActivity(serverName: string): Promise<ServerActivity | null>
}

/**
 * The initiator of a probe caused by this request: the trigger plus the
 * acting admin's NAME (never a token or session id). Every trigger in the UI
 * has a session — including `lazy` from a `viewer` (O5) — so the probe
 * journal always carries who caused the execution (ADR-0008 §6).
 */
export function probeInitiatorOf(ctx: UiRequestContext, trigger: ProbeTrigger): ProbeInitiator {
  const adminName = ctx.session?.adminName
  return {
    trigger,
    ...(adminName !== undefined && adminName !== '' ? { adminName } : {}),
  }
}

/**
 * Fire-and-forget probe start: a page or redirect must never wait for (or
 * fail because of) a probe. A rejection here is a start-time refusal only
 * (server removed in a race, orchestrator closing) — a probe that actually
 * ran always lands its outcome in the status store and the journal through
 * the orchestrator, so dropping the rejection loses no evidence.
 */
export function startProbe(
  probes: ServerStatusPort,
  serverName: string,
  initiator: ProbeInitiator,
): void {
  void probes.probeNow(serverName, initiator).catch(() => undefined)
}

/**
 * Projects the stored statuses + the passive activity signal into the page's
 * flat view (`pages/servers-status.ts`). Read-only and instant — this is
 * what lets `GET /servers` answer without waiting for any probe (O7).
 */
export async function statusesViewOf(
  probes: ServerStatusPort,
  serverNames: readonly string[],
  now: () => number = Date.now,
): Promise<ServerStatusesByName> {
  const stored = await probes.listStatuses()
  const entries = await Promise.all(
    serverNames.map(async (name) => {
      const entry = Object.hasOwn(stored, name) ? stored[name] : undefined
      const activity = await probes.lastSuccessfulActivity(name)
      return [name, toStatusView(entry, activity, now())] as const
    }),
  )
  return new Map(entries)
}

/** One stored entry (or none) + activity → the flat render view. */
function toStatusView(
  entry: StoredServerStatus | undefined,
  activity: ServerActivity | null,
  nowMs: number,
): ServerStatusView {
  const activityFields =
    activity === null
      ? {}
      : {
          lastActivityAt: activity.lastActivityAt,
          // The blink window is deliberately much narrower than the staleness
          // horizon the tracker's own `fresh` uses — computed here instead.
          activityFresh: nowMs - Date.parse(activity.lastActivityAt) <= ACTIVITY_BLINK_WINDOW_MS,
        }
  if (entry === undefined) {
    return { status: 'never-checked', ...activityFields }
  }
  if (entry.status === 'probing') {
    return { status: 'probing', probeStartedAt: entry.probeStartedAt, ...activityFields }
  }
  if (entry.status === 'alive') {
    return {
      status: 'alive',
      probedVia: entry.probedVia,
      latencyMs: entry.initializeLatencyMs,
      probedAt: entry.probedAt,
      ...activityFields,
    }
  }
  return {
    status: entry.status,
    error: entry.error,
    probedAt: entry.probedAt,
    ...(entry.probedVia !== undefined ? { probedVia: entry.probedVia } : {}),
    ...activityFields,
  }
}

export interface ServersStatusDeps {
  readonly probes: ServerStatusPort
  /** Registry existence check, so an unknown name is a 404, never a late 500. */
  readonly hasServer: (name: string) => Promise<boolean>
}

export interface ServersStatusHandlers {
  readonly serversRefresh: UiHandler
}

/**
 * `POST /servers/refresh` (operator+ — the row in `authz.ts`; the flat
 * name-in-body form every other server mutation uses, and the row ADR-0008
 * fixes): forces a probe of one registered server and redirects back to
 * `/servers`. The response does not wait for the probe — its outcome arrives
 * over SSE (`server-status-changed`) or on the next page load (the no-JS
 * contract of O7).
 */
export function createServersStatusHandlers(deps: ServersStatusDeps): ServersStatusHandlers {
  async function serversRefresh(ctx: UiRequestContext): Promise<UiResult> {
    const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
    const name = fields.name ?? ''
    if (name === '') {
      return { kind: 'response', status: HTTP_STATUS_BAD_REQUEST, body: 'missing server name' }
    }
    if (!(await deps.hasServer(name))) {
      return { kind: 'response', status: HTTP_STATUS_NOT_FOUND, body: 'unknown server' }
    }
    startProbe(deps.probes, name, probeInitiatorOf(ctx, 'refresh'))
    return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location: '/servers' } }
  }

  return { serversRefresh }
}
