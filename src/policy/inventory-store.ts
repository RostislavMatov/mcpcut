import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import type { SurfaceDelta } from './schema-diff.js'
import { createJsonStore, type JsonStore } from './store.js'

/**
 * Persistence shapes, safe map helpers, and skip-and-log validation for the
 * tool inventory store. Split out of `inventory.ts` to keep each file focused
 * (and under the 400-line cap).
 *
 * A tool can be named anything a server chooses -- including `__proto__`,
 * `constructor`, or `prototype`. Written naively into a plain object literal
 * (`obj[name] = record`) `__proto__` corrupts the prototype chain and the
 * record is lost, which then makes `validateInventoryStore` reject the ENTIRE
 * shared store file (StoreCorruptError) and disables quarantine for every
 * server in the journal dir. Every map here is therefore a null-prototype
 * object built with `withKey`/`omitKey`, so a reserved-named tool round-trips
 * as an ordinary own key with no prototype effects.
 */

/** Default file name for the tool inventory store, under `JOURNAL_DIR`. */
export const INVENTORY_FILE_NAME = 'tool-inventory.json'

/**
 * Descriptor retention rule (M4, explicit): a tool holds AT MOST TWO stored
 * descriptors at any time -- the approved one (in `approved`, written by
 * `approvedRecordFrom` on approval) and the currently observed one (in
 * `quarantined`, replaced in place on every re-observe). No version history
 * accumulates; where to keep more than two versions for auditors is an M5
 * question (plan, "Открытые вопросы"). Combined with
 * `MAX_QUARANTINED_TOOLS_PER_SERVER` and the per-descriptor byte caps this
 * bounds store growth at 2 x tools x servers capped descriptors.
 */

/** A tool schema that has been reviewed and approved for a given server. */
export interface ApprovedToolRecord {
  readonly schemaHash: string
  readonly approvedAt: string
  /**
   * Redacted, size-capped copy of the descriptor as approved (M4; absent on
   * records approved before schemas were stored). Display/diff only -- the
   * hash remains the sole authority for change detection.
   */
  readonly descriptor?: ToolDescriptor
  /** `true` when the stored `inputSchema` was replaced by a top-level summary. */
  readonly schemaTruncated?: boolean
}

/** A tool schema pending review, because it is new or changed since approval. */
export interface QuarantinedToolRecord {
  readonly schemaHash: string
  readonly firstSeenAt: string
  readonly state: 'new' | 'changed'
  readonly descriptor: ToolDescriptor
  /** `true` when the stored `inputSchema` was replaced by a top-level summary. */
  readonly schemaTruncated?: boolean
  /**
   * Direction of the schema-surface change vs the approved descriptor (only on
   * `state: 'changed'` records with an approved descriptor to diff against).
   *
   * NOT display-only since M5 wave 6: this field decides whether an operator's
   * explicit per-tool `allow` still covers the tool
   * (`decide.ts`'s `withdrawnBySurfaceChange`, via `Inventory.surfaceDeltaOf`).
   * Treat it as enforcement input -- it is absent whenever the direction could
   * not be established HONESTLY (no approved descriptor, a stored schema
   * summarized past the size cap, or a diff that hit its own depth/count cap),
   * and every one of those absences escalates. Anything that makes this field
   * present must be able to stand behind the direction it names.
   */
  readonly surfaceDelta?: SurfaceDelta
}

export interface ServerInventory {
  readonly approved: Readonly<Record<string, ApprovedToolRecord>>
  readonly quarantined: Readonly<Record<string, QuarantinedToolRecord>>
}

/** On-disk shape of the whole inventory store (all servers). */
export interface InventoryStoreData {
  readonly version: 1
  readonly servers: Readonly<Record<string, ServerInventory>>
}

export const EMPTY_SERVER_INVENTORY: ServerInventory = {
  approved: emptyMap(),
  quarantined: emptyMap(),
}

export const DEFAULT_INVENTORY_STORE: InventoryStoreData = { version: 1, servers: emptyMap() }

/** A fresh null-prototype map: safe to key by any tool/server name. */
export function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** Immutable "set one key" on a null-prototype copy (safe for reserved names). */
export function withKey<T>(record: Readonly<Record<string, T>>, key: string, value: T): Record<string, T> {
  const next = emptyMap<T>()
  Object.assign(next, record)
  next[key] = value
  return next
}

/** Immutable "remove one key" returning a null-prototype copy. */
export function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = emptyMap<T>()
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) next[k] = v
  }
  return next
}

function defaultInventoryStorePath(): string {
  return join(JOURNAL_DIR, INVENTORY_FILE_NAME)
}

export function openInventoryStore(storePath?: string): JsonStore<InventoryStoreData> {
  return createJsonStore<InventoryStoreData>(storePath ?? defaultInventoryStorePath(), {
    validate: validateInventoryStore,
    defaultValue: DEFAULT_INVENTORY_STORE,
  })
}

/** Shared "plain JSON object" guard (also used by `inventory-observe.ts`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates the store. The TOP-LEVEL shape (object + `version: 1` + `servers`
 * object) must be correct or the file is genuinely corrupt (throws, so the
 * caller can mark the catalog untrusted). Individual malformed server/tool
 * ENTRIES are skipped rather than failing the whole file: one bad entry (e.g.
 * a legacy record, or a single write torn by an old bug) must not disable
 * quarantine for every other tool and server. A skipped quarantine entry is
 * simply re-quarantined on the next `observeToolsList` (fail closed).
 */
