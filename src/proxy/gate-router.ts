import {
  classify,
  type ClassifiedNotification,
  type ClassifiedRequest,
  type JsonRpcId,
} from '../protocol/classify.js'
import { TOOLS_CALL_METHOD, isToolsListRequest, parseToolCall, type ParsedToolCall } from '../protocol/mcp.js'
import type { McpMessage } from '../transport/message.js'
import type { Verdict } from './pipeline.js'
import type { SynthesizableId } from './synthesize.js'
import type { ToolCatalog } from './tool-catalog.js'
import {
  DROP,
  DUPLICATE_RESPONSE_RULE,
  FORWARD,
  MALFORMED_TOOLS_CALL_RULE,
  RESPONSE_TOOL_NAME,
  TOOLS_LIST_OVERFLOW_RULE,
  TOOLS_LIST_TOOL_NAME,
  UNPARSEABLE_CLIENT_FRAME_RULE,
  UNPARSEABLE_TOOL_NAME,
  bookkeepingDecisionInfo,
  createBoundedIdSet,
  denialBytesFor,
  idKeyOf,
  isPromiseVerdict,
  parseCancelledRequestId,
  parseIdlessToolCall,
  recoverScalarId,
  unsafeClientFrameDecision,
  type AnswerGuard,
  type DecisionWriter,
} from './gate-helpers.js'

/**
 * The message-dispatch half of the session policy gate: classifies each
 * transport-neutral message (`McpMessage`, M3) in both directions and routes
 * it to the right decision path. The decision paths themselves
 * (decide/deny/approve, the tool catalog) are injected by `gate-core.ts`,
 * which owns the shared session state. The routing rules restate the gate's
 * invariants (see `gate-core.ts`): only `tools/call` is gated — by method,
 * not by message shape — and everything else forwards untouched. Only a
 * message's content bytes are consulted; its transport metadata (origin,
 * terminator) never influences a decision.
 */

/**
 * Cap on concurrently-tracked outstanding `tools/list` request ids (M9).
 * Deliberately far above any realistic client's concurrent `tools/list`
 * fan-out, so a normal session never evicts and every `tools/list` response
 * is matched and observed; an eviction past this bound is journaled.
 */
const MAX_TRACKED_TOOLS_LIST_IDS = 65_536

export interface GateRouterDeps {
  readonly serverName: string
  readonly writeDecision: DecisionWriter
  /** Resolves once decision records are durable — but only when fail-closed. */
  readonly settleJournal: () => Promise<void>
  /** Answers `id` locally and marks it as answered (see `gate.ts`); a `null` id is dropped. */
  readonly answerLocally: (id: JsonRpcId, build: (id: SynthesizableId) => Buffer) => Promise<void>
  /** The shared exactly-one-outcome guard owned by `gate.ts`. */
  readonly answerGuard: AnswerGuard
  /** The server-side tools/list half of the gate. */
  readonly catalog: ToolCatalog
  readonly onError: (error: unknown) => void
  /** The gate's full tools/call decision path (hydration + decide + apply). */
  readonly gateToolCall: (call: ParsedToolCall) => Verdict | Promise<Verdict>
  /** Fail-closed wrapper around one call's decision path (see `gate.ts`). */
  readonly guarded: (
    call: ParsedToolCall,
    produce: () => Verdict | Promise<Verdict>,
  ) => Verdict | Promise<Verdict>
  /** Remembers an in-flight verdict so `cancelPending()` can wait it out. */
  readonly track: (work: Verdict | Promise<Verdict>) => Verdict | Promise<Verdict>
}

export interface GateRouter {
  gateClientMessage(message: McpMessage): Verdict | Promise<Verdict>
  gateServerMessage(message: McpMessage): Verdict | Promise<Verdict>
}

