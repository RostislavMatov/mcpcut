import { residentKeyOf, type DesiredResidents, type ResidentPair } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import { busy, isStale, newEntry, recordHashOf, type Entry } from './serve-residents-entry.js'

/**
 * What a reconcile does to the supervisor's entries (ADR-0016, RS4): the
 * transitions driven by grants and the registry rather than by agents. Split
 * from `serve-residents.ts` for the 400-line cap; the supervisor hands in the
 * few operations these transitions need, and keeps all of its state.
 *
 *  - A pair that should be resident and is not supervised starts.
 *  - A warm entry that became resident is promoted, without a restart.
 *  - A running entry whose record changed restarts once free (attached: when
 *    it is released); a failed one gets a fresh set of tries.
 *  - A pair no longer granted stops at once — or, when attached, retires: the
 *    session's own watch ends it within the poll interval anyway (DR1).
 *  - A resident pushed past the cap becomes warm and ages out like one.
 */

export interface DesiredOps {
  get(key: string): Entry | undefined
  list(): readonly Entry[]
  put(entry: Entry): Entry
  start(entry: Entry, priority: boolean, after?: Promise<void>): Entry
  shutDown(entry: Entry): Promise<void>
  remove(entry: Entry, why?: string): Promise<void>
  clearTimer(key: string): void
  goIdle(entry: Entry): void
  report(entry: Entry, message: string): void
}

export function applyDesiredTo(
  ops: DesiredOps,
  desired: DesiredResidents,
  records: ReadonlyMap<string, StdioServerRecord>,
): void {
  const wanted = new Map(desired.resident.map((pair) => [residentKeyOf(pair), pair]))
  const granted = new Set([...wanted.keys(), ...desired.overCap.map(residentKeyOf)])
  for (const [key, pair] of wanted) {
    const record = records.get(pair.serverName)
    if (record !== undefined) keepResident(ops, key, pair, record)
  }
  for (const entry of ops.list()) {
    if (wanted.has(entry.key)) continue
    if (!granted.has(entry.key)) retire(ops, entry)
    else if (entry.lifetime === 'resident') demote(ops, entry)
  }
}

function keepResident(ops: DesiredOps, key: string, pair: ResidentPair, record: StdioServerRecord): void {
  const known = ops.get(key)
  if (known === undefined) {
    ops.start(newEntry(key, pair, record, 'resident'), false)
    return
  }
  if (known.lifetime === 'warm' && known.state === 'ready') ops.clearTimer(key)
  const entry = ops.put({ ...busy(known), record, lifetime: 'resident', isRetiring: false })
  if (known.lifetime === 'warm') ops.report(entry, 'kept as a resident')
  const hasChanged = recordHashOf(record) !== recordHashOf(known.record)
  if (entry.state === 'ready' && isStale(entry)) {
    ops.start(entry, false, ops.shutDown(entry))
  } else if ((entry.state === 'failed' || entry.state === 'backoff') && hasChanged) {
    ops.start({ ...entry, failures: 0 }, false)
  }
}

function retire(ops: DesiredOps, entry: Entry): void {
  if (entry.state === 'attached' || entry.state === 'starting') {
    ops.put({ ...entry, isRetiring: true })
    return
  }
  void ops.remove(entry, 'stopped (no longer granted)')
}

function demote(ops: DesiredOps, entry: Entry): void {
  const warm = ops.put({ ...entry, lifetime: 'warm' })
  if (warm.state === 'ready') ops.goIdle(warm)
  else if (warm.state === 'backoff' || warm.state === 'failed') void ops.remove(warm)
}
