import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { QuarantineState } from '../journal/record.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { redact } from '../redact/redact.js'
import { createJsonStore, type JsonStore } from './store.js'
import { hashToolSchema } from './hash.js'

/**
 * Per-server tool inventory: tracks which tool schemas have been approved,
 * and quarantines tools that are new or whose schema changed since approval
 * ("rug pull" defense -- a server silently redefining an already-approved
 * tool, even by editing only its description, must not stay `known`).
 *
 * Persistence is a single JSON file per journal directory (all servers share
 * one file, keyed by server name), read/written through `createJsonStore`.
 * `stateOf` is a synchronous read of an in-memory snapshot built by the most
 * recent `observeToolsList` call -- the semantic gate (a future task) needs
 * a non-async answer per tool call, and asking a tool that was not part of
 * the last observed `tools/list` reports `unknown` rather than stale data
 * from an earlier observation.
 */

/** Default file name for the tool inventory store, under `JOURNAL_DIR`. */
export const INVENTORY_FILE_NAME = 'tool-inventory.json'

/**
 * Max characters of a tool's `description` kept before storing a quarantined
 * entry's descriptor copy. A malicious/compromised server can advertise an
 * arbitrarily large description; this bounds both the redaction work and the
 * store file size. The schema hash (used for known/new/changed comparisons)
 * is computed on the original, uncapped descriptor, so truncation here never
 * affects rug-pull detection.
 */
export const MAX_STORED_DESCRIPTION_CHARS = 4096

/** Appended when a stored description is truncated at `MAX_STORED_DESCRIPTION_CHARS`. */
const DESCRIPTION_TRUNCATION_MARKER = '…[TRUNCATED]'

/** Length of the `shortHash` field on `QuarantinedEntry` (for CLI display). */
const SHORT_HASH_CHARS = 12

/** A tool schema that has been reviewed and approved for a given server. */
interface ApprovedToolRecord {
  readonly schemaHash: string
  readonly approvedAt: string
}

/** A tool schema pending review, because it is new or changed since approval. */
interface QuarantinedToolRecord {
  readonly schemaHash: string
  readonly firstSeenAt: string
  readonly state: 'new' | 'changed'
  readonly descriptor: ToolDescriptor
}

interface ServerInventory {
  readonly approved: Readonly<Record<string, ApprovedToolRecord>>
  readonly quarantined: Readonly<Record<string, QuarantinedToolRecord>>
}

/** On-disk shape of the whole inventory store (all servers). */
interface InventoryStoreData {
  readonly version: 1
  readonly servers: Readonly<Record<string, ServerInventory>>
}

const EMPTY_SERVER_INVENTORY: ServerInventory = { approved: {}, quarantined: {} }

const DEFAULT_INVENTORY_STORE: InventoryStoreData = { version: 1, servers: {} }

/** Result of one `observeToolsList` call: tool names bucketed by disposition. */
export interface ObserveResult {
  readonly known: readonly string[]
  readonly new: readonly string[]
  readonly changed: readonly string[]
}

/** A quarantined tool, flattened for CLI listing/display. */
export interface QuarantinedEntry {
  readonly serverName: string
  readonly toolName: string
  readonly state: 'new' | 'changed'
  readonly firstSeenAt: string
  readonly shortHash: string
}

export interface CreateInventoryOptions {
  /** Path to the inventory store file. Defaults to `JOURNAL_DIR/tool-inventory.json`. */
  readonly storePath?: string
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
}

