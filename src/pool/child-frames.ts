import { classify, type JsonRpcId } from '../protocol/classify.js'
import type { PoolRecordInfo } from '../journal/pool-record.js'
import {
  PROGRESS_NOTIFICATION,
  PROMPTS_LIST_CHANGED_NOTIFICATION,
  TOOLS_LIST_CHANGED_NOTIFICATION,
} from '../protocol/mcp.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import type { McpMessage } from '../transport/message.js'
import { MAX_POOL_DROP_NOTE_METHOD_CHARS, MAX_POOL_NOTIFICATION_DROP_NOTES } from './constants.js'
import type { PoolCorrelator } from './correlator.js'
import type { PoolFanout } from './fanout.js'
import { poolIncompleteResultError } from './errors.js'
import {
  fanoutTagOf,
  incompleteResultTypeOf,
  notificationFrame,
  progressTokenOfNotification,
} from './multiplexer-frames.js'

/**
 * The child side of the multiplexer's dispatch: one frame from a child
 * session, judged and either handed to the agent or dropped with a record
 * (ADR-0015 §§3-5). Split out of `multiplexer.ts` for the 400-line cap.
 *
 * Replies are settled against the correlator BY SERVER -- a reply can only
 * answer a request that was sent to the server it came from -- and that check
 * stays exactly here. The other lock of the phase-3 CRITICAL (only the
 * CURRENT instance of a child reaches this function at all) lives in
 * `children.ts`.
 *
 * Notifications are an ALLOWLIST (ADR-0015 phase-5 amendment, N1-N3): the
 * pool declared only `tools.listChanged` and `prompts.listChanged` to the
 * agent (PE12), so a member's `list_changed` is re-issued as the pool's own
 * frame, progress passes only from the server holding its token, and
 * everything else -- logs, resources, cancellations, whatever comes next --
 * stays in the child session's own traffic and is noted once per kind.
 */

export type ChildNotificationVerdict =
  | { readonly kind: 'forward'; readonly bytes: Buffer }
  | { readonly kind: 'drop'; readonly reason: 'unscoped-notification' | 'unsupported-method' }

export interface JudgeChildNotificationInput {
  readonly server: string
  readonly method: string
  readonly raw: string
  readonly bytes: Buffer
  /** The server whose in-flight request owns this token, if any (`PoolCorrelator.progressServerOf`). */
  readonly progressServerOf: (token: SynthesizableId) => string | undefined
}

/** The two notifications a member may prompt; the agent hears them from the POOL. */
const LIST_CHANGED_NOTIFICATIONS: ReadonlySet<string> = new Set([
  TOOLS_LIST_CHANGED_NOTIFICATION,
  PROMPTS_LIST_CHANGED_NOTIFICATION,
])

/**
 * What happens to one notification from a member of the pool.
 *
 * - Progress: its token was chosen by the AGENT for one call. It passes, byte
 *   for byte, only when that call is in flight at THIS server; otherwise a
 *   member could report on -- or fake the end of -- another member's call.
 * - `list_changed`: passed as a fresh frame of the pool's own. The member's
 *   params (if any) never reach the agent, and the frame says what the pool
 *   says: "read the merged list again".
 * - Anything else: a capability the pool never declared. A log line in
 *   particular cannot be attributed to a server once it reaches the agent,
 *   so a hostile member could speak in another's name.
 */
export function judgeChildNotification(input: JudgeChildNotificationInput): ChildNotificationVerdict {
  if (input.method === PROGRESS_NOTIFICATION) {
    const token = progressTokenOfNotification(input.raw)
    const owner = token === null ? undefined : input.progressServerOf(token)
    return owner === input.server
      ? { kind: 'forward', bytes: input.bytes }
      : { kind: 'drop', reason: 'unscoped-notification' }
  }
  if (LIST_CHANGED_NOTIFICATIONS.has(input.method)) {
    return { kind: 'forward', bytes: notificationFrame(input.method) }
  }
  return { kind: 'drop', reason: 'unsupported-method' }
}

export interface DropNotes {
  /** True exactly once per (server, reason, method), while under the cap. */
  firstTime(server: string, reason: string, method: string): boolean
}

