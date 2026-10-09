import { classify, type JsonRpcId } from '../protocol/classify.js'
import { parseToolCall } from '../protocol/mcp.js'
import { idKeyOf } from '../proxy/gate-helpers.js'
import type { SynthesizableId } from '../proxy/synthesize.js'

/**
 * Which calls the bridge sends again after a dropped connection, and under
 * what id (decision M39). Before M39 the bridge never retried: a `tools/call`
 * is not idempotent, and one the service may already have received could run
 * twice. A call that carries the client's tool-use id
 * (`_meta["claudecode/toolUseId"]`) is safe to send again: the service
 * recognises the same tool use and answers the resend with the first call's
 * answer — or joins the first call while it still runs — instead of running
 * it again (`proxy/gate-delivery.ts`). A call without one is still never
 * retried.
 *
 * Each attempt goes out under an id of the bridge's own: the service still
 * holds the first attempt's id until that call settles, so the same id again
 * would be refused as a duplicate. The answer comes back under the attempt's
 * id and is returned to the client under its original one. This is the one
 * place the bridge rewrites bytes; everything else crosses unchanged.
 */

/** Pauses before each further attempt; their count is the number of retries. */
export const BRIDGE_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 5_000]

/** The bridge's own ids for further attempts; cannot collide with a client's, which never carry it. */
export const BRIDGE_RETRY_ID_PREFIX = 'mcpcut-bridge-retry:'

/** A call the bridge may send again: its id and its body, to re-send under another id. */
export interface RetryableCall {
  readonly originalId: SynthesizableId
  readonly body: Readonly<Record<string, unknown>>
}

/** A `tools/call` with an id and a tool-use id, as sent; `null` for anything else. */
export function retryableCallOf(bytes: Buffer): RetryableCall | null {
  const text = bytes.toString('utf8')
  const message = classify(text)
  if (message.kind !== 'request' || message.id === null) return null
  const call = parseToolCall(message)
  if (call?.toolUseId === undefined) return null
  return { originalId: message.id, body: JSON.parse(text) as Record<string, unknown> }
}

/** `body` under `id`: the re-sent attempt. */
export function attemptBytes(call: RetryableCall, id: string): Buffer {
  return Buffer.from(JSON.stringify({ ...call.body, id }), 'utf8')
}

/**
 * `bytes` (a JSON-RPC object) under `id` instead of its own. Re-serialised: an
 * integer past 2^53 in the answer would lose precision — the same limit the
 * service's own replay of a kept answer has; MCP results are text content.
 */
export function withId(bytes: Buffer, id: JsonRpcId): Buffer {
  const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...parsed, id }), 'utf8')
}

/** A `notifications/cancelled` (JSON) naming `attemptId` instead of the request it named. */
export function cancelFor(bytes: Buffer, attemptId: string): Buffer {
  const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const params = (parsed['params'] ?? {}) as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...parsed, params: { ...params, requestId: attemptId } }), 'utf8')
}

/** Calls being re-sent at once, at most; past it the oldest is forgotten (and simply not retried again). */
const MAX_BOOK_CALLS = 1_024

/** Calls whose answer reached the client, remembered so a second answer for one id is dropped. */
const MAX_ANSWERED_REMEMBERED = 256

/** The bridge's ledger of calls it may send again (decision M39). */
export interface RetryBook {
  /** The call first sent as `originalId` may be sent again: from now on its cancel and its answer count. */
  begin(originalId: SynthesizableId): void
  /** A fresh id for the next attempt of the call first sent as `originalId`. */
  nextAttemptId(originalId: SynthesizableId): string
  /** The attempt now out failed: a cancel from here on goes under the original id. */
  attemptFailed(originalId: SynthesizableId): void
  /**
   * An answer under `id` is on its way to the client: the original id it belongs to (an attempt's answer is
   * moved back to it), `null` when it must be dropped — that call was already answered once — and `undefined`
   * when `id` is nobody the bridge re-sends.
   */
  answerFor(id: JsonRpcId): SynthesizableId | null | undefined
  /** The call already got its answer: no further attempt. */
  isAnswered(originalId: SynthesizableId): boolean
  /** The client cancelled `originalId`: no further attempt. Returns the attempt out now to cancel instead, if any. */
  cancel(originalId: JsonRpcId): string | undefined
  isCancelled(originalId: SynthesizableId): boolean
  /** Still being re-sent (not answered, cancelled, forgotten or pushed out by the bound). */
  isTracked(originalId: SynthesizableId): boolean
  /** The call is over: forget it (an attempt still out keeps its way back until its answer). */
  forget(originalId: SynthesizableId): void
  /** True while no call is being re-sent: answers then need no lookup at all. */
  isEmpty(): boolean
}

interface BookEntry {
  readonly originalId: SynthesizableId
  /** The attempt out now, if one is. */
  live: string | undefined
}

/** Adds `key` to a bounded, insertion-ordered set (oldest leaves first). */
function remember(set: Set<string>, key: string, max: number): void {
  set.delete(key)
  if (set.size >= max) set.delete(set.values().next().value as string)
  set.add(key)
}

export function createRetryBook(): RetryBook {
  let counter = 0
  /** Original id key -> the call (insertion order: oldest first). */
  const calls = new Map<string, BookEntry>()
  /** Attempt id -> original id: the way back for an attempt's answer. */
  const attempts = new Map<string, SynthesizableId>()
  /** Original id keys already answered once, and cancelled by the client (both bounded, oldest first). */
  const answered = new Set<string>()
  const cancelled = new Set<string>()

  function markAnswered(key: string): void {
    remember(answered, key, MAX_ANSWERED_REMEMBERED)
    calls.delete(key)
  }

  return {
    begin(originalId) {
      const key = idKeyOf(originalId)
      answered.delete(key)
      cancelled.delete(key)
      if (calls.size >= MAX_BOOK_CALLS) calls.delete(calls.keys().next().value as string)
      calls.set(key, { originalId, live: undefined })
    },
    nextAttemptId(originalId) {
      counter += 1
      const attemptId = `${BRIDGE_RETRY_ID_PREFIX}${counter}`
      const entry = calls.get(idKeyOf(originalId))
      if (entry !== undefined) entry.live = attemptId
      attempts.set(attemptId, originalId)
      return attemptId
    },
    attemptFailed(originalId) {
      const entry = calls.get(idKeyOf(originalId))
      if (entry?.live === undefined) return
      attempts.delete(entry.live)
      entry.live = undefined
    },
    answerFor(id) {
      if (id === null) return undefined
      const viaAttempt = typeof id === 'string' ? attempts.get(id) : undefined
      if (viaAttempt !== undefined) attempts.delete(id as string)
      const original = viaAttempt ?? id
      const key = idKeyOf(original)
      if (answered.has(key)) return null
      if (viaAttempt === undefined && !calls.has(key)) return undefined
      markAnswered(key)
      return original
    },
    isAnswered: (originalId) => answered.has(idKeyOf(originalId)),
    cancel(originalId) {
      if (originalId === null) return undefined
      const key = idKeyOf(originalId)
      const entry = calls.get(key)
      if (entry === undefined) return undefined
      // Done with it: a cancelled call gets no further attempt, and (usually) no answer.
      remember(cancelled, key, MAX_ANSWERED_REMEMBERED)
      calls.delete(key)
      return entry.live
    },
    isCancelled: (originalId) => cancelled.has(idKeyOf(originalId)),
    isTracked: (originalId) => calls.has(idKeyOf(originalId)),
    forget(originalId) {
      calls.delete(idKeyOf(originalId))
    },
    isEmpty: () => calls.size === 0 && attempts.size === 0,
  }
}