export interface Inventory {
  /**
   * Compares `tools` against the approved catalog for this server, upserts
   * new/changed schemas into quarantine (redacted, description-capped
   * descriptor copy; original hash), and refreshes the in-memory snapshot
   * `stateOf` reads from. Idempotent: re-observing the same `(tool, hash)`
   * does not duplicate or reset `firstSeenAt`; a new hash for an
   * already-quarantined tool updates the entry and resets `firstSeenAt`.
   */
  observeToolsList(tools: readonly ToolDescriptor[]): Promise<ObserveResult>
  /**
   * Synchronous snapshot lookup from the most recent `observeToolsList`
   * call. `'unknown'` before any observe, or for a tool absent from the last
   * observed list.
   */
  stateOf(toolName: string): QuarantineState
  /** Moves a quarantined tool to approved, at its current quarantined hash. `false` if not quarantined. */
  approve(toolName: string): Promise<boolean>
  /** Removes a tool from quarantine (it is re-quarantined as `'new'` on the next observe). `false` if not quarantined. */
  reject(toolName: string): Promise<boolean>
  /** Currently quarantined tools for this server, for CLI display. */
  listQuarantined(): Promise<QuarantinedEntry[]>
}

/** Creates a per-server tool inventory backed by the shared inventory store file. */
export function createInventory(serverName: string, opts: CreateInventoryOptions = {}): Inventory {
  const clock = opts.clock ?? Date.now
  const store = openInventoryStore(opts.storePath)

  /** Snapshot of the last `observeToolsList` result, for synchronous `stateOf`. */
  let snapshot: ReadonlyMap<string, QuarantineState> = new Map()

  async function observeToolsList(tools: readonly ToolDescriptor[]): Promise<ObserveResult> {
    const nowIso = new Date(clock()).toISOString()
    let observation: Observation = {
      result: { known: [], new: [], changed: [] },
      snapshot: new Map(),
      nextServerEntry: EMPTY_SERVER_INVENTORY,
    }

    await store.update((current) => {
      const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
      observation = observeAgainst(serverEntry, tools, nowIso)
      return {
        ...current,
        servers: { ...current.servers, [serverName]: observation.nextServerEntry },
      }
    })

    snapshot = observation.snapshot
    return observation.result
  }

  function stateOf(toolName: string): QuarantineState {
    return snapshot.get(toolName) ?? 'unknown'
  }

  async function approve(toolName: string): Promise<boolean> {
    const nowIso = new Date(clock()).toISOString()
    let approved = false
    await store.update((current) => {
      const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
      const outcome = withApprovedTool(serverEntry, toolName, nowIso)
      approved = outcome.changed
      if (!outcome.changed) return current
      return { ...current, servers: { ...current.servers, [serverName]: outcome.serverEntry } }
    })
    return approved
  }

  async function reject(toolName: string): Promise<boolean> {
    let rejected = false
    await store.update((current) => {
      const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
      const outcome = withRejectedTool(serverEntry, toolName)
      rejected = outcome.changed
      if (!outcome.changed) return current
      return { ...current, servers: { ...current.servers, [serverName]: outcome.serverEntry } }
    })
    return rejected
  }

  async function listQuarantined(): Promise<QuarantinedEntry[]> {
    const current = await store.read()
    const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
    return quarantinedEntriesOf(serverName, serverEntry)
  }

  return { observeToolsList, stateOf, approve, reject, listQuarantined }
}

/** Lists every quarantined tool across every server. Thin wrapper for the future CLI. */
export async function listAllQuarantined(storePath?: string): Promise<QuarantinedEntry[]> {
  const store = openInventoryStore(storePath)
  const current = await store.read()
  return Object.entries(current.servers).flatMap(([serverName, serverEntry]) =>
    quarantinedEntriesOf(serverName, serverEntry),
  )
}

/** Approves a quarantined tool on a given server. Thin wrapper for the future CLI. */
export async function approveTool(
  serverName: string,
  toolName: string,
  storePath?: string,
): Promise<boolean> {
  const store = openInventoryStore(storePath)
  const nowIso = new Date().toISOString()
  let approved = false
  await store.update((current) => {
    const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
    const outcome = withApprovedTool(serverEntry, toolName, nowIso)
    approved = outcome.changed
    if (!outcome.changed) return current
    return { ...current, servers: { ...current.servers, [serverName]: outcome.serverEntry } }
  })
  return approved
}

