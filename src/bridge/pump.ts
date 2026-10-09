import { classify, type JsonRpcId } from '../protocol/classify.js'
import { synthesizeError, type SynthesizableId } from '../proxy/synthesize.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageSink,
  type MessageSource,
} from '../transport/message.js'
import { DIAGNOSTIC_PREFIX } from '../upstream/constants.js'
import { parseCancelledRequestId } from '../proxy/gate-helpers.js'
import { ERROR_CODE_BRIDGE_TRANSPORT } from './constants.js'
import {
  BRIDGE_RETRY_DELAYS_MS,
  attemptBytes,
  cancelFor,
  createRetryBook,
  retryableCallOf,
  withId,
  type RetryableCall,
} from './retry.js'
import {
  classifyBridgeFailure,
  isFatal,
  type BridgeFailure,
  type FatalBridgeFailure,
} from './failure.js'

/**
 * The two-directional pump of `connect --url` (ADR-0015, plan task 4).
 *
 * Both sides are already-built `MessageSource`/`MessageSink` pairs — this
 * module never touches a stream, a socket or a URL — and what crosses it
 * crosses byte for byte: the bridge relays, the SERVICE gates. The only
 * bytes it ever originates are the transport error it owes a request it
 * could not deliver, and — decision M39, `retry.ts` — a dropped `tools/call`
 * with a tool-use id sent again under an id of its own, its answer and its
 * client's cancel moved between the two ids.
 *
 * Two disciplines are load-bearing:
 *
 *  - **writes are not awaited in sequence.** `HttpUpstreamClient.sink.write`
 *    resolves only once the whole response has been read, and the response to
 *    a `tools/call` awaiting a human approval stays open for minutes. Awaiting
 *    each write would queue the `notifications/cancelled` for that very call
 *    behind it. The client's own `dispatchQueue` already serializes writes up
 *    to DISPATCH, which is the ordering guarantee that matters on the wire, so
 *    firing each forward off is safe as well as necessary.
 *  - **handlers are registered synchronously**, before the first `await`
 *    anywhere in this function: a source starts delivering on a later tick,
 *    and one that found no handler would drop a message on the floor.
 */

export interface BridgeEndpoints {
  readonly source: MessageSource
  readonly sink: MessageSink
}

/** The service side: an `HttpUpstreamClient`, structurally. */
export interface BridgeServiceEndpoints extends BridgeEndpoints {
  close(): Promise<void>
}

export interface RunBridgeArgs {
  /** This process's own stdio, framed as messages. */
  readonly client: BridgeEndpoints
  readonly service: BridgeServiceEndpoints
  /** Operator-facing lines (stderr). Never the protocol channel. */
  readonly onDiagnostic: (line: string) => void
  /** Pauses before each further attempt of a dropped call (`retry.ts`); tests shorten them. */
  readonly retryDelaysMs?: readonly number[]
}

export type BridgeEnd =
  /** The agent's client hung up: the ordinary ending, exit 0. */
  | { readonly reason: 'client-ended' }
  /**
   * The service will not continue this session; the caller decides the code.
   * Narrowed to the FATAL kinds, so the caller's switch over them is
   * exhaustive by compilation.
   */
  | { readonly reason: 'fatal'; readonly failure: FatalBridgeFailure }

/** Human-readable half of a failure, for a diagnostic line. Never carries an unknown error's text. */
function describe(failure: BridgeFailure): string {
  switch (failure.kind) {
    case 'network':
    case 'protocol':
      return `${failure.kind}: ${failure.detail}`
    case 'service':
      return `service answered HTTP ${failure.status}`
    default:
      return failure.kind
  }
}

/**
 * The id a synthesized answer would be routed to, or `undefined` when there
 * is none to route to: a notification, a response, an unparseable line, or a
 * request whose id is `null` (no return address — `SynthesizableId` excludes
 * it by construction).
 */
function answerableIdOf(bytes: Buffer): SynthesizableId | undefined {
  const message = classify(bytes.toString('utf8'))
  if (message.kind !== 'request') return undefined
  const id: JsonRpcId = message.id
  return id === null ? undefined : id
}

/** Cheap pre-checks before a message is parsed at all (`includes` on the raw bytes). */
const TOOLS_CALL_METHOD_BYTES = Buffer.from('"tools/call"')
const CANCELLED_METHOD_BYTES = Buffer.from('"notifications/cancelled"')

/** How a message that failed to reach the service describes itself in a diagnostic. */
function labelOf(bytes: Buffer): string {
  const message = classify(bytes.toString('utf8'))
  if (message.kind === 'request') return `${message.method} (id ${JSON.stringify(message.id)})`
  if (message.kind === 'notification') return message.method
  if (message.kind === 'response') return `a response (id ${JSON.stringify(message.id)})`
  return 'an unparseable message'
}

