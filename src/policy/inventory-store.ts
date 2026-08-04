import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
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

/** A tool schema that has been reviewed and approved for a given server. */
export interface ApprovedToolRecord {
  readonly schemaHash: string
  readonly approvedAt: string
}

/** A tool schema pending review, because it is new or changed since approval. */
export interface QuarantinedToolRecord {
  readonly schemaHash: string
  readonly firstSeenAt: string
  readonly state: 'new' | 'changed'
  readonly descriptor: ToolDescriptor
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
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
  return { schemaHash: raw['schemaHash'], approvedAt: raw['approvedAt'] }
}

/** Returns a valid quarantined record, or `null` to skip a malformed entry. */
function toQuarantinedRecord(raw: unknown): QuarantinedToolRecord | null {
  if (
    !isPlainObject(raw) ||
    typeof raw['schemaHash'] !== 'string' ||
    typeof raw['firstSeenAt'] !== 'string' ||
    (raw['state'] !== 'new' && raw['state'] !== 'changed') ||
    !isPlainObject(raw['descriptor']) ||
    typeof raw['descriptor']['name'] !== 'string'
  ) {
    return null
  }
  return {
    schemaHash: raw['schemaHash'],
    firstSeenAt: raw['firstSeenAt'],
    state: raw['state'],
    descriptor: raw['descriptor'] as unknown as ToolDescriptor,
  }
}
