import { ulid } from 'ulid'
import { REQUEST_CORRELATION_TTL_MS } from '../config.js'
import { redact } from '../redact/redact.js'
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

/** Journal-specific kind: classify()'s kinds plus a synthetic 'stderr' kind. */
export type JournalKind = ClassifiedMessage['kind'] | 'stderr'

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
}

export interface RecordBuilderOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
  /** Max time to keep an unanswered request id for correlation. */
  readonly ttlMs?: number
}

export interface RecordBuilder {
  /** Builds a redacted, immutable record from a classified message. */
  readonly buildRecord: (
    classified: ClassifiedMessage,
    direction: ClientServerDirection,
  ) => JournalRecord
  /** Builds a redacted, immutable record from a raw stderr text line. */
  readonly buildStderrRecord: (text: string) => JournalRecord
}

interface PendingRequest {
  readonly requestedAtMs: number
}

/**
 * Creates a stateful record builder for one proxy session. It keeps an
 * internal pending-request map (id -> request timestamp) so that a later
 * response in the opposite direction can be stamped with `durationMs`.
 *
 * Correlation choices (documented, not accidental):
 * - If the same request id arrives again before its response, the newer
 *   request replaces the pending entry: "later request wins", and duration
 *   is measured from that newer request.
 * - A response is correlated at most once; once matched, the pending entry
 *   is removed, so a duplicate response id yields no durationMs.
 * - Pending entries older than `ttlMs` are evicted lazily on every call, so
 *   a very late response is treated as uncorrelated rather than reporting a
 *   misleadingly huge duration.
 */
export function createRecordBuilder(
  sessionId: string,
  opts: RecordBuilderOptions = {},
): RecordBuilder {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? REQUEST_CORRELATION_TTL_MS
  const pending = new Map<JsonRpcId, PendingRequest>()

  function buildRecord(
    classified: ClassifiedMessage,
    direction: ClientServerDirection,
  ): JournalRecord {
    const nowMs = now()
    evictExpired(pending, nowMs, ttlMs)

    const durationMs = classified.kind === 'response' ? correlate(pending, classified.id, nowMs) : undefined
    if (classified.kind === 'request') {
      pending.set(classified.id, { requestedAtMs: nowMs })
    }

    return finalizeRecord({
      sessionId,
      direction,
      kind: classified.kind,
      method: methodOf(classified),
      rpcId: idOf(classified),
      payload: buildPayload(classified.raw),
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
      payload: redact(text),
      durationMs: undefined,
      nowMs: now(),
    })
  }

  return { buildRecord, buildStderrRecord }
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

/** Extracts the JSON-RPC method for kinds that carry one. */
function methodOf(classified: ClassifiedMessage): string | undefined {
  return classified.kind === 'request' || classified.kind === 'notification'
    ? classified.method
    : undefined
}

/** Extracts the JSON-RPC id for kinds that carry one. */
function idOf(classified: ClassifiedMessage): JsonRpcId | undefined {
  return classified.kind === 'request' || classified.kind === 'response' ? classified.id : undefined
}

/** Marks a pending response as resolved and returns its elapsed duration, if any. */
function correlate(
  pending: Map<JsonRpcId, PendingRequest>,
  id: JsonRpcId,
  nowMs: number,
): number | undefined {
  const match = pending.get(id)
  if (!match) {
    return undefined
  }
  pending.delete(id)
  return nowMs - match.requestedAtMs
}

/** Removes pending requests older than `ttlMs` so late responses go uncorrelated. */
function evictExpired(pending: Map<JsonRpcId, PendingRequest>, nowMs: number, ttlMs: number): void {
  for (const [id, entry] of pending) {
    if (nowMs - entry.requestedAtMs > ttlMs) {
      pending.delete(id)
    }
  }
}

/**
 * Builds the redacted payload for a record from a raw protocol line.
 * Parseable JSON is redacted structurally; unparseable raw text still gets
 * value-pattern (e.g. Bearer token) redaction as a plain string.
 */
function buildPayload(raw: string): unknown {
  const parsed = tryParseJson(raw)
  return parsed.ok ? redact(parsed.value) : redact(raw)
}

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function tryParseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}
