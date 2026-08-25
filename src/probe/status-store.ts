import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import { REGISTRY_SERVER_NAME_PATTERN } from '../registry/constants.js'
import {
  NEVER_CHECKED,
  parseServerStatusFile,
  storedServerStatusSchema,
  type ProbeInitiator,
  type ProbedVia,
  type ProbingServerStatus,
  type ServerStatus,
  type ServerStatusFile,
  type StoredServerStatus,
} from './status-schema.js'

/**
 * Server-status store: the `server-status.json` document in
 * `<journalDir>/state.db`, built on the transactional `createJsonStore`
 * (rev-CAS, 0600/0700 — all inherited; pattern of `registry/store.ts`).
 *
 * Two writes exist, both CAS-committed:
 * - `beginProbe` — the `probing` marker, which is ALSO the cross-process
 *   dedup: a fresh marker (younger than `probingFreshForMs`, i.e. the probe
 *   timeout + slack supplied by the orchestrator) refuses a second writer; a
 *   stale one belongs to a crashed prober and is taken over.
 * - `recordResult` — the settled outcome; last writer wins per server.
 *
 * Cleanup is lazy: a write handed `registryNames` drops entries for servers
 * no longer in the registry — no background sweeper (O2: no timers).
 * The store never validates or redacts `error` semantically: the message is
 * pre-redacted by the probe pipeline and trusted verbatim.
 */

/** File name of the status document inside the journal directory. */
export const SERVER_STATUS_FILE_NAME = 'server-status.json'

/** Absolute path of the status document for a given journal directory. */
export function serverStatusFilePath(journalDir: string = JOURNAL_DIR): string {
  return join(journalDir, SERVER_STATUS_FILE_NAME)
}

/** Raised when a write names a server that cannot be a registry name. */
export class InvalidStatusServerNameError extends Error {
  constructor(name: string) {
    super(`invalid server name for status store: ${JSON.stringify(name)}`)
    this.name = 'InvalidStatusServerNameError'
  }
}

/** Raised when a result payload fails schema validation (would corrupt the document). */
export class InvalidStatusWriteError extends Error {
  constructor(cause: unknown) {
    super('invalid server-status entry', { cause })
    this.name = 'InvalidStatusWriteError'
  }
}

/** Common context of every write. */
export interface StatusWriteContext {
  readonly initiator: ProbeInitiator
  /**
   * Current registry names, when the caller has them: entries for servers
   * outside this list are dropped in the same CAS write (lazy cleanup). The
   * server being written is always kept.
   */
  readonly registryNames?: readonly string[]
}

/** Typed outcome of `beginProbe` — refusal is a state, not an error. */
export type BeginProbeResult =
  | { readonly status: 'started'; readonly entry: ProbingServerStatus }
  | { readonly status: 'already-probing'; readonly entry: ProbingServerStatus }

/** A settled probe outcome as the engine reports it; the store stamps time and initiator. */
export type ProbeResultInput =
  | { readonly status: 'alive'; readonly probedVia: ProbedVia; readonly initializeLatencyMs: number }
  | {
      readonly status: 'error' | 'unreachable' | 'vault-refused'
      /** Pre-redacted by the probe pipeline; stored verbatim. */
      readonly error: string
      readonly probedVia?: ProbedVia
    }

export interface ServerStatusStore {
  /** Status of one server; a missing entry reads as `never-checked`. */
  getStatus(name: string): Promise<ServerStatus>
  /** All persisted entries, keyed by server name. Returned values are private copies. */
  listStatuses(): Promise<Readonly<Record<string, StoredServerStatus>>>
  /**
   * CAS transition into `probing`. Refused (typed, not thrown) while another
   * writer's marker is still fresh; a stale marker is overwritten.
   */
  beginProbe(name: string, ctx: StatusWriteContext): Promise<BeginProbeResult>
  /** CAS write of a settled outcome; overwrites whatever the entry held. */
  recordResult(name: string, result: ProbeResultInput, ctx: StatusWriteContext): Promise<StoredServerStatus>
}

export interface ServerStatusStoreOptions {
  readonly journalDir?: string
  /**
   * Freshness window of a `probing` marker (probe timeout + slack). Injected
   * by the orchestrator, which owns the probe timing constants.
   */
  readonly probingFreshForMs: number
  /** Clock in epoch ms; injectable so dedup-window tests never race wall time. */
  readonly now?: () => number
}

