import type { ServerStatusChange } from '../probe/orchestrator.js'
import type { UiEvent } from '../ui/events.js'
import type { ServerStatusPort } from '../ui/handlers/servers-status.js'
import { composeProbeChain } from './probe-wiring.js'
import type { UiCompositionDeps } from './ui-wiring.js'

/** The UI's probe chain and its SSE event, split out of `ui-wiring.ts` for its line budget. */

/** What the probe chain needs from the UI's composition deps. */
export type ProbeCompositionDeps = Pick<
  UiCompositionDeps,
  'journalDir' | 'inventoryStorePath' | 'registry' | 'vault' | 'stderr' | 'hub' | 'clock'
>

/** The SSE event one settled probe publishes (shape mirrored by `assets/app-js.ts`). */
function statusEventOf(change: ServerStatusChange): UiEvent {
  const { entry } = change
  return {
    event: 'server-status-changed',
    data: {
      server: change.serverName,
      status: entry.status,
      probedAt: entry.probedAt,
      ...(entry.status === 'alive'
        ? { probedVia: entry.probedVia, latencyMs: entry.initializeLatencyMs }
        : { error: entry.error, ...(entry.probedVia !== undefined ? { probedVia: entry.probedVia } : {}) }),
    },
  }
}

export interface ProbeComposition {
  readonly port: ServerStatusPort
  close(): Promise<void>
}

/**
 * Composes the probe chain for the UI (M5.5 item 1, ADR-0008): the shared
 * `composeProbeChain` (status store + passive activity + engine + inventory
 * observe + journal fact — one definition for UI and CLI alike, see
 * `probe-wiring.ts`) plus the UI's own SSE event. This is the ONLY place the
 * vault's value-resolution is bound for the UI — the handlers see nothing
 * but `ServerStatusPort`.
 */
export function composeProbes(deps: ProbeCompositionDeps): ProbeComposition {
  const chain = composeProbeChain({
    journalDir: deps.journalDir,
    inventoryStorePath: deps.inventoryStorePath,
    registry: deps.registry,
    readSecretValues: deps.vault.readSecretValues,
    onDiagnostic: (line) => deps.stderr.write(line),
    onStatusChanged: (change) => deps.hub.publish(statusEventOf(change)),
    onError: (error) =>
      deps.stderr.write(`[probe] ${error instanceof Error ? error.message : String(error)}\n`),
    // The one injected clock drives the probe chain too (staleness, probing
    // markers, blink windows) — same discipline as every other subsystem here.
    ...(deps.clock !== undefined ? { now: deps.clock } : {}),
  })
  return {
    port: {
      ensureFresh: (names, initiator) => chain.orchestrator.ensureFresh(names, initiator),
      probeNow: (name, initiator) => chain.orchestrator.probeNow(name, initiator),
      listStatuses: () => chain.statusStore.listStatuses(),
      lastSuccessfulActivity: (name) => chain.activity.lastSuccessfulActivity(name),
    },
    close: () => chain.orchestrator.close(),
  }
}
