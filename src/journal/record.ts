import { ulid } from 'ulid'
import {
  MAX_INVALID_PAYLOAD_CHARS,
  MAX_PENDING_REQUESTS,
  MAX_VALID_PAYLOAD_CHARS,
  PAYLOAD_TRUNCATION_MARKER,
  RAW_REDACTION_OVERLAP_CHARS,
  REQUEST_CORRELATION_TTL_MS,
} from '../config.js'
import { normalizeKnownSecrets } from '../redact/known-secrets.js'
import { sealUnterminatedKeyBlock } from '../redact/patterns.js'
import { redact, redactString } from '../redact/redact.js'
import type { ClassifiedMessage, JsonRpcId } from '../protocol/classify.js'

/**
 * Builds tamper-evident journal records from classified JSON-RPC traffic.
 * `redact()` is the only path payloads take before landing on a record, so
 * there is no way to construct a record with an unredacted payload.
 */

/** Direction of proxied client/server traffic (as opposed to stderr). */
export type ClientServerDirection = 'client→server' | 'server→client'

/** Every direction a journal record can carry, including server stderr. */
export type JournalDirection = ClientServerDirection | 'server-stderr'

/** Journal-specific kind: classify()'s kinds plus synthetic 'stderr' and 'decision' kinds. */
export type JournalKind = ClassifiedMessage['kind'] | 'stderr' | 'decision'

/** Final disposition of one policy decision on a gated tool call. */
export type PolicyOutcome =
  | 'allow'
  | 'deny'
  | 'require-approval-pending'
  | 'approved'
  | 'denied-by-operator'
  | 'timeout'
  | 'quarantined'

/** Risk class a tool was resolved to at decision time. */
export type ToolClass = 'read' | 'write' | 'destructive'

/** Quarantine status of a tool's schema at decision time. */
export type QuarantineState = 'known' | 'new' | 'changed' | 'unknown'

/**
 * Everything a `decision`-kind record needs to explain why a tool call was
 * allowed, denied, quarantined or sent to approval. Carried on
 * `JournalRecord.decision`; the call's arguments (if any) go through
 * `redact()` like any other payload and land in `JournalRecord.payload`
 * instead, so this shape only ever holds short, structured fields.
 */
export interface DecisionInfo {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly quarantineState: QuarantineState
  readonly argsHash: string
  readonly approvalId?: string
  readonly latencyMs?: number
}

export interface JournalRecord {
  readonly id: string
  readonly ts: string
  readonly sessionId: string
  readonly direction: JournalDirection
  readonly kind: JournalKind
  readonly method?: string
  readonly rpcId?: JsonRpcId
  readonly payload: unknown
  readonly durationMs?: number
  readonly decision?: DecisionInfo
}

export interface RecordBuilderOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
  /** Max time to keep an unanswered request id for correlation. */
  readonly ttlMs?: number
  /**
   * Exact values this session's upstream was given (vault-resolved env and
   * header material, plus the registry literals beside them). See
   * `redact/known-secrets.ts` for why they need registering at all.
   */
  readonly knownSecrets?: readonly string[]
}

export interface RecordBuilder {
  /** Builds a redacted, immutable record from a classified message. */
  readonly buildRecord: (
    classified: ClassifiedMessage,
    direction: ClientServerDirection,
  ) => JournalRecord
  /** Builds a redacted, immutable record from a raw stderr text line. */
  readonly buildStderrRecord: (text: string) => JournalRecord
  /**
   * Adds to the known-secret set used by every subsequent record. Needed
   * because a session's upstream (and therefore its secrets) is resolved
   * AFTER its journal wiring exists — the stderr tap has to be handed to the
   * upstream at construction time. Registration is additive and the set is
   * replaced, never mutated.
   */
  readonly registerKnownSecrets: (values: readonly string[]) => void
}

interface PendingRequest {
  readonly requestedAtMs: number
}

/** Chars scanned by the raw-text redactor before anything is trimmed. */
const RAW_REDACTION_WINDOW_CHARS = MAX_INVALID_PAYLOAD_CHARS + RAW_REDACTION_OVERLAP_CHARS

/** Map key for a pending request: direction + id type + id value. */
type PendingKey = string

/** Pending requests are keyed by the direction the *request* travelled in. */
type PendingMap = Map<PendingKey, PendingRequest>

const OPPOSITE_DIRECTION: Readonly<Record<ClientServerDirection, ClientServerDirection>> = {
  'client→server': 'server→client',
  'server→client': 'client→server',
}

