import type { PoolMemberDiscipline } from '../pool/handshake.js'
import { residentKeyOf, type ResidentPair } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import type { HeldAttachment } from './serve-held.js'
import {
  busy,
  isStale,
  newEntry,
  recordHashOf,
  refusalOfStart,
  vaultRefusal,
  within,
  type Entry,
  type Lifetime,
} from './serve-residents-entry.js'

/**
 * How a pool session gets its attachment to one held session (ADR-0016):
 * the agent-driven transitions, as `serve-residents-desired.ts` holds the
 * reconcile-driven ones. Split from `serve-residents.ts` for the 400-line
 * cap; the supervisor hands in the few operations these steps need and keeps
 * all of its state.
 *
 * An acquire walks the entry's state until it can answer: `attached`, `busy`
 * (another pool session of the same agent holds it), or a refusal with a
 * reason (BU3). A ready entry is attached only when its secrets still resolve
 * to the fingerprint it started with and its record is unchanged (RS4);
 * otherwise it is closed first and started again.
 */

export type AcquireResult =
  | {
      readonly status: 'attached'
      readonly attachment: HeldAttachment
      readonly discipline: PoolMemberDiscipline
      readonly lifetime: Lifetime
      readonly knownSecrets: readonly string[]
    }
  | { readonly status: 'busy' }
  | { readonly status: 'refused'; readonly reason: string }

export interface AcquireOps {
  get(key: string): Entry | undefined
  put(entry: Entry): Entry
  start(entry: Entry, priority: boolean, after?: Promise<void>): Entry
  shutDown(entry: Entry): Promise<void>
  clearTimer(key: string): void
  prioritize(key: string): void
  isSealed(): boolean
  now(): number
  resolveDeclared(record: StdioServerRecord): Promise<ResolveVaultRefsResult>
  fingerprintOf(record: StdioServerRecord, values: Readonly<Record<string, string>>): string
}

/** Steps one acquire may take before it gives up: a never-settling fingerprint cannot loop. */
const MAX_ACQUIRE_STEPS = 8

async function attachReady(ops: AcquireOps, entry: Entry, record: StdioServerRecord): Promise<AcquireResult | 'again'> {
  const values = await ops.resolveDeclared(record)
  if (values.status !== 'resolved') return { status: 'refused', reason: vaultRefusal(values) }
  const current = ops.get(entry.key)
  if (current !== entry || current.state !== 'ready') return 'again'
  if (ops.fingerprintOf(record, values.values) !== current.fingerprint || isStale(current)) {
    // RS4: a rotated secret or an edited record. Close first, THEN start:
    // two of one command line never run at once (BU4).
    ops.start({ ...current, record }, true, ops.shutDown(current))
    return 'again'
  }
  const held = current.held
  const attachment = held?.attach() ?? null
  if (held === undefined || attachment === null) return 'again'
  ops.clearTimer(current.key)
  ops.put({ ...busy(current), state: 'attached' })
  return {
    status: 'attached',
    attachment,
    discipline: held.info.discipline,
    lifetime: current.lifetime,
    knownSecrets: current.knownSecrets ?? [],
  }
}

export async function acquireWith(
  ops: AcquireOps,
  pair: ResidentPair,
  record: StdioServerRecord,
  deadline: number,
): Promise<AcquireResult> {
  const key = residentKeyOf(pair)
  for (let step = 0; step < MAX_ACQUIRE_STEPS; step += 1) {
    if (ops.isSealed()) return { status: 'refused', reason: 'pool-full' }
    const known = ops.get(key)
    const entry =
      known === undefined
        ? ops.start(newEntry(key, pair, record, 'warm'), true)
        : recordHashOf(known.record) === recordHashOf(record)
          ? known
          : ops.put({ ...known, record })
    if (entry.state === 'attached') return { status: 'busy' }
    if (entry.state === 'failed') return { status: 'refused', reason: 'start-failed' }
    if (entry.state === 'backoff') {
      ops.start(entry, true)
      continue
    }
    if (entry.state === 'starting') {
      ops.prioritize(key)
      const result = await within(entry.startPromise, deadline - ops.now())
      if (result === null) return { status: 'refused', reason: 'start-timeout' }
      if (!result.ok) return { status: 'refused', reason: refusalOfStart(result.reason) }
      continue
    }
    const attached = await attachReady(ops, entry, record)
    if (attached !== 'again') return attached
  }
  return { status: 'refused', reason: 'start-failed' }
}