/**
 * The pump's moving parts, as one object: the mutable state a bridge carries
 * and the four operations over it. Split out of `runBridge` for the
 * 50-line-per-function budget along the seam the code already had — the
 * STATE MACHINE here, the WIRING there — rather than by scattering shared
 * mutable state across modules, which would be the worse trade.
 */
interface Pump {
  forward(message: McpMessage): Promise<void>
  /** A service message as the client must see it: an attempt's answer under the original id (M39). */
  toClient(message: McpMessage): McpMessage
  writeToClient(message: McpMessage): Promise<void>
  onServiceError(error: unknown): void
  endClientSide(): Promise<void>
  hasEnded(): boolean
}

function createPump(args: RunBridgeArgs, resolve: (end: BridgeEnd) => void): Pump {
  const { client, service, onDiagnostic } = args
  let isSettled = false
  /** True once the outcome IS a fatal, so the caller will name it on stderr. */
  let isEndingOnFatal = false
  let hasReportedLateFatal = false
  /**
   * Service-bound writes not yet settled. `client.ts` reports every write
   * failure on BOTH channels — `channel.emitError(error); throw error` — so
   * while this is non-zero the source's copy is a duplicate of a line
   * `forward` is about to print with the method and the id attached.
   */
  let forwardsInFlight = 0
  /** Calls waiting out a pause before their next attempt. */
  let retriesPending = 0
  const book = createRetryBook()
  const delays = args.retryDelaysMs ?? BRIDGE_RETRY_DELAYS_MS

  function diagnose(text: string): void {
    onDiagnostic(`${DIAGNOSTIC_PREFIX} ${text}\n`)
  }

  /**
   * One outcome per bridge: the first ending wins. A fatal that arrives too
   * late to BE the outcome is still reported when the outcome was the
   * client's own hang-up — otherwise an operator debugging a bad token is
   * left wondering why nothing happened. It is NOT reported when the outcome
   * is itself a fatal: both halves of a dead connection fail for the same
   * reason, and the caller is about to print that reason properly.
   */
  function settleFatal(failure: FatalBridgeFailure): void {
    if (isSettled) {
      if (isEndingOnFatal || hasReportedLateFatal) return
      hasReportedLateFatal = true
      diagnose(`the service ended this session: ${describe(failure)}`)
      return
    }
    isSettled = true
    isEndingOnFatal = true
    resolve({ reason: 'fatal', failure })
  }

  /** Client-bound write; a failure here can only be reported, never answered. */
  async function writeToClient(message: McpMessage): Promise<void> {
    try {
      await client.sink.write(message)
    } catch (error: unknown) {
      diagnose(`could not write to the client: ${describe(classifyBridgeFailure(error))}`)
    }
  }

  /**
   * Answers a request the bridge could not deliver, so the agent's client
   * sees a failed call rather than a call that never returns. Only a
   * `tools/call` with a tool-use id is ever sent again (`sendWithRetries`,
   * decision M39) — the service matches it to the first call; anything else
   * is not idempotent, and re-sending one the service may well have received
   * is worse than reporting the failure.
   */
  function answerUndeliverable(bytes: Buffer, failure: BridgeFailure): void {
    const id = answerableIdOf(bytes)
    if (id === undefined) return
    const body = synthesizeError(id, {
      code: ERROR_CODE_BRIDGE_TRANSPORT,
      message: `mcpcut bridge could not reach the service (${describe(failure)}).`,
    })
    // `synthesizeError` ends its line itself; the sink frames the message, so
    // the terminator is declared and the trailing byte dropped.
    void writeToClient(serverMessage(body.subarray(0, body.length - 1), '\n'))
  }

  /** What an ordinary (non-fatal) delivery failure costs: this one request. */
  function reportUndelivered(message: McpMessage, failure: BridgeFailure): void {
    if (isSettled) {
      // The bridge has already ended and the caller is tearing the client's
      // sink down; an answer written now would resolve as a no-op, and the
      // log would claim a reply that never reached anyone. Say what actually
      // happened instead.
      diagnose(`${labelOf(message.bytes)} went unanswered: ${describe(failure)}`)
      return
    }
    diagnose(`could not deliver ${labelOf(message.bytes)}: ${describe(failure)}`)
    answerUndeliverable(message.bytes, failure)
  }

  /**
   * Service-bound write. Catches everything itself: it is called as
   * `void forward(...)`, so an escaping rejection would be unhandled.
   */
  async function forward(message: McpMessage): Promise<void> {
    forwardsInFlight += 1
    try {
      await sendWithRetries(cancelOfAttempt(message))
    } finally {
      forwardsInFlight -= 1
    }
  }

  /**
   * A client's cancel of a call the bridge may send again: no further attempt,
   * and if one is out, it is the one cancelled. Only a message that can be a
   * cancel is parsed.
   */
  function cancelOfAttempt(message: McpMessage): McpMessage {
    if (!message.bytes.includes(CANCELLED_METHOD_BYTES)) return message
    const parsed = classify(message.bytes.toString('utf8'))
    if (parsed.kind !== 'notification' || parsed.method !== 'notifications/cancelled') return message
    const attemptId = book.cancel(parseCancelledRequestId(parsed.raw))
    return attemptId === undefined ? message : clientMessage(cancelFor(message.bytes, attemptId), message.meta.terminator)
  }

  /**
   * Sends `message`; a `tools/call` with a tool-use id whose connection
   * dropped is sent again under an attempt id after each pause in `delays`
   * (decision M39, `retry.ts`). Anything else that fails costs that request.
   */
  async function sendWithRetries(message: McpMessage): Promise<void> {
    // Known from the start, so a cancel sent while the first attempt is still
    // out stops any later one.
    const call = message.bytes.includes(TOOLS_CALL_METHOD_BYTES) ? retryableCallOf(message.bytes) : null
    if (call !== null) book.begin(call.originalId)
    let current = message
    for (let attempt = 0; ; attempt += 1) {
      try {
        await service.sink.write(current)
        // An attempt's mapping goes when its answer arrives (`toClient`).
        if (call !== null && current === message) book.forget(call.originalId)
        return
      } catch (error: unknown) {
        const failure = classifyBridgeFailure(error)
        if (isFatal(failure)) return settleFatal(failure)
        const delay = delays[attempt]
        if (call === null || delay === undefined || failure.kind !== 'network' || book.isCancelled(call.originalId)) {
          return giveUp(message, call, failure)
        }
        diagnose(`${labelOf(message.bytes)}: the connection dropped; sending it again in ${delay} ms (${attempt + 1} of ${delays.length})`)
        if (!(await pauseFor(delay, call))) return
        current = clientMessage(attemptBytes(call, book.nextAttemptId(call.originalId)), message.meta.terminator)
      }
    }
  }

  /** Waits `ms`; false when the call should not go again after all (cancelled, or the bridge ended). */
  async function pauseFor(ms: number, call: RetryableCall): Promise<boolean> {
    retriesPending += 1
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
    } finally {
      retriesPending -= 1
    }
    if (!isSettled && !book.isCancelled(call.originalId)) return true
    book.forget(call.originalId)
    return false
  }

  /** The request is lost: say so, and answer it under its original id — unless its client cancelled it. */
  function giveUp(message: McpMessage, call: RetryableCall | null, failure: BridgeFailure): void {
    if (call !== null) {
      const isCancelled = book.isCancelled(call.originalId)
      book.forget(call.originalId)
      if (isCancelled) return
    }
    reportUndelivered(message, failure)
  }

  function toClient(message: McpMessage): McpMessage {
    if (book.hasNoAttempts()) return message
    const parsed = classify(message.bytes.toString('utf8'))
    if (parsed.kind !== 'response') return message
    const original = book.takeOriginal(parsed.id)
    return original === undefined ? message : serverMessage(withId(message.bytes, original), message.meta.terminator)
  }

  function onServiceError(error: unknown): void {
    const failure = classifyBridgeFailure(error)
    if (isFatal(failure)) {
      settleFatal(failure)
      return
    }
    // A write still in flight will report this same failure itself, with the
    // method and the id attached; this copy would be a second line about one
    // problem. What reaches here with nothing in flight is the connection's
    // own trouble — the close-time DELETE, most often — and that line is the
    // only account of it there will be.
    if (forwardsInFlight > 0) return
    diagnose(`service connection: ${describe(failure)}`)
  }

  /** The ordinary ending: let the service go, then report. Idempotent. */
  async function endClientSide(): Promise<void> {
    if (isSettled) return
    isSettled = true
    try {
      await service.close()
    } catch (error: unknown) {
      diagnose(`closing the service connection: ${describe(classifyBridgeFailure(error))}`)
    }
    resolve({ reason: 'client-ended' })
  }

  return { forward, toClient, writeToClient, onServiceError, endClientSide, hasEnded: () => isSettled }
}

/** Wires both sides to one pump. Every handler is registered before the first `await`. */
export function runBridge(args: RunBridgeArgs): Promise<BridgeEnd> {
  return new Promise<BridgeEnd>((resolve) => {
    const pump = createPump(args, resolve)

    args.client.source.onMessage((message) => {
      if (pump.hasEnded()) return
      void pump.forward(message)
    })
    args.client.source.onError((error: unknown) => {
      // The agent's own stdio failed: there is nobody left to serve, and
      // nobody left to tell either. Report and end as an ordinary hang-up.
      args.onDiagnostic(
        `${DIAGNOSTIC_PREFIX} client stdio failed: ${describe(classifyBridgeFailure(error))}\n`,
      )
      void pump.endClientSide()
    })
    args.client.source.onEnd(() => {
      void pump.endClientSide()
    })

    args.service.source.onMessage((message) => {
      if (pump.hasEnded()) return
      void pump.writeToClient(pump.toClient(message))
    })
    args.service.source.onError((error: unknown) => {
      pump.onServiceError(error)
    })
  })
}