/** Rejects (removes from quarantine) a tool on a given server. Thin wrapper for the future CLI. */
export async function rejectTool(
  serverName: string,
  toolName: string,
  storePath?: string,
): Promise<boolean> {
  const store = openInventoryStore(storePath)
  let rejected = false
  await store.update((current) => {
    const serverEntry = current.servers[serverName] ?? EMPTY_SERVER_INVENTORY
    const outcome = withRejectedTool(serverEntry, toolName)
    rejected = outcome.changed
    if (!outcome.changed) return current
    return { ...current, servers: { ...current.servers, [serverName]: outcome.serverEntry } }
  })
  return rejected
}

// -- internals ---------------------------------------------------------

interface Observation {
  readonly result: ObserveResult
  readonly snapshot: ReadonlyMap<string, QuarantineState>
  readonly nextServerEntry: ServerInventory
}

/**
 * Pure comparison of `tools` against `serverEntry`'s approved catalog.
 * Computes the bucketed result, the fresh in-memory snapshot, and the next
 * `ServerInventory` to persist (existing entries carried over immutably).
 */
function observeAgainst(
  serverEntry: ServerInventory,
  tools: readonly ToolDescriptor[],
  nowIso: string,
): Observation {
  const known: string[] = []
  const newTools: string[] = []
  const changed: string[] = []
  const snapshot = new Map<string, QuarantineState>()
  let quarantined = serverEntry.quarantined

  for (const tool of tools) {
    const schemaHash = hashToolSchema(tool)
    const approvedRecord = serverEntry.approved[tool.name]

    if (approvedRecord && approvedRecord.schemaHash === schemaHash) {
      known.push(tool.name)
      snapshot.set(tool.name, 'known')
      continue
    }

    const state: 'new' | 'changed' = approvedRecord ? 'changed' : 'new'
    ;(state === 'new' ? newTools : changed).push(tool.name)
    snapshot.set(tool.name, state)

    const existing = quarantined[tool.name]
    if (existing && existing.schemaHash === schemaHash) {
      // Idempotent re-observe: same hash already quarantined, keep firstSeenAt.
      continue
    }

    quarantined = {
      ...quarantined,
      [tool.name]: {
        schemaHash,
        firstSeenAt: nowIso,
        state,
        descriptor: redactedDescriptorFor(tool),
      },
    }
  }

  return {
    result: { known, new: newTools, changed },
    snapshot,
    nextServerEntry: { approved: serverEntry.approved, quarantined },
  }
}

