import type { QuarantineState } from '../journal/record.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { MAX_QUARANTINED_TOOLS_PER_SERVER } from './constants.js'
import {
  buildSnapshots,
  observeAgainst,
  quarantinedEntriesOf,
  type ObserveResult,
  type QuarantinedEntry,
} from './inventory-observe.js'
import {
  EMPTY_SERVER_INVENTORY,
  approvedRecordFrom,
  omitKey,
  openInventoryStore,
  withKey,
  type ApprovedToolRecord,
  type ServerInventory,
} from './inventory-store.js'
import type { SurfaceDelta } from './schema-diff.js'
import { StoreCorruptError, StoreLockError, type JsonStore } from './store.js'
import type { InventoryStoreData } from './inventory-store.js'

/**
 * Per-server tool inventory: tracks which tool schemas have been approved, and
 * quarantines tools that are new or whose schema changed since approval
 * ("rug pull" defense). `stateOf` is a SYNCHRONOUS, authoritative union of the
 * persisted quarantine store and every observed `tools/list` (so a tool cannot
 * escape quarantine by being omitted from a later list -- C4), hydrated at
 * session start by `load()`. `observeToolsList` never throws: a per-descriptor
 * fault is isolated as an "unhashable" quarantine (C3), and only a failed
 * PERSIST (corrupt/locked store -- H5) sets `failed`/untrusts the catalog so
 * `decide` fails closed.
 */

// Re-exported so existing importers (tests, CLI) keep their import site.
export { INVENTORY_FILE_NAME } from './inventory-store.js'
export { MAX_STORED_DESCRIPTION_CHARS } from './constants.js'
export type { ObserveResult, QuarantinedEntry } from './inventory-observe.js'

export interface CreateInventoryOptions {
  /** Path to the inventory store file. Defaults to `JOURNAL_DIR/tool-inventory.json`. */
  readonly storePath?: string
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
  /**
   * Reports the underlying cause whenever a persist fails (TS-MEDIUM-3): the
   * observation is always fail-closed regardless (`failed: true`, catalog
   * untrusted), but the cause must never be silently swallowed. Defaults to
   * one line on stderr, matching the gate's own default `onError`.
   */
  readonly onError?: (error: unknown) => void
}

function defaultOnError(error: unknown): void {
  process.stderr.write(`[inventory] ${error instanceof Error ? error.message : String(error)}\n`)
}

export interface Inventory {
  /**
   * Hydrates the in-memory snapshot from the persisted store (approved +
   * quarantined) so `stateOf` is authoritative before any `observeToolsList`.
   * Idempotent. A corrupt/unavailable store leaves the catalog untrusted
   * (`isCatalogTrusted() === false`) rather than throwing.
   */
  load(): Promise<void>
  /**
   * Compares `tools` against the approved catalog, upserts new/changed schemas
   * into quarantine, and refreshes the snapshot. NEVER throws. `failed` is
   * `true` iff persisting the observation failed.
   */
  observeToolsList(tools: readonly ToolDescriptor[]): Promise<ObserveResult>
  /** Synchronous authoritative state: persisted quarantine unioned with every observed list. */
  stateOf(toolName: string): QuarantineState
  /**
   * Direction of a `changed` tool's accepted-input surface versus the approved
   * descriptor, or `undefined` when no direction is established (the tool is
   * not `changed`, the approval predates descriptor storage, or a stored
   * schema was truncated). Synchronous for the same reason `stateOf` is: it is
   * read on the decision path, where O4 withdraws an explicit `allow` on it.
   */
  surfaceDeltaOf(toolName: string): SurfaceDelta | undefined
  /**
   * The descriptor stored for `toolName` (latest observed, else approved), or
   * `undefined` when none is stored. Synchronous for the same reason `stateOf`
   * is: the gate classifies a call from it when the session itself never saw
   * a `tools/list` -- a choice that belongs to the agent, and must not decide
   * the tool's class.
   */
  descriptorOf(toolName: string): ToolDescriptor | undefined
  /** True once at least one `observeToolsList` has been processed (even if it failed). */
  hasObservedCatalog(): boolean
  /** False after a failed persist or a corrupt/unavailable store; resets to true on a clean observe. */
  isCatalogTrusted(): boolean
  /** Moves a quarantined tool to approved, at its current quarantined hash. `false` if not quarantined. */
  approve(toolName: string): Promise<boolean>
  /** Removes a tool from quarantine (re-quarantined as `'new'` on the next observe). `false` if not quarantined. */
  reject(toolName: string): Promise<boolean>
  /** Currently quarantined tools for this server, for CLI display. */
  listQuarantined(): Promise<QuarantinedEntry[]>
}