/**
 * Creates a stateful record builder for one proxy session. It keeps an
 * internal pending-request map so that a later response in the opposite
 * direction can be stamped with `durationMs`.
 *
 * Correlation choices (documented, not accidental):
 * - Entries are keyed by direction *and* id: a response only matches a
 *   request that travelled the other way. MCP is bidirectional, so a
 *   server-initiated request may reuse an id the client is also using, and
 *   an id-only key would cross-correlate the two.
 * - Ids are keyed by type as well as value, so numeric 1 and string "1"
 *   never collide. `id: null` is never tracked or correlated at all.
 * - If the same request id arrives again before its response, the newer
 *   request replaces the pending entry: "later request wins", and duration
 *   is measured from that newer request.
 * - A response is correlated at most once; once matched, the pending entry
 *   is removed, so a duplicate response id yields no durationMs.
 * - Pending entries older than `ttlMs` are evicted lazily on every call, so
 *   a very late response is treated as uncorrelated rather than reporting a
 *   misleadingly huge duration.
 * - The map is capped at MAX_PENDING_REQUESTS entries; a peer that never
 *   answers cannot grow it without bound.
 */
export function createRecordBuilder(
  sessionId: string,
  opts: RecordBuilderOptions = {},
): RecordBuilder {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? REQUEST_CORRELATION_TTL_MS
  const pending: PendingMap = new Map()
  let knownSecrets = normalizeKnownSecrets(opts.knownSecrets ?? [])

  function registerKnownSecrets(values: readonly string[]): void {
    knownSecrets = normalizeKnownSecrets([...knownSecrets, ...values])
  }

  function buildRecord(
    classified: ClassifiedMessage,
    direction: ClientServerDirection,
  ): JournalRecord {
    const nowMs = now()
    evictExpired(pending, nowMs, ttlMs)

    const durationMs =
      classified.kind === 'response'
        ? correlate(pending, OPPOSITE_DIRECTION[direction], classified.id, nowMs)
        : undefined
    if (classified.kind === 'request') {
      rememberRequest(pending, direction, classified.id, nowMs)
    }

    return finalizeRecord({
      sessionId,
      direction,
      kind: classified.kind,
      method: methodOf(classified, knownSecrets),
      rpcId: idOf(classified, knownSecrets),
      payload: buildPayload(classified.raw, knownSecrets),
      durationMs,
      nowMs,
    })
  }

  function buildStderrRecord(text: string): JournalRecord {
    return finalizeRecord({
      sessionId,
      direction: 'server-stderr',
      kind: 'stderr',
      method: undefined,
      rpcId: undefined,
      payload: redactRawLine(text, knownSecrets),
      durationMs: undefined,
      nowMs: now(),
    })
  }

  return { buildRecord, buildStderrRecord, registerKnownSecrets }
}

interface FinalizeArgs {
  readonly sessionId: string
  readonly direction: JournalDirection
  readonly kind: JournalKind
  readonly method: string | undefined
  readonly rpcId: JsonRpcId | undefined
  readonly payload: unknown
  readonly durationMs: number | undefined
  readonly nowMs: number
}

/** Assembles and freezes the final record, omitting unset optional fields. */
function finalizeRecord(args: FinalizeArgs): JournalRecord {
  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(args.nowMs).toISOString(),
    sessionId: args.sessionId,
    direction: args.direction,
    kind: args.kind,
    payload: args.payload,
    ...(args.method !== undefined ? { method: args.method } : {}),
    ...(args.rpcId !== undefined ? { rpcId: args.rpcId } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
  }
  return Object.freeze(record)
}

/**
 * Extracts the JSON-RPC method for kinds that carry one, redacted: a method
 * name is attacker-influenced text and must go through the same string
 * redaction as everything else before it reaches the journal.
 */
function methodOf(
  classified: ClassifiedMessage,
  knownSecrets: readonly string[],
): string | undefined {
  const method =
    classified.kind === 'request' || classified.kind === 'notification' ? classified.method : undefined
  return method === undefined ? undefined : redactString(method, knownSecrets)
}

/**
 * Extracts the JSON-RPC id for kinds that carry one. Numeric and null ids
 * cannot carry a secret and pass through unchanged; a string id is redacted
 * like any other attacker-influenced string.
 */
function idOf(
  classified: ClassifiedMessage,
  knownSecrets: readonly string[],
): JsonRpcId | undefined {
  const id = classified.kind === 'request' || classified.kind === 'response' ? classified.id : undefined
  return typeof id === 'string' ? redactString(id, knownSecrets) : id
}