/** Caps `description` and redacts the whole descriptor before it is persisted. */
function redactedDescriptorFor(tool: ToolDescriptor): ToolDescriptor {
  const capped: ToolDescriptor = {
    name: tool.name,
    ...(tool.description !== undefined ? { description: capDescription(tool.description) } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }
  return redact(capped) as unknown as ToolDescriptor
}

function capDescription(description: string): string {
  return description.length > MAX_STORED_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_STORED_DESCRIPTION_CHARS)}${DESCRIPTION_TRUNCATION_MARKER}`
    : description
}

interface ServerMutationOutcome {
  readonly serverEntry: ServerInventory
  readonly changed: boolean
}

/** Pure: moves `toolName` from quarantined to approved, at its quarantined hash. */
function withApprovedTool(
  serverEntry: ServerInventory,
  toolName: string,
  approvedAt: string,
): ServerMutationOutcome {
  const record = serverEntry.quarantined[toolName]
  if (!record) {
    return { serverEntry, changed: false }
  }
  return {
    changed: true,
    serverEntry: {
      approved: {
        ...serverEntry.approved,
        [toolName]: { schemaHash: record.schemaHash, approvedAt },
      },
      quarantined: omitKey(serverEntry.quarantined, toolName),
    },
  }
}

/** Pure: removes `toolName` from quarantine. */
function withRejectedTool(serverEntry: ServerInventory, toolName: string): ServerMutationOutcome {
  if (!serverEntry.quarantined[toolName]) {
    return { serverEntry, changed: false }
  }
  return {
    changed: true,
    serverEntry: { ...serverEntry, quarantined: omitKey(serverEntry.quarantined, toolName) },
  }
}

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) next[k] = v
  }
  return next
}

function quarantinedEntriesOf(serverName: string, serverEntry: ServerInventory): QuarantinedEntry[] {
  return Object.entries(serverEntry.quarantined).map(([toolName, record]) => ({
    serverName,
    toolName,
    state: record.state,
    firstSeenAt: record.firstSeenAt,
    shortHash: record.schemaHash.slice(0, SHORT_HASH_CHARS),
  }))
}

function defaultInventoryStorePath(): string {
  return join(JOURNAL_DIR, INVENTORY_FILE_NAME)
}

function openInventoryStore(storePath?: string): JsonStore<InventoryStoreData> {
  return createJsonStore<InventoryStoreData>(storePath ?? defaultInventoryStorePath(), {
    validate: validateInventoryStore,
    defaultValue: DEFAULT_INVENTORY_STORE,
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateInventoryStore(raw: unknown): InventoryStoreData {
  if (!isPlainObject(raw) || raw['version'] !== 1) {
    throw new Error('tool inventory store: expected an object with version 1')
  }
  const serversRaw = raw['servers']
  if (!isPlainObject(serversRaw)) {
    throw new Error('tool inventory store: "servers" must be an object')
  }

  const servers: Record<string, ServerInventory> = {}
  for (const [serverName, serverRaw] of Object.entries(serversRaw)) {
    servers[serverName] = validateServerInventory(serverRaw, serverName)
  }
  return { version: 1, servers }
}

function validateServerInventory(raw: unknown, serverName: string): ServerInventory {
  if (!isPlainObject(raw) || !isPlainObject(raw['approved']) || !isPlainObject(raw['quarantined'])) {
    throw new Error(`tool inventory store: invalid entry for server "${serverName}"`)
  }

  const approved: Record<string, ApprovedToolRecord> = {}
  for (const [toolName, entryRaw] of Object.entries(raw['approved'])) {
    approved[toolName] = validateApprovedRecord(entryRaw, serverName, toolName)
  }

  const quarantined: Record<string, QuarantinedToolRecord> = {}
  for (const [toolName, entryRaw] of Object.entries(raw['quarantined'])) {
    quarantined[toolName] = validateQuarantinedRecord(entryRaw, serverName, toolName)
  }

  return { approved, quarantined }
}

function validateApprovedRecord(raw: unknown, serverName: string, toolName: string): ApprovedToolRecord {
  if (!isPlainObject(raw) || typeof raw['schemaHash'] !== 'string' || typeof raw['approvedAt'] !== 'string') {
    throw new Error(`tool inventory store: invalid approved entry for "${serverName}"/"${toolName}"`)
  }
  return { schemaHash: raw['schemaHash'], approvedAt: raw['approvedAt'] }
}

function validateQuarantinedRecord(
  raw: unknown,
  serverName: string,
  toolName: string,
): QuarantinedToolRecord {
  if (
    !isPlainObject(raw) ||
    typeof raw['schemaHash'] !== 'string' ||
    typeof raw['firstSeenAt'] !== 'string' ||
    (raw['state'] !== 'new' && raw['state'] !== 'changed') ||
    !isPlainObject(raw['descriptor']) ||
    typeof raw['descriptor']['name'] !== 'string'
  ) {
    throw new Error(`tool inventory store: invalid quarantined entry for "${serverName}"/"${toolName}"`)
  }
  return {
    schemaHash: raw['schemaHash'],
    firstSeenAt: raw['firstSeenAt'],
    state: raw['state'],
    descriptor: raw['descriptor'] as unknown as ToolDescriptor,
  }
}
