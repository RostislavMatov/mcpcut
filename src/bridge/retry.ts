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

/** `bytes` (a JSON-RPC object) under `id` instead of its own. */
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

/** The bridge's ledger of calls it is re-sending. */
export interface RetryBook {
  /** The call first sent as `originalId` failed and will be sent again: from now on a cancel of it counts. */
  begin(originalId: SynthesizableId): void
  /** A fresh id for the next attempt of the call first sent as `originalId`. */
  nextAttemptId(originalId: SynthesizableId): string
  /** If `id` is an attempt's, the original id its answer belongs to — and the attempt is forgotten. */
  takeOriginal(id: JsonRpcId): SynthesizableId | undefined
  /** The client cancelled `originalId`: no further attempt. Returns the attempt in flight to cancel instead, if any. */
  cancel(originalId: JsonRpcId): string | undefined
  isCancelled(originalId: SynthesizableId): boolean
  /** The call is over (answered, given up): forget it. */
  forget(originalId: SynthesizableId): void
  /** True while no attempt is out: answers then need no id lookup at all. */
  hasNoAttempts(): boolean
}

export function createRetryBook(): RetryBook {
  let counter = 0
  /** Attempt id -> original id. */
  const originals = new Map<string, SynthesizableId>()
  /** Original id key -> the attempt id in flight. */
  const live = new Map<string, string>()
  /** Calls being re-sent: only their cancels are kept, so the set stays as small as they are. */
  const begun = new Set<string>()
  const cancelled = new Set<string>()

  function drop(key: string): void {
    const attempt = live.get(key)
    if (attempt !== undefined) originals.delete(attempt)
    live.delete(key)
    begun.delete(key)
    cancelled.delete(key)
  }

  return {
    begin(originalId) {
      begun.add(idKeyOf(originalId))
    },
    nextAttemptId(originalId) {
      counter += 1
      const attemptId = `${BRIDGE_RETRY_ID_PREFIX}${counter}`
      const key = idKeyOf(originalId)
      const previous = live.get(key)
      if (previous !== undefined) originals.delete(previous)
      originals.set(attemptId, originalId)
      live.set(key, attemptId)
      return attemptId
    },
    takeOriginal(id) {
      if (typeof id !== 'string' || !id.startsWith(BRIDGE_RETRY_ID_PREFIX)) return undefined
      const original = originals.get(id)
      if (original === undefined) return undefined
      drop(idKeyOf(original))
      return original
    },
    cancel(originalId) {
      if (originalId === null) return undefined
      const key = idKeyOf(originalId)
      if (!begun.has(key)) return undefined
      cancelled.add(key)
      return live.get(key)
    },
    isCancelled: (originalId) => cancelled.has(idKeyOf(originalId)),
    forget: (originalId) => drop(idKeyOf(originalId)),
    hasNoAttempts: () => originals.size === 0,
  }
}
