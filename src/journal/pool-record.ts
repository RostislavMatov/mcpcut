import { ulid } from 'ulid'
import { normalizeKnownSecrets } from '../redact/known-secrets.js'
import { redact, redactString } from '../redact/redact.js'
import type { ClientServerDirection, JournalRecord } from './record.js'

/**
 * The pool-record vocabulary and builder: what a `kind: 'pool'` journal
 * record says about one moment of an agent's pool session (ADR-0015 §8).
 *
 * Split out of `record.ts` the same way `probe-record.ts` and
 * `policy-edit-record.ts` were: `record.ts` owns the traffic-record builder
 * and stays the contract point (it re-exports these types), this module owns
 * the pool side.
 *
 * What makes this record different from a probe's or a policy edit's: those
 * events are SESSIONLESS and ride reserved session ids, because nothing about
 * them is a conversation. A pool event is the opposite — the session IS the
 * subject. `open` and `close` bound its life and `attach` names each child
 * session by its own journal id, which is the only binding a report has
 * between what an agent asked the pool and what each upstream was told. A
 * reserved id would collapse every pool of every agent into one ledger.
 *
 * Layering: the journal must not depend on `src/pool/**` (the pool depends on
 * the journal, not the other way round), so the event and reason unions are
 * declared here in journal terms.
 */

/** Direction a pool record is stamped with: the plane spoke as the client. */
const POOL_DIRECTION: ClientServerDirection = 'client→server'

/** What a `kind: 'pool'` record is about. */
export type PoolEventKind =
  /** The pool session was opened for an agent. */
  | 'open'
  /** A child session for one server came up. */
  | 'attach'
  /** It did not (PE6) — the pool opens without that server. */
  | 'attach-refused'
  /** A child session went away. */
  | 'detach'
  /** The set of servers in the pool moved; `members` is the new one. */
  | 'members-changed'
  /** A frame the pool refused to pass on, with its reason. */
  | 'dropped'
  /** The pool session ended. */
  | 'close'

/** Why the pool refused to pass a frame on. */
export type PoolDropReason =
  /** An upstream sent a REQUEST; PE3 declares no client capabilities to any. */
  | 'server-request'
  /** A reply whose id is not in flight at that server (ADR-0015 §3). */
  | 'uncorrelated-reply'
  /** A `<server>__<tool>` naming a server outside this agent's pool. */
  | 'unknown-target'
  /** A method the pool declares no capability for. */
  | 'unsupported-method'
  /** A frame the pool could not read at all (no id to answer, malformed). */
  | 'unreadable'
  /** An entry left out of the merged catalog: its pool name is too long (PE2). */
  | 'name-too-long'
  /** An id the agent reused while its first request was still in flight. */
  | 'duplicate-id'
  /** The pool already tracks as many requests as it will (fail closed). */
  | 'at-capacity'
  /** An id in the range the plane reserves for its own upstream requests. */
  | 'reserved-id'
  /**
   * A notification an upstream had no standing to send: progress on a token
   * the agent gave another server's call, or after that call was answered.
   */
  | 'unscoped-notification'

/**
 * Everything a `pool`-kind record says. Flat and short by design: the frames
 * themselves are journaled by the CHILD sessions, under their bare tool names
 * (PE11), so nothing here duplicates traffic — these fields say who, which
 * server, and which child, and nothing else.
 */
export interface PoolRecordInfo {
  readonly agentName: string
  readonly event: PoolEventKind
  /** The server this event is about; absent on `open`/`close`. */
  readonly serverName?: string
  /** Journal session id of the child session — the binding a report needs. */
  readonly childSessionId?: string
  /** Servers in the pool at this moment, sorted; on `open` and membership changes. */
  readonly members?: readonly string[]
  /** A `PoolDropReason`, a refusal code, or prose — always redacted. */
  readonly reason?: string
  /** The JSON-RPC method the event is about, when there is one. */
  readonly method?: string
  /** Names left out of the merged catalog, too long for known clients (PE2). */
  readonly hiddenNames?: readonly string[]
  /** Names listed but past the warn threshold (PE2). */
  readonly warnedNames?: readonly string[]
}

