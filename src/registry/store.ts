import { createJsonStore, type JsonStore } from '../policy/store.js'
import { StdioServerRefusedError } from '../tenant/errors.js'
import { TENANT_SETTINGS, type TenantSettings } from '../tenant/settings.js'
import { registryFilePath } from './constants.js'
import { parseRegistry, parseServerRecord, type RegistryFile, type ServerRecord } from './schema.js'

/**
 * Registry store: the `registry.json` document in `<journalDir>/state.db`,
 * built on the transactional `createJsonStore` (0600 file / 0700 dir,
 * SQLite CAS — all inherited). A corrupt document surfaces as the store's
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

/**
 * Raised by `addServer`/`updateServer` when the record fails schema
 * validation, or (tenant mode) when it names a non-`https` upstream while
 * `tenant.upstreams === 'public-https'`. `reason` is either the `z.ZodError`
 * schema validation produced (message stays the generic `'invalid server
 * record'`, with the zod error attached as `cause` for callers that want the
 * detail) or a plain string, used VERBATIM as the message — the tenant-mode
 * check has one fixed sentence to show the operator, not a zod issue tree.
 */
export class InvalidServerRecordError extends Error {
  constructor(reason: unknown) {
    const isPlainReason = typeof reason === 'string'
    super(isPlainReason ? reason : 'invalid server record', isPlainReason ? undefined : { cause: reason })
    this.name = 'InvalidServerRecordError'
  }
}

/**
 * Raised by `addServer` (tenant mode) once the registry already holds
 * `tenant.limits.servers` records: a hosted install caps its own resource use
 * per PRD `hosted-accounts` HA7, on WRITE only — see the GOTCHA on
 * `createRegistryStore` for why reading a larger, pre-existing document must
 * never fail the same way.
 */
export class TooManyServersError extends Error {
  constructor(max: number) {
    super(`too many servers: max ${max} (tenant mode)`)
    this.name = 'TooManyServersError'
  }
}

/** Result of `removeServer`: the removed record, or a typed not-found. */
export type RemoveServerResult =
  | { readonly status: 'removed'; readonly record: ServerRecord }
  | { readonly status: 'not-found' }

/** Result of `updateServer`: the stored record, or a typed not-found. */
export type UpdateServerResult =
  | { readonly status: 'updated'; readonly record: ServerRecord }
  | { readonly status: 'not-found' }

export interface RegistryStore {
  /** Adds a record; rejects with `DuplicateServerError` if the name is taken. */
  addServer(record: ServerRecord): Promise<ServerRecord>
  /** Removes by name; never throws for a missing name (typed result instead). */
  removeServer(name: string): Promise<RemoveServerResult>
  /**
   * Replaces the record stored under `record.name` (the name itself is the
   * key and cannot change here — renaming would silently orphan agent grants,
   * inventory and quarantine state, which are all keyed by name). Validates
   * like `addServer`; typed not-found when nothing is stored under the name.
   */
  updateServer(record: ServerRecord): Promise<UpdateServerResult>
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

/**
 * `true` when `record` is an http(s) record whose `url` is not `https:`.
 * `url` is already a validated absolute http(s) URL by the time a caller
 * holds a `ServerRecord`, so re-parsing it here never throws.
 */
function isNonHttpsHttpRecord(record: ServerRecord): boolean {
  return record.transport === 'http' && new URL(record.url).protocol !== 'https:'
}

/**
 * `true` when an http(s) record's URL names a port other than the scheme's
 * default (O8, tenant-orchestrator plan: "reaches only port 443"). The
 * WHATWG URL parser already normalizes an explicit default port away
 * (`new URL('https://x:443').port === ''`), so an https record with a
 * non-empty `.port` names an EXPLICIT, non-default one.
 */
function hasNonDefaultPort(record: ServerRecord): boolean {
  return record.transport === 'http' && new URL(record.url).port !== ''
}

/**
 * Tenant-mode gate shared by `addServer` and `updateServer`, run BEFORE
 * `store.update`: both checks are static properties of the record itself
 * (transport, url scheme/port), not of the current document, so there is
 * nothing to gain from running them inside the CAS-retried callback.
 */
function assertTenantAllowsServer(record: ServerRecord, tenant: TenantSettings): void {
  if (record.transport === 'stdio') {
    if (tenant.stdioServers === 'refused') {
      throw new StdioServerRefusedError(record.name)
    }
    return
  }
  if (tenant.upstreams !== 'public-https') return
  if (isNonHttpsHttpRecord(record)) {
    throw new InvalidServerRecordError('url: this install reaches only https servers (tenant mode)')
  }
  if (hasNonDefaultPort(record)) {
    throw new InvalidServerRecordError('url: this install reaches only port 443 (tenant mode)')
  }
}

export interface RegistryStoreOptions {
  /** Tenant settings this store enforces on write. Defaults to `TENANT_SETTINGS`. */
  readonly tenant?: TenantSettings
}

/**
 * GOTCHA (PRD `hosted-accounts` phase 1, task 7): the `tenant.limits.servers`
 * ceiling is enforced ONLY here, on write (`addServer`) — never in the read
 * schema. A tenant mode turned on over an already-large install (more
 * records than the new limit) must keep reading that document fine;
 * `registryFileSchema`'s own ceiling (`MAX_SERVERS_IN_REGISTRY` = 200) is
 * untouched and still the only thing `validateRegistry` enforces.
 */
export function createRegistryStore(journalDir?: string, opts?: RegistryStoreOptions): RegistryStore {
  const tenant = opts?.tenant ?? TENANT_SETTINGS
  const store: JsonStore<RegistryFile> = createJsonStore(registryFilePath(journalDir), {
    validate: validateRegistry,
    defaultValue: EMPTY_REGISTRY,
  })

  async function addServer(record: ServerRecord): Promise<ServerRecord> {
    const parsed = parseServerRecord(record)
    if (!parsed.ok) {
      throw new InvalidServerRecordError(parsed.error)
    }
    const validated = parsed.record
    assertTenantAllowsServer(validated, tenant)

    await store.update((current) => {
      if (ownRecord(current.servers, validated.name) !== undefined) {
        throw new DuplicateServerError(validated.name)
      }
      if (tenant.isTenant && Object.keys(current.servers).length >= tenant.limits.servers) {
        throw new TooManyServersError(tenant.limits.servers)
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

  async function updateServer(record: ServerRecord): Promise<UpdateServerResult> {
    const parsed = parseServerRecord(record)
    if (!parsed.ok) {
      throw new InvalidServerRecordError(parsed.error)
    }
    const validated = parsed.record
    assertTenantAllowsServer(validated, tenant)
    // Reset per attempt: `update` may re-run the callback on a stolen lock.
    let updated = false
    await store.update((current) => {
      updated = false
      if (ownRecord(current.servers, validated.name) === undefined) {
        return current
      }
      updated = true
      return { ...current, servers: { ...current.servers, [validated.name]: validated } }
    })
    return updated ? { status: 'updated', record: validated } : { status: 'not-found' }
  }

  async function getServer(name: string): Promise<ServerRecord | undefined> {
    const current = await store.read()
    return ownRecord(current.servers, name)
  }

  async function listServers(): Promise<readonly ServerRecord[]> {
    const current = await store.read()
    return Object.values(current.servers).sort((a, b) => a.name.localeCompare(b.name))
  }

  return { addServer, updateServer, removeServer, getServer, listServers }
}
