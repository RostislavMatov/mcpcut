import { createInventory } from '../policy/inventory.js'
import { createActivityTracker, type ActivityTracker } from '../probe/activity.js'
import { probe, type ProbeResult } from '../probe/engine.js'
import { journalProbe } from '../probe/journal-probe.js'
import {
  createProbeOrchestrator,
  PROBING_MARKER_FRESH_FOR_MS,
  type ProbeOrchestrator,
  type RunProbeFn,
  type ServerStatusChange,
  type SettledServerStatus,
} from '../probe/orchestrator.js'
import { createServerStatusStore, type ServerStatusStore } from '../probe/status-store.js'
import { normalizeKnownSecrets, scrubKnownSecrets } from '../redact/known-secrets.js'
import type { RegistryStore } from '../registry/store.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import type { VaultStore } from '../vault/store.js'

/**
 * The one composition of the whole probe chain (M5.5 п.1, ADR-0008): status
 * store + passive activity + the real engine over `prepareUpstream` + the
 * standard inventory observe path (O8) + the journal fact. Shared by BOTH
 * probe surfaces — the admin UI (`ui-wiring.ts` adds its SSE event on top)
 * and the `server list/show/refresh/add` commands (`server-status-cmd.ts`) —
 * so "what a probe is" cannot drift between them.
 *
 * This module lives in `src/cli/**` deliberately: it binds the vault's
 * value-resolution, which `src/probe/**` must receive as a port and
 * `src/ui/**` may not import at all (the architecture test pins that).
 */

export interface ProbeChainDeps {
  /** Directory holding `state.db` (status document) and `journal.db`. */
  readonly journalDir: string
  /** Path of the tool inventory probe `tools/list` results feed (O8). */
  readonly inventoryStorePath: string
  readonly registry: Pick<RegistryStore, 'getServer' | 'listServers'>
  /**
   * The vault's value-resolution, bound into the engine's `resolveRefs`.
   * Touched only when a probe actually dereferences a `vault:` value.
   */
  readonly readSecretValues: VaultStore['readSecretValues']
  /** Upstream-level diagnostic lines (stderr-style). */
  readonly onDiagnostic: (line: string) => void
  /** Sink for non-fatal orchestrator faults (ports failing, unknown names). */
  readonly onError: (error: unknown) => void
  /** Fired after every settled probe (the UI wires SSE here; the CLI nothing). */
  readonly onStatusChanged?: (change: ServerStatusChange) => void
  /** Engine seam for tests; defaults to the real probe engine. */
  readonly runProbe?: RunProbeFn
  /** Staleness horizon override (tests); also the passive-signal freshness. */
  readonly staleAfterMs?: number
  /** Clock in epoch ms; injectable for deterministic staleness tests. */
  readonly now?: () => number
}

export interface ProbeChain {
  readonly orchestrator: ProbeOrchestrator
  readonly statusStore: ServerStatusStore
  readonly activity: ActivityTracker
}

/** A settled probe entry, mapped back onto the engine's result shape for the journal. */
export function probeResultOf(entry: SettledServerStatus): ProbeResult {
  if (entry.status === 'alive') {
    return {
      status: 'alive',
      initializeLatencyMs: entry.initializeLatencyMs,
      probedVia: entry.probedVia,
    }
  }
  return { status: entry.status, message: entry.error }
}

/**
 * Exact-value scrub of a probe result's message (defense in depth, mirroring
 * `serve-runtime.ts`'s `collectKnownSecrets`): every error/unreachable
 * message is persisted (status document), pushed over SSE, and journaled, so
 * a vault value that ever leaks into one — today all upstream errors are
 * structural, but that is a discipline, not a guarantee — must be scrubbed
 * by value, not only by pattern.
 */
export function scrubProbeResult(result: ProbeResult, secrets: readonly string[]): ProbeResult {
  if (result.status === 'alive' || secrets.length === 0) return result
  return { ...result, message: scrubKnownSecrets(result.message, secrets) }
}

export function composeProbeChain(deps: ProbeChainDeps): ProbeChain {
  const statusStore = createServerStatusStore({
    journalDir: deps.journalDir,
    probingFreshForMs: PROBING_MARKER_FRESH_FOR_MS,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  const activity = createActivityTracker({
    journalDir: deps.journalDir,
    ...(deps.staleAfterMs !== undefined ? { freshAfterMs: deps.staleAfterMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  // Vault values the chain itself handed to an upstream, per server — the
  // exact-value scrub list for that server's messages and journal record.
  const knownSecretsByServer = new Map<string, readonly string[]>()
  const runProbe: RunProbeFn =
    deps.runProbe ??
    (async (record, opts) => {
      const result = await probe(record, {
        processEnv: process.env,
        resolveRefs: async (refs) => {
          const resolved = await resolveVaultRefs(refs, deps.readSecretValues)
          if (resolved.status === 'resolved') {
            knownSecretsByServer.set(
              record.name,
              normalizeKnownSecrets(Object.values(resolved.values)),
            )
          }
          return resolved
        },
        withTools: opts.withTools,
        onDiagnostic: deps.onDiagnostic,
      })
      return scrubProbeResult(result, knownSecretsByServer.get(record.name) ?? [])
    })
  const orchestrator = createProbeOrchestrator({
    statusStore,
    activity,
    getRecord: (name) => deps.registry.getServer(name),
    listRegistryNames: async () => (await deps.registry.listServers()).map((record) => record.name),
    runProbe,
    // O8: the SAME inventory the proxy's observed traffic feeds — an
    // unchanged schemaHash is never re-quarantined, a changed one lands in
    // quarantine with its structural diff, by the standard path.
    observeTools: async (serverName, tools) => {
      const inventory = createInventory(serverName, { storePath: deps.inventoryStorePath })
      await inventory.load()
      await inventory.observeToolsList(tools)
    },
    recordProbeJournal: async (change) => {
      await journalProbe({
        serverName: change.serverName,
        initiator: change.entry.initiator,
        result: probeResultOf(change.entry),
        dir: deps.journalDir,
        knownSecrets: knownSecretsByServer.get(change.serverName) ?? [],
      })
    },
    ...(deps.onStatusChanged !== undefined ? { onStatusChanged: deps.onStatusChanged } : {}),
    onError: deps.onError,
    ...(deps.staleAfterMs !== undefined ? { staleAfterMs: deps.staleAfterMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  return { orchestrator, statusStore, activity }
}