export interface BuildPoolRecordInput {
  /** The pool session's OWN journal session id, minted per session. */
  readonly sessionId: string
  readonly pool: PoolRecordInfo
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
  /**
   * Exact secret values this pool's upstreams were given. Applied to the fields
   * a SERVER can influence — see the builder for why the plane's own
   * identifiers are pattern-redacted but never matched against these.
   */
  readonly knownSecrets?: readonly string[]
}

/**
 * Builds a frozen, redacted `kind: 'pool'` record. The info travels as the
 * record's `payload` and goes through `redact()` whole — the single path into
 * the journal — a choke point that covers every present and future producer the
 * same way `decision.ts` covers `actor`.
 *
 * Exact-value redaction is applied to the fields a SERVER can influence, and
 * to those only:
 *
 *  - `reason` — a refusal, which can carry an `Error` message;
 *  - `method` — on a dropped server-initiated request, the method that server
 *    chose to send;
 *  - `hiddenNames` / `warnedNames` — tool and prompt names the server reported,
 *    so an upstream handed a vault value could name a tool after it.
 *
 * Everything else is the record's SUBJECT — which agent, which server, which
 * members, which child session — and those names are the PLANE's, taken from
 * its own registry. Matching them against known secrets made the audit trail
 * unreadable the moment an operator put a server's name in one of that server's
 * own environment values: the line then said a child attached to `[REDACTED]`.
 * Pattern redaction still applies to all of it.
 *
 * `method` mirrors `info.method` so the generic method filter works on pool
 * records with no pool-specific code.
 */
export function buildPoolRecord(input: BuildPoolRecordInput): JournalRecord {
  const now = input.clock ?? Date.now
  // The 8-character floor the rest of the journal applies: a short value
  // ("alpha", "true") occurs in unrelated text constantly.
  const secrets = normalizeKnownSecrets(input.knownSecrets ?? [])
  const info = withServerTextRedacted(input.pool, secrets)
  const payload = redact(flatInfoOf(info))
  const method = info.method

  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(now()).toISOString(),
    sessionId: input.sessionId,
    direction: POOL_DIRECTION,
    kind: 'pool',
    payload,
    ...(method !== undefined ? { method } : {}),
  }
  return Object.freeze(record)
}

/**
 * The same info with every server-influenced field matched against `secrets`.
 * Absent stays absent: this rebuilds only what is present.
 */
function withServerTextRedacted(
  pool: PoolRecordInfo,
  secrets: readonly string[],
): PoolRecordInfo {
  if (secrets.length === 0) {
    return pool
  }
  const clean = (text: string): string => redactString(text, secrets)
  return {
    ...pool,
    ...(pool.reason !== undefined ? { reason: clean(pool.reason) } : {}),
    ...(pool.method !== undefined ? { method: clean(pool.method) } : {}),
    ...(pool.hiddenNames !== undefined ? { hiddenNames: pool.hiddenNames.map(clean) } : {}),
    ...(pool.warnedNames !== undefined ? { warnedNames: pool.warnedNames.map(clean) } : {}),
  }
}

/**
 * The payload object, assembled field by field so an absent optional stays
 * ABSENT instead of becoming an `undefined`-valued key (the codebase's
 * "absent, not null" convention — a pool `open` is about no one server, which
 * is a fact rather than a gap).
 */
function flatInfoOf(pool: PoolRecordInfo): Record<string, unknown> {
  return {
    agentName: pool.agentName,
    event: pool.event,
    ...(pool.serverName !== undefined ? { serverName: pool.serverName } : {}),
    ...(pool.childSessionId !== undefined ? { childSessionId: pool.childSessionId } : {}),
    ...(pool.members !== undefined ? { members: [...pool.members] } : {}),
    ...(pool.reason !== undefined ? { reason: pool.reason } : {}),
    ...(pool.method !== undefined ? { method: pool.method } : {}),
    ...(pool.hiddenNames !== undefined ? { hiddenNames: [...pool.hiddenNames] } : {}),
    ...(pool.warnedNames !== undefined ? { warnedNames: [...pool.warnedNames] } : {}),
  }
}
