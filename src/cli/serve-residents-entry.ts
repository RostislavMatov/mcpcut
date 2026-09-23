import type { AgentRecord } from '../agents/schema.js'
import { canonicalJson, sha256Hex } from '../policy/hash.js'
import type { ResidentPair } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import { REFUSAL_INVALID_VAULT_REFS, REFUSAL_MISSING_SECRETS, REFUSAL_VAULT_ERROR } from './serve-constants.js'
import type { HeldSession } from './serve-held.js'
import type { ProcessSlot, StartJob, StartResult } from './serve-residents-start.js'

/**
 * One supervised (agent, stdio server) pair and the pure rules about it
 * (ADR-0016): what state it is in, whether its process is out of date, how
 * long to wait before the next restart. Split from `serve-residents.ts` so the
 * supervisor keeps to the transitions and this file keeps to the facts.
 */

export type Lifetime = 'warm' | 'resident'

/**
 * `starting` — a start is queued or running (`startPromise`);
 * `ready` — the process is up, nobody attached;
 * `attached` — a pool session of this agent holds it;
 * `backoff` — it ended on its own, and restarts after a pause (RS6);
 * `failed` — too many failed starts in a row; waits for a change (RS6).
 */
export type EntryState = 'starting' | 'ready' | 'attached' | 'backoff' | 'failed'

export interface Entry {
  readonly key: string
  readonly pair: ResidentPair
  readonly lifetime: Lifetime
  readonly state: EntryState
  /** The newest record the supervisor was given for this server. */
  readonly record: StdioServerRecord
  /** `recordHashOf` the record the RUNNING process was started with. */
  readonly startedHash?: string
  readonly held?: HeldSession
  readonly slot?: ProcessSlot
  readonly fingerprint?: string
  readonly knownSecrets?: readonly string[]
  readonly startPromise?: Promise<StartResult>
  /** Failed starts (or ends) in a row since the last time it was ready. */
  readonly failures: number
  /** Leaves when its current attachment lets go (grant gone while attached). */
  readonly isRetiring: boolean
  /** When a warm entry last became idle; the eviction order (RS7). */
  readonly idleSince?: number
}

export function recordHashOf(record: StdioServerRecord): string {
  return sha256Hex(canonicalJson(record))
}

/** The running process no longer matches the newest record: restart once free. */
export function isStale(entry: Entry): boolean {
  return entry.startedHash !== undefined && entry.startedHash !== recordHashOf(entry.record)
}

export function commandKeyOf(record: StdioServerRecord): string {
  return JSON.stringify([record.command, ...(record.args ?? [])])
}

/**
 * The entry without anything that belongs to one particular process: what is
 * left once that process is gone (or before the next one exists).
 */
export function bare(entry: Entry): Entry {
  const { held: _held, slot: _slot, startPromise: _start, fingerprint: _fp, knownSecrets: _secrets, ...rest } = entry
  return rest
}

/** The entry with no idle mark (it is attached, or no longer warm). */
export function busy(entry: Entry): Entry {
  const { idleSince: _idle, ...rest } = entry
  return rest
}

export function newEntry(key: string, pair: ResidentPair, record: StdioServerRecord, lifetime: Lifetime): Entry {
  return { key, pair, lifetime, state: 'starting', record, failures: 0, isRetiring: false }
}

export function jobOf(entry: Entry, agent: AgentRecord): StartJob {
  return { key: entry.key, pair: entry.pair, commandKey: commandKeyOf(entry.record), agent, record: entry.record }
}

/** 1, 2, 4, 8 … seconds after the n-th failure in a row, never past `maxMs` (RS6). */
export function backoffDelayMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), maxMs)
}

/**
 * The fresh agent record a start may use, or why not. Read again for every
 * start — an entry restarted a minute later must not hand its session a grant
 * matrix from before, or the session's gate would end it at the door.
 */
export function startableAgent(agent: AgentRecord | undefined, pair: ResidentPair): AgentRecord | null {
  if (agent === undefined || agent.revokedAt !== undefined) return null
  if (agent.createdAt !== pair.agentCreatedAt) return null
  return Object.hasOwn(agent.grants, pair.serverName) ? agent : null
}

/** The refusal an agent sees for a start that did not produce a server. */
export function refusalOfStart(reason: string): string {
  return reason === 'no-slot' ? 'pool-full' : reason
}

/** Idle warm entries, longest idle first: the order they yield in (RS7). */
export function idleWarmOf(entries: readonly Entry[]): Entry[] {
  return entries
    .filter((entry) => entry.lifetime === 'warm' && entry.state === 'ready')
    .sort((left, right) => (left.idleSince ?? 0) - (right.idleSince ?? 0))
}

/** `promise`, or `null` if it has not settled within `ms`. */
export async function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (promise === undefined) return null
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms)).unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function vaultRefusal(result: Exclude<ResolveVaultRefsResult, { readonly status: 'resolved' }>): string {
  if (result.status === 'missing-secrets') return REFUSAL_MISSING_SECRETS
  if (result.status === 'invalid-refs') return REFUSAL_INVALID_VAULT_REFS
  return REFUSAL_VAULT_ERROR
}