const EMPTY_STATUS_FILE: ServerStatusFile = { version: 1, servers: {} }

/** `validate` for the underlying JSON store: throws on any invalid shape. */
function validateStatusFile(raw: unknown): ServerStatusFile {
  const result = parseServerStatusFile(raw)
  if (!result.ok) {
    throw result.error
  }
  return result.file
}

/** `Object.hasOwn` guard: a hostile name must read as absent, not resolve through the prototype. */
function ownEntry(servers: ServerStatusFile['servers'], name: string): StoredServerStatus | undefined {
  return Object.hasOwn(servers, name) ? servers[name] : undefined
}

/** Schema gate before anything reaches the document — an invalid entry must never persist. */
function validateEntry<T extends StoredServerStatus>(entry: T): T {
  const parsed = storedServerStatusSchema.safeParse(entry)
  if (!parsed.success) {
    throw new InvalidStatusWriteError(parsed.error)
  }
  return entry
}

/**
 * Lazy cleanup + upsert in one immutable step: with `registryNames` present,
 * entries outside the registry are dropped; `name` itself always survives.
 */
function withEntry(
  current: ServerStatusFile,
  name: string,
  entry: StoredServerStatus,
  registryNames: readonly string[] | undefined,
): ServerStatusFile {
  const kept =
    registryNames === undefined
      ? current.servers
      : Object.fromEntries(
          Object.entries(current.servers).filter(([key]) => key === name || registryNames.includes(key)),
        )
  return { ...current, servers: { ...kept, [name]: entry } }
}

export function createServerStatusStore(options: ServerStatusStoreOptions): ServerStatusStore {
  const { probingFreshForMs } = options
  const now = options.now ?? Date.now
  const store: JsonStore<ServerStatusFile> = createJsonStore(serverStatusFilePath(options.journalDir), {
    validate: validateStatusFile,
    defaultValue: EMPTY_STATUS_FILE,
  })

  function assertValidName(name: string): void {
    if (!REGISTRY_SERVER_NAME_PATTERN.test(name)) {
      throw new InvalidStatusServerNameError(name)
    }
  }

  function isFreshProbing(entry: StoredServerStatus, at: number): entry is ProbingServerStatus {
    return entry.status === 'probing' && at - Date.parse(entry.probeStartedAt) < probingFreshForMs
  }

  async function getStatus(name: string): Promise<ServerStatus> {
    const current = await store.read()
    return ownEntry(current.servers, name) ?? NEVER_CHECKED
  }

  async function listStatuses(): Promise<Readonly<Record<string, StoredServerStatus>>> {
    const current = await store.read()
    return current.servers
  }

  async function beginProbe(name: string, ctx: StatusWriteContext): Promise<BeginProbeResult> {
    assertValidName(name)
    // `update` may re-run the callback on a lost CAS race, so the captured
    // outcome is reset at the top of EVERY attempt (registry/store.ts lesson).
    let outcome: BeginProbeResult | undefined
    await store.update((current) => {
      outcome = undefined
      const at = now()
      const existing = ownEntry(current.servers, name)
      if (existing !== undefined && isFreshProbing(existing, at)) {
        outcome = { status: 'already-probing', entry: existing }
        return current
      }
      const entry: ProbingServerStatus = validateEntry({
        status: 'probing',
        probeStartedAt: new Date(at).toISOString(),
        initiator: ctx.initiator,
      })
      outcome = { status: 'started', entry }
      return withEntry(current, name, entry, ctx.registryNames)
    })
    if (outcome === undefined) {
      throw new Error('beginProbe committed without an outcome (bug)')
    }
    return outcome
  }

  async function recordResult(
    name: string,
    result: ProbeResultInput,
    ctx: StatusWriteContext,
  ): Promise<StoredServerStatus> {
    assertValidName(name)
    const entry = validateEntry({
      ...result,
      probedAt: new Date(now()).toISOString(),
      initiator: ctx.initiator,
    })
    await store.update((current) => withEntry(current, name, entry, ctx.registryNames))
    return entry
  }

  return { getStatus, listStatuses, beginProbe, recordResult }
}
