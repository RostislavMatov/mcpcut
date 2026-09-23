import type { PoolEventKind } from './pool-record.js'
import type { JournalRecord } from './record.js'
import type { ReportManifest } from './report.js'

/**
 * The pool ledger of an audit report (ADR-0015, phase-5 amendment, R1/R2/R5):
 * what the export's ONE pass learns about pool sessions from their
 * `kind:'pool'` records, so `summary.md` can say which child session carried
 * which server for which agent.
 *
 * It is fed from inside `streamRecords` -- the same pass, the same read view --
 * because everything a report claims has to describe one state of the journal
 * (the CRITICAL of M5 wave 5). It does not bind decisions to pools while
 * walking: the pool and each child write through different sinks with their
 * own batching, so a child's decisions can land in the journal BEFORE the
 * `attach` that names it (R2). The binding is made at render time, from every
 * `attach` the export holds ({@link childBindingsOf}).
 *
 * EVERY PAYLOAD HERE IS UNTRUSTED. A `kind:'pool'` row is only as honest as the
 * disk it was read from, so each one is checked field by field before it
 * counts, and one that does not read is COUNTED, never guessed at. Accumulators
 * live in this closure and leave it only as frozen copies.
 *
 * MEMORY IS BOUNDED even for a hostile journal (R5): at most
 * {@link MAX_SUMMARY_POOL_SESSIONS} sessions and {@link MAX_SUMMARY_POOL_EVENTS}
 * kept elements, a record that would exceed either is left out WHOLE and
 * counted. Nothing is lost as evidence -- every record is still in
 * `records.jsonl`; `summary.md` is the reading aid.
 *
 * Layering: imports nothing from `src/pool/**` -- the journal does not depend
 * on the pool (`pool-record.ts`).
 */

/** How many pool sessions the ledger keeps before it only counts. */
export const MAX_SUMMARY_POOL_SESSIONS = 500
/**
 * How many kept elements -- a child, a refusal, a departure, a new agent name,
 * a new dropped-frame reason -- the ledger holds across all sessions before it
 * only counts. A repeat of a known reason moves a counter and costs nothing.
 */
export const MAX_SUMMARY_POOL_EVENTS = 5000

export interface ReportPoolChild {
  readonly serverName: string
  readonly childSessionId: string
  /** When the `attach` record was written. */
  readonly ts: string
}

export interface ReportPoolServerNote {
  readonly serverName: string
  /** Absent when the record carried none. */
  readonly reason?: string
}

export interface ReportPoolSession {
  readonly sessionId: string
  /** Every agent name the session's records carried -- normally one; more are shown, not resolved. */
  readonly agentNames: readonly string[]
  /** `ts` of the first `open` record, absent when the export holds none. */
  readonly openedAt?: string
  /** `ts` of the last `close` record, absent when the export holds none. */
  readonly closedAt?: string
  /** `attach` records, in journal order. */
  readonly children: readonly ReportPoolChild[]
  /** `attach-refused` records (PE6). */
  readonly refused: readonly ReportPoolServerNote[]
  /** `detach` records. */
  readonly detached: readonly ReportPoolServerNote[]
  /** Dropped-frame reason -> count, keys in code-unit order. */
  readonly dropped: Readonly<Record<string, number>>
}

export interface ReportPoolTally {
  /** In order of first appearance. */
  readonly sessions: readonly ReportPoolSession[]
  /** Pool records left out by the memory bounds (R5). */
  readonly omittedRecordCount: number
  /** `kind:'pool'` records whose payload could not be read. */
  readonly unreadableCount: number
}

export interface ReportChildBinding {
  readonly poolSessionId: string
  readonly serverName: string
  readonly agentNames: readonly string[]
}

export interface PoolLedger {
  /** Feeds one parsed record; anything but a `kind:'pool'` record is ignored. */
  take(record: JournalRecord): void
  tally(): ReportPoolTally
}

export interface PoolLedgerLimits {
  readonly maxSessions?: number
  readonly maxEvents?: number
}