/** Creates a per-server tool inventory backed by the shared inventory store file. */
export function createInventory(serverName: string, opts: CreateInventoryOptions = {}): Inventory {
  const clock = opts.clock ?? Date.now
  const onError = opts.onError ?? defaultOnError
  const store = openInventoryStore(opts.storePath)

  let snapshots = buildSnapshots(EMPTY_SERVER_INVENTORY)
  let observed = false
  let trusted = true

  function serverEntryOf(current: InventoryStoreData): ServerInventory {
    return current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
  }

  async function load(): Promise<void> {
    try {
      const current = await store.read()
      snapshots = buildSnapshots(serverEntryOf(current))
      trusted = true
    } catch (error: unknown) {
      if (error instanceof StoreCorruptError || error instanceof StoreLockError) {
        trusted = false
        return
      }
      throw error
    }
  }

  async function observeToolsList(tools: readonly ToolDescriptor[]): Promise<ObserveResult> {
    const nowIso = new Date(clock()).toISOString()
    observed = true

    try {
      let observation = observeAgainst(EMPTY_SERVER_INVENTORY, [], nowIso, MAX_QUARANTINED_TOOLS_PER_SERVER)
      await store.update((current) => {
        observation = observeAgainst(
          serverEntryOf(current),
          tools,
          nowIso,
          MAX_QUARANTINED_TOOLS_PER_SERVER,
        )
        return { ...current, servers: withKey(current.servers, serverName, observation.nextServerEntry) }
      })

      snapshots = buildSnapshots(observation.nextServerEntry)
      trusted = !observation.capExceeded
      return { ...observation.buckets, failed: false }
    } catch (error: unknown) {
      // Persist failed (corrupt/locked/disk): keep the prior snapshot, fail
      // closed, and report the cause instead of swallowing it (TS-MEDIUM-3).
      trusted = false
      onError(error)
      return { known: [], new: [], changed: [], failed: true }
    }
  }

  function stateOf(toolName: string): QuarantineState {
    return snapshots.states.get(toolName) ?? 'unknown'
  }

  function surfaceDeltaOf(toolName: string): SurfaceDelta | undefined {
    return snapshots.deltas.get(toolName)
  }

  function descriptorOf(toolName: string): ToolDescriptor | undefined {
    return snapshots.descriptors.get(toolName)
  }

  function hasObservedCatalog(): boolean {
    return observed
  }

  function isCatalogTrusted(): boolean {
    return trusted
  }

  async function approve(toolName: string): Promise<boolean> {
    const nowIso = new Date(clock()).toISOString()
    return mutate((serverEntry) => withApprovedTool(serverEntry, toolName, nowIso))
  }

  async function reject(toolName: string): Promise<boolean> {
    return mutate((serverEntry) => withRejectedTool(serverEntry, toolName))
  }

  /** Shared apply-mutation-then-refresh-snapshot path for approve/reject. */
  async function mutate(fn: (entry: ServerInventory) => ServerMutationOutcome): Promise<boolean> {
    let changed = false
    let nextEntry: ServerInventory = EMPTY_SERVER_INVENTORY
    await store.update((current) => {
      const outcome = fn(serverEntryOf(current))
      changed = outcome.changed
      nextEntry = outcome.serverEntry
      if (!outcome.changed) return current
      return { ...current, servers: withKey(current.servers, serverName, outcome.serverEntry) }
    })
    if (changed) snapshots = buildSnapshots(nextEntry)
    return changed
  }

  async function listQuarantined(): Promise<QuarantinedEntry[]> {
    const current = await store.read()
    return quarantinedEntriesOf(serverName, serverEntryOf(current))
  }

  return {
    load,
    observeToolsList,
    stateOf,
    surfaceDeltaOf,
    descriptorOf,
    hasObservedCatalog,
    isCatalogTrusted,
    approve,
    reject,
    listQuarantined,
  }
}

/** Lists every quarantined tool across every server. Thin wrapper for the CLI. */
export async function listAllQuarantined(storePath?: string): Promise<QuarantinedEntry[]> {
  const store = openInventoryStore(storePath)
  const current = await store.read()
  return Object.entries(current.servers).flatMap(([serverName, serverEntry]) =>
    quarantinedEntriesOf(serverName, serverEntry),
  )
}

/** Approves a quarantined tool on a given server. Thin wrapper for the CLI. */
export async function approveTool(serverName: string, toolName: string, storePath?: string): Promise<boolean> {
  const nowIso = new Date().toISOString()
  return applyServerMutation(openInventoryStore(storePath), serverName, (entry) =>
    withApprovedTool(entry, toolName, nowIso),
  )
}

/** Rejects (removes from quarantine) a tool on a given server. Thin wrapper for the CLI. */
export async function rejectTool(serverName: string, toolName: string, storePath?: string): Promise<boolean> {
  return applyServerMutation(openInventoryStore(storePath), serverName, (entry) =>
    withRejectedTool(entry, toolName),
  )
}

// -- internals ---------------------------------------------------------

interface ServerMutationOutcome {
  readonly serverEntry: ServerInventory
  readonly changed: boolean
}

async function applyServerMutation(
  store: JsonStore<InventoryStoreData>,
  serverName: string,
  fn: (entry: ServerInventory) => ServerMutationOutcome,
): Promise<boolean> {
  let changed = false
  await store.update((current) => {
    const entry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
    const outcome = fn(entry)
    changed = outcome.changed
    if (!outcome.changed) return current
    return { ...current, servers: withKey(current.servers, serverName, outcome.serverEntry) }
  })
  return changed
}

/** Pure: moves `toolName` from quarantined to approved (descriptor included), at its quarantined hash. */
function withApprovedTool(serverEntry: ServerInventory, toolName: string, approvedAt: string): ServerMutationOutcome {
  const record = serverEntry.quarantined[toolName]
  if (!record) return { serverEntry, changed: false }
  return {
    changed: true,
    serverEntry: {
      approved: withKey<ApprovedToolRecord>(
        serverEntry.approved,
        toolName,
        approvedRecordFrom(record, approvedAt),
      ),
      quarantined: omitKey(serverEntry.quarantined, toolName),
    },
  }
}

/** Pure: removes `toolName` from quarantine. */
function withRejectedTool(serverEntry: ServerInventory, toolName: string): ServerMutationOutcome {
  if (!serverEntry.quarantined[toolName]) return { serverEntry, changed: false }
  return {
    changed: true,
    serverEntry: { ...serverEntry, quarantined: omitKey(serverEntry.quarantined, toolName) },
  }
}