/** Builds the direction- and type-qualified key for one pending request. */
function pendingKey(direction: ClientServerDirection, id: JsonRpcId): PendingKey {
  return `${direction}\u0000${typeof id}\u0000${String(id)}`
}

/**
 * Records a request as pending. `id: null` is not correlatable, so it is
 * ignored. Existing entries are deleted before being re-added so that the
 * map's insertion order stays in timestamp order, which both eviction paths
 * rely on.
 */
function rememberRequest(
  pending: PendingMap,
  direction: ClientServerDirection,
  id: JsonRpcId,
  nowMs: number,
): void {
  if (id === null) {
    return
  }
  const key = pendingKey(direction, id)
  pending.delete(key)
  evictOldest(pending, MAX_PENDING_REQUESTS - 1)
  pending.set(key, { requestedAtMs: nowMs })
}

/** Marks a pending response as resolved and returns its elapsed duration, if any. */
function correlate(
  pending: PendingMap,
  requestDirection: ClientServerDirection,
  id: JsonRpcId,
  nowMs: number,
): number | undefined {
  if (id === null) {
    return undefined
  }
  const key = pendingKey(requestDirection, id)
  const match = pending.get(key)
  if (!match) {
    return undefined
  }
  pending.delete(key)
  return nowMs - match.requestedAtMs
}

/**
 * Removes pending requests older than `ttlMs` so late responses go
 * uncorrelated. Insertion order is timestamp order, so the first entry that
 * is still fresh ends the sweep: cost is O(evicted), not O(pending).
 */
function evictExpired(pending: PendingMap, nowMs: number, ttlMs: number): void {
  for (const [key, entry] of pending) {
    if (nowMs - entry.requestedAtMs <= ttlMs) {
      return
    }
    pending.delete(key)
  }
}

/** Drops oldest-first until at most `maxEntries` remain. */
function evictOldest(pending: PendingMap, maxEntries: number): void {
  while (pending.size > maxEntries) {
    const oldest = pending.keys().next()
    if (oldest.done === true) {
      return
    }
    pending.delete(oldest.value)
  }
}

/**
 * Builds the redacted payload for a record from a raw protocol line.
 * Parseable JSON is redacted structurally; unparseable raw text takes the
 * capped raw path, because that carrier also receives oversize framer
 * flushes and stderr noise.
 */
function buildPayload(raw: string, knownSecrets: readonly string[]): unknown {
  const parsed = tryParseJson(raw)
  return parsed.ok
    ? capValidPayload(redact(parsed.value, knownSecrets))
    : redactRawLine(raw, knownSecrets)
}

/**
 * Caps a redacted, structurally-valid payload at MAX_VALID_PAYLOAD_CHARS.
 * `redact()` has already run over the full structure before this point, so
 * truncating the *serialized redacted* form can only ever cut through
 * already-scrubbed text (or land well past it) -- it cannot re-expose an
 * unredacted secret. Well-formed multi-megabyte tool results (base64 images,
 * etc.) are stored truncated with a marker instead of landing whole.
 */
function capValidPayload(redactedPayload: unknown): unknown {
  const serialized = JSON.stringify(redactedPayload)
  if (serialized.length <= MAX_VALID_PAYLOAD_CHARS) {
    return redactedPayload
  }
  return `${serialized.slice(0, MAX_VALID_PAYLOAD_CHARS)}${PAYLOAD_TRUNCATION_MARKER}`
}

/**
 * Redacts and size-caps a raw, unparsed line (invalid protocol line, framer
 * overflow, stderr).
 *
 * Order is load-bearing: redaction runs before trimming, and over a window
 * that extends past the cap, so a secret straddling the cut is matched whole
 * instead of surviving as a prefix. Whatever the trim leaves behind is then
 * checked for a decapitated key block.
 */
function redactRawLine(raw: string, knownSecrets: readonly string[]): string {
  const wasWindowed = raw.length > RAW_REDACTION_WINDOW_CHARS
  const redacted = redactString(raw.slice(0, RAW_REDACTION_WINDOW_CHARS), knownSecrets)
  const wasTrimmed = redacted.length > MAX_INVALID_PAYLOAD_CHARS
  const capped = sealUnterminatedKeyBlock(redacted.slice(0, MAX_INVALID_PAYLOAD_CHARS))
  return wasTrimmed || wasWindowed ? `${capped}${PAYLOAD_TRUNCATION_MARKER}` : capped
}

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function tryParseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}