/**
 * The event kinds a payload may name. `satisfies Record<PoolEventKind, true>`
 * makes the compiler hold this set complete against the union, and the lookup
 * uses `Object.hasOwn` so `__proto__` or `toString` is not an event.
 */
const POOL_EVENT_KINDS = {
  open: true,
  attach: true,
  'attach-refused': true,
  detach: true,
  'members-changed': true,
  dropped: true,
  close: true,
} as const satisfies Record<PoolEventKind, true>

/** A payload that passed every check. */
interface ReadPayload {
  readonly agentName: string
  readonly event: PoolEventKind
  readonly serverName?: string
  readonly childSessionId?: string
  readonly reason?: string
}

interface SessionDraft {
  readonly sessionId: string
  readonly agentNames: string[]
  openedAt?: string
  closedAt?: string
  readonly children: ReportPoolChild[]
  readonly refused: ReportPoolServerNote[]
  readonly detached: ReportPoolServerNote[]
  readonly dropped: Map<string, number>
}

export function createPoolLedger(limits: PoolLedgerLimits = {}): PoolLedger {
  const maxSessions = limits.maxSessions ?? MAX_SUMMARY_POOL_SESSIONS
  const maxEvents = limits.maxEvents ?? MAX_SUMMARY_POOL_EVENTS
  const sessions = new Map<string, SessionDraft>()
  let eventsKept = 0
  let omittedRecordCount = 0
  let unreadableCount = 0

  function take(record: JournalRecord): void {
    if (record.kind !== 'pool') return
    const payload = readPayload(record.payload)
    if (payload === null) {
      unreadableCount += 1
      return
    }
    const existing = sessions.get(record.sessionId)
    if (existing === undefined && sessions.size >= maxSessions) {
      omittedRecordCount += 1
      return
    }
    const cost = costOf(existing, payload)
    if (eventsKept + cost > maxEvents) {
      omittedRecordCount += 1
      return
    }
    eventsKept += cost
    const draft = existing ?? newDraft(record.sessionId)
    sessions.set(record.sessionId, draft)
    apply(draft, payload, record.ts)
  }

  function tally(): ReportPoolTally {
    return Object.freeze({
      sessions: Object.freeze([...sessions.values()].map(frozenSessionOf)),
      omittedRecordCount,
      unreadableCount,
    })
  }

  return { take, tally }
}

/** How many kept elements applying `payload` would add. */
function costOf(draft: SessionDraft | undefined, payload: ReadPayload): number {
  const newAgent = draft === undefined || !draft.agentNames.includes(payload.agentName) ? 1 : 0
  switch (payload.event) {
    case 'attach':
    case 'attach-refused':
    case 'detach':
      return newAgent + 1
    case 'dropped':
      return newAgent + (draft?.dropped.has(payload.reason ?? '') === true ? 0 : 1)
    default:
      return newAgent
  }
}

function newDraft(sessionId: string): SessionDraft {
  return { sessionId, agentNames: [], children: [], refused: [], detached: [], dropped: new Map() }
}

/** Applies a checked payload; `readPayload` guarantees the fields each event needs. */
function apply(draft: SessionDraft, payload: ReadPayload, ts: string): void {
  if (!draft.agentNames.includes(payload.agentName)) draft.agentNames.push(payload.agentName)
  const serverName = payload.serverName ?? ''
  switch (payload.event) {
    case 'open':
      draft.openedAt ??= ts
      return
    case 'close':
      draft.closedAt = ts
      return
    case 'attach':
      draft.children.push({ serverName, childSessionId: payload.childSessionId ?? '', ts })
      return
    case 'attach-refused':
      draft.refused.push(noteOf(serverName, payload.reason))
      return
    case 'detach':
      draft.detached.push(noteOf(serverName, payload.reason))
      return
    case 'dropped': {
      const reason = payload.reason ?? ''
      draft.dropped.set(reason, (draft.dropped.get(reason) ?? 0) + 1)
      return
    }
    case 'members-changed':
      return
  }
}

function noteOf(serverName: string, reason: string | undefined): ReportPoolServerNote {
  return reason === undefined ? { serverName } : { serverName, reason }
}

