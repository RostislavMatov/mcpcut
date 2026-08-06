/**
 * Transport-neutral message contract for the control-plane gate (M3).
 *
 * The M2 gate consumes stdio `Frame`s (`protocol/split.ts`). HTTP has no
 * lines and no terminators, so the gate moves to this message level in
 * Wave 3 (Task 11): `McpMessage` carries the wire bytes plus the minimal
 * transport metadata needed to reproduce them exactly, and nothing else.
 *
 * This module deals only in bytes and metadata. It must never import or
 * know about JSON-RPC or MCP semantics — see the architectural invariant
 * in CLAUDE.md and `tests/architecture/imports.test.ts`, which covers
 * `src/transport/**` mechanically.
 *
 * Shape decisions (made deliberately, to keep the Task 11 gate swap a
 * minimal diff against today's `proxy/pipeline.ts`):
 *
 * - `MessageVerdict` mirrors `Verdict` from `proxy/pipeline.ts`
 *   member-for-member (`{action: 'forward' | 'drop'} | {action: 'emit',
 *   bytes}`), so the two unions are mutually assignable and the gate's
 *   return type changes without touching any verdict-handling code. A
 *   compile-time test pins the mirror.
 *
 * - `MessageSource` is callback-shaped (`onMessage`/`onError`/`onEnd`/
 *   `dispose`), not an async iterator. Today `pipeline.ts` is push-driven:
 *   stream events fan frames into the gate callback, and a deferred
 *   verdict deliberately never blocks later frames from being read and
 *   gated (head-of-line blocking is rejected — see the pipeline module
 *   doc). An async iterator would impose pull-one-at-a-time semantics and
 *   regress exactly that property. The callback trio mirrors the pipeline
 *   surface 1:1: `onMessage` ≙ the frame fan-out, `onError` ≙
 *   `PipelineOptions.onError`, `onEnd` ≙ `PipelineOptions.onEnd`,
 *   `dispose` ≙ `PipelineHandle.dispose`. One handler per channel,
 *   registered before messages flow.
 *
 * - `MessageSink.write` returns `Promise<void>` with `OrderedWriter`
 *   semantics (`proxy/writer.ts`): writes land whole and strictly in call
 *   order, the promise settles once the destination has accepted (and
 *   drained), and `dispose()` is idempotent. A void return would discard
 *   the settling signal the pipeline's backpressure accounting depends on.
 */

/**
 * How a message's content ended on the stdio wire. Structurally identical
 * to `Terminator` in `protocol/split.ts` (a stdio frame's terminator is
 * assignable here unchanged); redeclared so this transport-neutral
 * contract does not depend on the stdio framing module.
 */
export type MessageTerminator = '\n' | '\r\n' | 'none'

/** Which side of the proxied conversation produced the message. */
export type MessageOrigin = 'client' | 'server'

export interface MessageMeta {
  readonly origin: MessageOrigin
  /**
   * Present only for messages that arrived over stdio (`'none'` marks a
   * frame flushed without ever seeing a terminator). HTTP messages have no
   * line framing and therefore no `terminator` key at all — the stdio
   * adapter supplies `'\n'` when such a message must go out on a stdio
   * wire (see `stdio-adapter.ts`).
   */
  readonly terminator?: MessageTerminator
}

/**
 * One transport-neutral MCP wire message: the exact content bytes plus the
 * metadata needed to reproduce them on the originating transport.
 * Instances built by `clientMessage`/`serverMessage` are frozen (message
 * and meta). `bytes` stays a live Buffer — typed arrays with elements
 * cannot be frozen — and is shared, not copied, to preserve byte identity;
 * treat it as read-only.
 */
export interface McpMessage {
  readonly bytes: Buffer
  readonly meta: MessageMeta
}

/**
 * The gate's decision for one message. A member-for-member mirror of
 * `Verdict` in `proxy/pipeline.ts` with the same semantics: `'forward'`
 * relays the message's original wire bytes, `'drop'` writes nothing, and
 * `'emit'` writes the gate's replacement bytes verbatim (the gate is
 * responsible for its own framing/terminator).
 */
export type MessageVerdict =
  | { readonly action: 'forward' }
  | { readonly action: 'drop' }
  | { readonly action: 'emit'; readonly bytes: Buffer }

/**
 * Decides what happens to one message. Mirror of `GateFn` in
 * `proxy/pipeline.ts`: may answer synchronously or asynchronously, and an
 * asynchronous answer must never block later messages from being
 * delivered and gated.
 */
export type MessageGate = (message: McpMessage) => MessageVerdict | Promise<MessageVerdict>

/**
 * Serialized single-destination message writer — the message-level face of
 * `OrderedWriter` (`proxy/writer.ts`), with the same discipline: messages
 * land whole and strictly in `write` call order; the promise resolves once
 * the destination has accepted the message (and drained, under
 * backpressure); after `dispose()` writes resolve as no-ops; `dispose()`
 * is idempotent.
 */
export interface MessageSink {
  write(message: McpMessage): Promise<void>
  dispose(): void
}

/**
 * Push-driven message producer (see the module doc for why this is
 * callback-shaped rather than an async iterator). Register each handler
 * once, before messages start flowing. After `dispose()` no further
 * handler is invoked.
 */
export interface MessageSource {
  /** Delivers each inbound message, in wire order. */
  onMessage(handler: (message: McpMessage) => void): void
  /** Reports transport errors; mirrors `PipelineOptions.onError`. */
  onError(handler: (error: unknown) => void): void
  /** Fires once, when the source has ended; mirrors `PipelineOptions.onEnd`. */
  onEnd(handler: () => void): void
  /** Stops delivery and releases transport resources; idempotent. */
  dispose(): void
}

/** Raised by the message constructors when their input violates the contract. */
export class InvalidMessageError extends Error {
  constructor(reason: string) {
    super(`invalid MCP message: ${reason}`)
    this.name = 'InvalidMessageError'
  }
}

const VALID_TERMINATORS: ReadonlySet<string> = new Set<MessageTerminator>(['\n', '\r\n', 'none'])

/**
 * Validates and freezes one message. `bytes` is kept by reference (never
 * copied) so the message stays byte-identical to the wire; the `terminator`
 * key is omitted entirely when none is given, so a non-stdio message is
 * distinguishable from a stdio one.
 */
function buildMessage(
  origin: MessageOrigin,
  bytes: Buffer,
  terminator?: MessageTerminator,
): McpMessage {
  if (!Buffer.isBuffer(bytes)) {
    throw new InvalidMessageError('bytes must be a Buffer')
  }
  if (terminator !== undefined && !VALID_TERMINATORS.has(terminator)) {
    throw new InvalidMessageError(
      `terminator must be '\\n', '\\r\\n' or 'none', got ${JSON.stringify(terminator)}`,
    )
  }
  const meta: MessageMeta = Object.freeze(
    terminator === undefined ? { origin } : { origin, terminator },
  )
  return Object.freeze({ bytes, meta })
}

/** Builds a frozen message that originated on the client (agent) side. */
export function clientMessage(bytes: Buffer, terminator?: MessageTerminator): McpMessage {
  return buildMessage('client', bytes, terminator)
}

/** Builds a frozen message that originated on the server side. */
export function serverMessage(bytes: Buffer, terminator?: MessageTerminator): McpMessage {
  return buildMessage('server', bytes, terminator)
}
