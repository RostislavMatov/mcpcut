import { createJsonStore, type JsonStore } from '../policy/store.js'
import { registryFilePath } from './constants.js'
import { parseRegistry, parseServerRecord, type RegistryFile, type ServerRecord } from './schema.js'

/**
 * Registry store: `<journalDir>/registry.json`, built on the atomic,
 * lockfile-guarded `createJsonStore` (0600 file / 0700 dir, tmp+rename,
 * cross-process lock — all inherited). A corrupt file surfaces as the store's
 * `StoreCorruptError`, never as an empty registry: silently "losing" every
 * registered server would make the control plane spawn nothing while looking
 * healthy.
 */

/** Raised by `addServer` when a record with the same name already exists. */
export class DuplicateServerError extends Error {
  constructor(name: string) {
    super(`server "${name}" already exists in the registry`)
    this.name = 'DuplicateServerError'
  }
}

/** Raised by `addServer` when the record fails schema validation. */
export class InvalidServerRecordError extends Error {
  constructor(cause: unknown) {
    super('invalid server record', { cause })
    this.name = 'InvalidServerRecordError'
  }
}

/** Result of `removeServer`: the removed record, or a typed not-found. */
export type RemoveServerResult =
  | { readonly status: 'removed'; readonly record: ServerRecord }
  | { readonly status: 'not-found' }

export interface RegistryStore {
  /** Adds a record; rejects with `DuplicateServerError` if the name is taken. */
  addServer(record: ServerRecord): Promise<ServerRecord>
  /** Removes by name; never throws for a missing name (typed result instead). */
  removeServer(name: string): Promise<RemoveServerResult>
  /** Record by name, or `undefined`. Returned value is a private copy. */
  getServer(name: string): Promise<ServerRecord | undefined>
  /** All records, sorted by name. Returned values are private copies. */
  listServers(): Promise<readonly ServerRecord[]>
}

const EMPTY_REGISTRY: RegistryFile = { version: 1, servers: {} }

/** `validate` for the underlying JSON store: throws on any invalid shape. */
function validateRegistry(raw: unknown): RegistryFile {
  const result = parseRegistry(raw)
  if (!result.ok) {
    throw result.error
  }
  return result.registry
}

/**
 * `Object.hasOwn` guard for every map lookup: a hostile name such as
 * `__proto__` must read as "absent", not resolve to `Object.prototype`
 * through the prototype chain of a plain object.
 */
function ownRecord(servers: RegistryFile['servers'], name: string): ServerRecord | undefined {
  return Object.hasOwn(servers, name) ? servers[name] : undefined
}

export interface RegistryStoreOptions {
  /**
   * Receives the lock's forced-removal warning line (see `src/lockfile.ts`).
   * Threaded from callers that own a diagnostics sink (CLI `io.stderr`);
   * defaults to `process.stderr` inside the lock module.
   */
  readonly warn?: (line: string) => void
}

export function createRegistryStore(
  journalDir?: string,
  opts: RegistryStoreOptions = {},
): RegistryStore {
  const store: JsonStore<RegistryFile> = createJsonStore(registryFilePath(journalDir), {
    validate: validateRegistry,
    defaultValue: EMPTY_REGISTRY,
    ...(opts.warn !== undefined ? { lock: { warn: opts.warn } } : {}),
  })

  async function addServer(record: ServerRecord): Promise<ServerRecord> {
    const parsed = parseServerRecord(record)
    if (!parsed.ok) {
      throw new InvalidServerRecordError(parsed.error)
    }
    const validated = parsed.record

    await store.update((current) => {
      if (ownRecord(current.servers, validated.name) !== undefined) {
        throw new DuplicateServerError(validated.name)
      }
      return { ...current, servers: { ...current.servers, [validated.name]: validated } }
    })
    return validated
  }

  async function removeServer(name: string): Promise<RemoveServerResult> {
    // `update` may re-run this callback when a concurrent process steals the
    // store lock, so the captured result must be reset at the top of EVERY
    // attempt: a first attempt that saw the record, followed by a retry that
    // no longer does, would otherwise report a removal that never happened.
    let removed: ServerRecord | undefined
    await store.update((current) => {
      removed = undefined
      const existing = ownRecord(current.servers, name)
      if (existing === undefined) {
        return current
      }
      removed = existing
      const remaining = Object.fromEntries(
        Object.entries(current.servers).filter(([key]) => key !== name),
      )
      return { ...current, servers: remaining }
    })
    return removed !== undefined ? { status: 'removed', record: removed } : { status: 'not-found' }
  }

  async function getServer(name: string): Promise<ServerRecord | undefined> {
    const current = await store.read()
    return ownRecord(current.servers, name)
  }

  async function listServers(): Promise<readonly ServerRecord[]> {
    const current = await store.read()
    return Object.values(current.servers).sort((a, b) => a.name.localeCompare(b.name))
  }

  return { addServer, removeServer, getServer, listServers }
}