/**
 * Which dropped notifications this pool session has already journaled (N3).
 * A `Set` in the closure, capped: past `limit` keys nothing more is noted --
 * the child session's traffic still holds every one of them.
 */
export function createDropNotes(limit: number): DropNotes {
  const seen = new Set<string>()
  return {
    firstTime(server: string, reason: string, method: string): boolean {
      // The server name (registry) and the reason (this module) never hold a
      // NUL and the server-chosen method comes last, so no two keys collide.
      // Written as an escape: a literal invisible character makes this file
      // "binary" to git (the lesson of `safeNameOf`).
      const key = `${server}\u0000${reason}\u0000${method}`
      if (seen.has(key) || seen.size >= limit) return false
      seen.add(key)
      return true
    },
  }
}

export interface ChildFrameDeps {
  readonly correlator: PoolCorrelator
  readonly fanout: PoolFanout
  /** Hands one frame to the agent; never throws. */
  readonly send: (bytes: Buffer) => void
  /** One `kind:'pool'` record; never throws. */
  readonly record: (info: Omit<PoolRecordInfo, 'agentName'>) => void
  readonly onError: (error: unknown) => void
  readonly isClosed: () => boolean
}

export type ChildFrameHandler = (server: string, message: McpMessage) => void

export function createChildFrameHandler(deps: ChildFrameDeps): ChildFrameHandler {
  const notes = createDropNotes(MAX_POOL_NOTIFICATION_DROP_NOTES)

  function handleNotification(server: string, method: string, raw: string, bytes: Buffer): void {
    const verdict = judgeChildNotification({
      server,
      method,
      raw,
      bytes,
      progressServerOf: (token) => deps.correlator.progressServerOf(token),
    })
    if (verdict.kind === 'forward') {
      deps.send(verdict.bytes)
      return
    }
    // Bounded before it is kept anywhere: the upstream chose this string.
    const kind = method.slice(0, MAX_POOL_DROP_NOTE_METHOD_CHARS)
    if (notes.firstTime(server, verdict.reason, kind)) {
      deps.record({ event: 'dropped', serverName: server, reason: verdict.reason, method: kind })
    }
  }

  function handleResponse(server: string, bytes: Buffer, id: JsonRpcId, raw: string): void {
    const settled = deps.correlator.settle(server, id)
    if (settled.kind === 'client') {
      // `id` is never null here (`settle` refuses a null id); narrowed anyway.
      if (id !== null && incompleteResultTypeOf(raw) !== null) {
        // RV5: never handed on as if it were finished. One outcome still
        // reaches the agent for this id — the pool's error.
        deps.send(poolIncompleteResultError(id))
        deps.record({ event: 'dropped', serverName: server, reason: 'incomplete-result' })
        return
      }
      // Byte for byte: the reply names no tool, so there is nothing in it
      // to rewrite (ADR-0015 §9).
      deps.send(bytes)
      return
    }
    if (settled.kind === 'fanout') {
      // A reply that arrived after its own timeout has no waiter left: it
      // is journaled as an uncorrelated drop rather than lost in silence.
      if (!deps.fanout.settle(server, fanoutTagOf(id), raw)) {
        deps.record({ event: 'dropped', serverName: server, reason: 'uncorrelated-reply' })
      }
      return
    }
    deps.record({ event: 'dropped', serverName: server, reason: 'uncorrelated-reply' })
  }

  return (server: string, message: McpMessage): void => {
    if (deps.isClosed()) return
    try {
      const classified = classify(message.bytes.toString('utf8'))
      if (classified.kind === 'response') {
        handleResponse(server, message.bytes, classified.id, classified.raw)
        return
      }
      if (classified.kind === 'request') {
        // PE3: upstreams are told of no sampling, elicitation or roots, so a
        // request from one is unsolicited. It is dropped rather than shown to
        // an agent that never offered to answer it.
        deps.record({
          event: 'dropped',
          serverName: server,
          reason: 'server-request',
          method: classified.method,
        })
        return
      }
      if (classified.kind === 'notification') {
        handleNotification(server, classified.method, classified.raw, message.bytes)
        return
      }
      deps.record({ event: 'dropped', serverName: server, reason: 'unreadable' })
    } catch (error: unknown) {
      deps.onError(error)
    }
  }
}