/**
 * Reads an untrusted payload, or returns `null`. Each event must carry the
 * fields its line in `summary.md` names: an `attach` its server and child, a
 * refusal or a departure its server, a drop its reason.
 */
function readPayload(value: unknown): ReadPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  const event = payload['event']
  const agentName = payload['agentName']
  if (typeof event !== 'string' || !Object.hasOwn(POOL_EVENT_KINDS, event)) return null
  if (typeof agentName !== 'string' || agentName.length === 0) return null
  const serverName = optionalString(payload['serverName'])
  const childSessionId = optionalString(payload['childSessionId'])
  const reason = optionalString(payload['reason'])
  if (serverName === null || childSessionId === null || reason === null) return null
  const kind = event as PoolEventKind
  if (!carriesWhatItNames(kind, serverName, childSessionId, reason)) return null
  return {
    agentName,
    event: kind,
    ...(serverName === undefined ? {} : { serverName }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function carriesWhatItNames(
  event: PoolEventKind,
  serverName: string | undefined,
  childSessionId: string | undefined,
  reason: string | undefined,
): boolean {
  switch (event) {
    case 'attach':
      return serverName !== undefined && childSessionId !== undefined
    case 'attach-refused':
    case 'detach':
      return serverName !== undefined
    case 'dropped':
      return reason !== undefined
    default:
      return true
  }
}

/** A string, absent (`undefined`), or unreadable (`null`). */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

/**
 * The outward copy. `dropped` goes out through `Object.fromEntries`, not key
 * assignment: a reason is attacker-controlled, and assigning `__proto__` would
 * reach the prototype setter and lose the count (the same rule as
 * `report.ts`'s `countsOf`). Keys sort by plain code-unit comparison, never
 * `localeCompare`, so the order does not depend on the host's locale.
 */
function frozenSessionOf(draft: SessionDraft): ReportPoolSession {
  const dropped = Object.fromEntries(
    [...draft.dropped.keys()].sort(compareCodeUnits).map((reason) => [reason, draft.dropped.get(reason) ?? 0]),
  )
  return Object.freeze({
    sessionId: draft.sessionId,
    agentNames: Object.freeze([...draft.agentNames]),
    ...(draft.openedAt === undefined ? {} : { openedAt: draft.openedAt }),
    ...(draft.closedAt === undefined ? {} : { closedAt: draft.closedAt }),
    children: Object.freeze([...draft.children]),
    refused: Object.freeze([...draft.refused]),
    detached: Object.freeze([...draft.detached]),
    dropped: Object.freeze(dropped),
  })
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Child session id -> every pool session that named it in an `attach`.
 * Normally one; two means a forgery or a bug, and both are shown rather than
 * one picked. A pool naming the same child twice counts once.
 */
export function childBindingsOf(tally: ReportPoolTally): ReadonlyMap<string, readonly ReportChildBinding[]> {
  const bindings = new Map<string, ReportChildBinding[]>()
  for (const session of tally.sessions) {
    for (const child of session.children) {
      const claims = bindings.get(child.childSessionId) ?? []
      if (claims.some((claim) => claim.poolSessionId === session.sessionId)) continue
      bindings.set(child.childSessionId, [
        ...claims,
        { poolSessionId: session.sessionId, serverName: child.serverName, agentNames: session.agentNames },
      ])
    }
  }
  return bindings
}

/**
 * The child sessions of the exported pool session that the export leaves out
 * (R3): a `--session <pool>` export holds the pool's own records only, and the
 * decisions live in its children. Empty for a whole-journal export and for a
 * session that is not a pool session. Each child once, in journal order.
 */
export function childrenOutsideExport(
  tally: ReportPoolTally,
  manifest: Pick<ReportManifest, 'scope' | 'sessionIds'>,
): readonly string[] {
  const scoped = manifest.scope.session
  if (scoped === null) return []
  const session = tally.sessions.find((candidate) => candidate.sessionId === scoped)
  if (session === undefined) return []
  const exported = new Set(manifest.sessionIds)
  const outside = new Set<string>()
  for (const child of session.children) {
    if (!exported.has(child.childSessionId)) outside.add(child.childSessionId)
  }
  return [...outside]
}
