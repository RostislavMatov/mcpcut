import type { Frame } from '../protocol/split.js'
import type { OrderedWriter } from '../proxy/writer.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageOrigin,
  type MessageSink,
  type MessageTerminator,
} from './message.js'

/**
 * Frame ↔ Message bridge for the stdio transport (M3).
 *
 * Converts between the M2 stdio framing world (`Frame` from
 * `protocol/split.ts`, `OrderedWriter` from `proxy/writer.ts`) and the
 * transport-neutral message contract (`./message.ts`), preserving byte
 * identity in both directions: for any splitter-produced frame,
 * `messageToChunk(frameToMessage(frame, origin))` equals the frame's
 * original wire bytes (content followed by its terminator's own bytes).
 *
 * This module deals only in bytes and metadata — no JSON-RPC/MCP
 * knowledge (CLAUDE.md invariant, enforced by
 * `tests/architecture/imports.test.ts`).
 *
 * Blank frames: `proxy/pipeline.ts` forwards blank frames directly,
 * without consulting the gate. That routing decision belongs to the
 * dispatcher (the pipeline today, the message-level session core in
 * Task 11), not to this converter — so `frameToMessage` converts blank
 * frames losslessly (empty bytes + their terminator), and the Task 11
 * dispatcher must keep bypassing the gate for them to preserve M2
 * behavior.
 *
 * Overflow frames: the pipeline fails closed on `reason: 'overflow'`
 * fragments — they are dropped before the gate and never forwarded (C1).
 * `MessageMeta` has no field to carry that discriminator, so converting
 * one would silently launder a must-not-forward fragment into an
 * ordinary-looking message. `frameToMessage` therefore refuses them with
 * a typed error; the dispatcher must drop overflow frames before
 * conversion, exactly as the pipeline does today.
 */

const NEWLINE_BYTE = 0x0a

const TERMINATOR_BYTES: Readonly<Record<MessageTerminator, Buffer>> = {
  '\n': Buffer.from('\n'),
  '\r\n': Buffer.from('\r\n'),
  none: Buffer.alloc(0),
}

/**
 * Raised by `frameToMessage` for a `reason: 'overflow'` frame: an
 * unterminated mid-stream fragment the pipeline must fail closed on. It
 * has no message representation on purpose (see the module doc).
 */
export class OverflowFrameError extends Error {
  constructor(byteLength: number) {
    super(
      `refusing to convert an 'overflow' frame (${byteLength} bytes) to a message: ` +
        'an oversized unterminated fragment must be dropped, never forwarded (C1)',
    )
    this.name = 'OverflowFrameError'
  }
}

/**
 * Raised by `messageToChunk` when a terminator-less (non-stdio) message
 * contains an embedded `\n`: line-framing it would split one message into
 * several on the stdio wire, so the contract violation is reported
 * instead of silently corrupting the stream.
 */
export class EmbeddedNewlineError extends Error {
  constructor(newlineIndex: number) {
    super(
      'cannot line-frame a terminator-less message for the stdio wire: ' +
        `bytes contain an embedded '\\n' at offset ${newlineIndex}`,
    )
    this.name = 'EmbeddedNewlineError'
  }
}

/**
 * Converts one splitter frame into a transport-neutral message. Bytes and
 * terminator are carried over 1:1 (the Buffer is shared, not copied).
 * Throws `OverflowFrameError` for `reason: 'overflow'` frames — see the
 * module doc.
 */
export function frameToMessage(frame: Frame, origin: MessageOrigin): McpMessage {
  if (frame.reason === 'overflow') {
    throw new OverflowFrameError(frame.bytes.length)
  }
  return origin === 'client'
    ? clientMessage(frame.bytes, frame.terminator)
    : serverMessage(frame.bytes, frame.terminator)
}

/**
 * Reproduces a message's stdio wire bytes: content followed by its
 * terminator's bytes (`'none'` contributes nothing — byte identity for a
 * frame that never had one). A message without a terminator did not come
 * from stdio (HTTP body/SSE event); the stdio wire requires line framing,
 * so `\n` is appended — after verifying the bytes contain no embedded
 * `\n`, which would be a contract violation (`EmbeddedNewlineError`), not
 * something to smuggle onto the wire.
 */
export function messageToChunk(message: McpMessage): Buffer {
  const terminator = message.meta.terminator
  if (terminator !== undefined) {
    return Buffer.concat([message.bytes, TERMINATOR_BYTES[terminator]])
  }
  const newlineIndex = message.bytes.indexOf(NEWLINE_BYTE)
  if (newlineIndex !== -1) {
    throw new EmbeddedNewlineError(newlineIndex)
  }
  return Buffer.concat([message.bytes, TERMINATOR_BYTES['\n']])
}

/**
 * Wraps an existing serialized byte writer (`OrderedWriter` or anything
 * structurally compatible) as a `MessageSink`: each message is serialized
 * to its wire form via `messageToChunk` and enqueued whole, so ordering
 * and no-interleave guarantees are inherited from the writer. A framing
 * violation rejects that write and reaches the writer not at all
 * (fail closed). After `dispose()` — idempotent, delegated to the writer
 * once — writes resolve as no-ops.
 */
export function createStdioMessageSink(writer: OrderedWriter): MessageSink {
  let isDisposed = false

  function write(message: McpMessage): Promise<void> {
    if (isDisposed) {
      return Promise.resolve()
    }
    let chunk: Buffer
    try {
      chunk = messageToChunk(message)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return writer.writeMessage(chunk)
  }

  return {
    write,
    dispose(): void {
      if (isDisposed) {
        return
      }
      isDisposed = true
      writer.dispose()
    },
  }
}