export function validateInventoryStore(raw: unknown): InventoryStoreData {
  if (!isPlainObject(raw) || raw['version'] !== 1) {
    throw new Error('tool inventory store: expected an object with version 1')
  }
  const serversRaw = raw['servers']
  if (!isPlainObject(serversRaw)) {
    throw new Error('tool inventory store: "servers" must be an object')
  }

  const servers = emptyMap<ServerInventory>()
  for (const [serverName, serverRaw] of Object.entries(serversRaw)) {
    if (isPlainObject(serverRaw)) {
      servers[serverName] = validateServerInventory(serverRaw)
    }
  }
  return { version: 1, servers }
}

function validateServerInventory(raw: Record<string, unknown>): ServerInventory {
  const approved = emptyMap<ApprovedToolRecord>()
  if (isPlainObject(raw['approved'])) {
    for (const [toolName, entryRaw] of Object.entries(raw['approved'])) {
      const record = toApprovedRecord(entryRaw)
      if (record) approved[toolName] = record
    }
  }

  const quarantined = emptyMap<QuarantinedToolRecord>()
  if (isPlainObject(raw['quarantined'])) {
    for (const [toolName, entryRaw] of Object.entries(raw['quarantined'])) {
      const record = toQuarantinedRecord(entryRaw)
      if (record) quarantined[toolName] = record
    }
  }

  return { approved, quarantined }
}

/** Returns a valid approved record, or `null` to skip a malformed entry. */
function toApprovedRecord(raw: unknown): ApprovedToolRecord | null {
  if (!isPlainObject(raw) || typeof raw['schemaHash'] !== 'string' || typeof raw['approvedAt'] !== 'string') {
    return null
  }
  return {
    schemaHash: raw['schemaHash'],
    approvedAt: raw['approvedAt'],
    ...optionalDescriptorFields(raw),
  }
}

/** Returns a valid quarantined record, or `null` to skip a malformed entry. */
function toQuarantinedRecord(raw: unknown): QuarantinedToolRecord | null {
  if (
    !isPlainObject(raw) ||
    typeof raw['schemaHash'] !== 'string' ||
    typeof raw['firstSeenAt'] !== 'string' ||
    (raw['state'] !== 'new' && raw['state'] !== 'changed')
  ) {
    return null
  }
  const descriptor = toStoredToolDescriptor(raw['descriptor'])
  if (descriptor === null) return null
  return {
    schemaHash: raw['schemaHash'],
    firstSeenAt: raw['firstSeenAt'],
    state: raw['state'],
    descriptor,
    ...(raw['schemaTruncated'] === true ? { schemaTruncated: true } : {}),
    ...(isSurfaceDelta(raw['surfaceDelta']) ? { surfaceDelta: raw['surfaceDelta'] } : {}),
  }
}

/** Untrusted-input guard for the persisted `surfaceDelta` field. */
function isSurfaceDelta(value: unknown): value is SurfaceDelta {
  return value === 'widened' || value === 'narrowed' || value === 'changed' || value === 'neutral'
}

/**
 * Optional M4 fields shared by both record shapes. A malformed `descriptor`
 * drops ONLY the descriptor (it is display/diff-only), never the record --
 * the hash keeps detection intact either way.
 */
function optionalDescriptorFields(
  raw: Record<string, unknown>,
): Pick<ApprovedToolRecord, 'descriptor' | 'schemaTruncated'> {
  const descriptor = toStoredToolDescriptor(raw['descriptor'])
  return {
    ...(descriptor !== null ? { descriptor } : {}),
    ...(raw['schemaTruncated'] === true ? { schemaTruncated: true } : {}),
  }
}

/**
 * Narrows an untrusted descriptor to what `ToolDescriptor` actually PROMISES
 * (review M3): the store is hand-editable disk input, and a future renderer
 * (`quarantine show`, admin UI) will trust the typed fields. A non-string
 * `description` and non-boolean `readOnlyHint`/`destructiveHint` are dropped
 * (never the whole record); unknown annotation keys stay, as typed. `null`
 * only for a value that is not a named descriptor at all.
 */
export function toStoredToolDescriptor(raw: unknown): ToolDescriptor | null {
  if (!isPlainObject(raw) || typeof raw['name'] !== 'string') return null
  const annotations = raw['annotations']
  return {
    name: raw['name'],
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
    ...('inputSchema' in raw ? { inputSchema: raw['inputSchema'] } : {}),
    ...(isPlainObject(annotations) ? { annotations: sanitizedAnnotations(annotations) } : {}),
  }
}

/** Keeps only boolean hint values on the two typed annotation fields. */
function sanitizedAnnotations(raw: Record<string, unknown>): NonNullable<ToolDescriptor['annotations']> {
  const { readOnlyHint, destructiveHint, ...rest } = raw
  return {
    ...rest,
    ...(typeof readOnlyHint === 'boolean' ? { readOnlyHint } : {}),
    ...(typeof destructiveHint === 'boolean' ? { destructiveHint } : {}),
  }
}

/**
 * Pure: builds the approved record for a tool from its quarantined record,
 * carrying the stored descriptor across so the approved side of a future
 * structural diff exists. Enforces the retention rule above: approval MOVES
 * the single observed descriptor into the single approved slot.
 */
export function approvedRecordFrom(record: QuarantinedToolRecord, approvedAt: string): ApprovedToolRecord {
  return {
    schemaHash: record.schemaHash,
    approvedAt,
    descriptor: record.descriptor,
    ...(record.schemaTruncated === true ? { schemaTruncated: true } : {}),
  }
}