export function createGateRouter(deps: GateRouterDeps): GateRouter {
  const { serverName, writeDecision, settleJournal, answerLocally, answerGuard } = deps
  const { catalog, onError, gateToolCall, guarded, track } = deps

  const pendingToolsListIds = createBoundedIdSet(MAX_TRACKED_TOOLS_LIST_IDS, (evicted) => {
    writeDecision(bookkeepingDecisionInfo(serverName, TOOLS_LIST_OVERFLOW_RULE, TOOLS_LIST_TOOL_NAME, evicted))
  })
  /** In-flight tool-call verdicts keyed by request id, so a cancellation can queue behind them (TS-M2). */
  const verdictsByRequestId = new Map<string, Promise<Verdict>>()

  // -- client -> server --------------------------------------------------

  /**
   * Fail-closed default for the client->server direction: a frame we cannot
   * positively identify as safe is dropped, the drop is journaled, and — if a
   * scalar id is recoverable — the client is answered with a denial it can
   * correlate. A frame with no recoverable id is simply dropped (C2).
   */
  async function denyUnsafeClientFrame(rule: string, id: JsonRpcId): Promise<Verdict> {
    try {
      writeDecision(unsafeClientFrameDecision(serverName, rule))
      await settleJournal()
      await answerLocally(id, (sid) =>
        denialBytesFor(sid, { toolName: UNPARSEABLE_TOOL_NAME, serverName, rule }),
      )
    } catch (error: unknown) {
      onError(error)
    }
    return DROP
  }

  /** Records an in-flight tool-call verdict by request id, so a cancellation can queue behind it (TS-M2). */
  function recordVerdict(id: JsonRpcId, verdict: Verdict | Promise<Verdict>): Verdict | Promise<Verdict> {
    if (id === null || !isPromiseVerdict(verdict)) return verdict
    const key = idKeyOf(id)
    const settled = Promise.resolve(verdict)
    verdictsByRequestId.set(key, settled)
    void settled.finally(() => {
      if (verdictsByRequestId.get(key) === settled) verdictsByRequestId.delete(key)
    })
    return verdict
  }

  function gateClientRequest(msg: ClassifiedRequest): Verdict | Promise<Verdict> {
    // tools/call is intercepted by gateClientMessage before this fork runs
    // (C2/N1): every path that reaches here is some other request method.
    // The only one we care about is tools/list, whose id we track so its
    // response can be observed. Everything else forwards.
    if (isToolsListRequest(msg)) pendingToolsListIds.add(idKeyOf(msg.id))
    return FORWARD
  }

  function gateClientNotification(msg: ClassifiedNotification): Verdict | Promise<Verdict> {
    // A notification-shaped tools/call (id-less) is intercepted by
    // gateClientMessage before this fork runs (C2/N1); this only ever sees
    // an actual notification method.
    if (msg.method !== 'notifications/cancelled') return FORWARD
    const requestId = parseCancelledRequestId(msg.raw)
    if (requestId === null) return FORWARD
    const pending = verdictsByRequestId.get(idKeyOf(requestId))
    if (pending === undefined) return FORWARD
    // Order the cancellation strictly behind the request it cancels: the
    // server must see the tools/call before its cancellation to correlate
    // them, so flush it only after that request's verdict settles (TS-M2).
    return track(pending.then(() => FORWARD, () => FORWARD))
  }

  /**
   * Gates a `tools/call` regardless of whether it is a proper id-bearing
   * request or a spec-violating, id-less notification-shaped one (C2/N1): the
   * old bug routed the latter straight to `gateClientNotification`, which
   * forwards every non-`notifications/cancelled` notification unexamined —
   * an unvetted `tools/call` with no id would reach the server even under a
   * deny-everything policy, no decision ever recorded. Both shapes now go
   * through the exact same parse -> decide -> journal path; an id-less call
   * simply cannot be answered locally (no return address), so a non-allow
   * outcome is a silent drop instead of a synthetic reply.
   */
  function gateToolsCallFrame(msg: ClassifiedRequest | ClassifiedNotification, raw: string): Verdict | Promise<Verdict> {
    if (msg.kind === 'request') {
      const call = parseToolCall(msg)
      if (call === null) return denyUnsafeClientFrame(MALFORMED_TOOLS_CALL_RULE, msg.id)
      return recordVerdict(call.id, track(guarded(call, () => gateToolCall(call))))
    }
    const call = parseIdlessToolCall(raw)
    if (call === null) return denyUnsafeClientFrame(MALFORMED_TOOLS_CALL_RULE, null)
    return track(guarded(call, () => gateToolCall(call)))
  }

  function gateClientMessage(message: McpMessage): Verdict | Promise<Verdict> {
    const text = message.bytes.toString('utf8')
    const msg = classify(text)
    // tools/call is checked BEFORE the kind fork, on purpose: an id-less
    // tools/call classifies as a 'notification' (no `id` key at all), and
    // must never take the "notifications forward unconditionally" path (C2/N1).
    if ((msg.kind === 'request' || msg.kind === 'notification') && msg.method === TOOLS_CALL_METHOD) {
      return gateToolsCallFrame(msg, text)
    }
    // Fail closed: FORWARD only frames positively identified as safe.
    switch (msg.kind) {
      case 'notification':
        return gateClientNotification(msg)
      case 'response':
        return FORWARD
      case 'request':
        return gateClientRequest(msg)
      case 'invalid':
        return denyUnsafeClientFrame(UNPARSEABLE_CLIENT_FRAME_RULE, recoverScalarId(text))
    }
  }

  // -- server -> client --------------------------------------------------

  function gateServerMessage(message: McpMessage): Verdict | Promise<Verdict> {
    try {
      const msg = classify(message.bytes.toString('utf8'))
      // A server->client message can never execute a tool, so an invalid or
      // non-response message keeps forwarding untouched (unlike the client
      // direction, which fails closed).
      if (msg.kind !== 'response') return FORWARD

      const key = idKeyOf(msg.id)
      if (pendingToolsListIds.delete(key)) return catalog.handleResponse(msg)
      if (answerGuard.isAnswered(key)) {
        // The client reused an id we already answered: forward it as-is, and
        // leave a trace for whoever has to explain the duplicate later.
        writeDecision(
          bookkeepingDecisionInfo(serverName, DUPLICATE_RESPONSE_RULE, RESPONSE_TOOL_NAME, msg.id),
          { rpcId: msg.id },
        )
      }
      return FORWARD
    } catch (error: unknown) {
      onError(error)
      return FORWARD
    }
  }

  return { gateClientMessage, gateServerMessage }
}
