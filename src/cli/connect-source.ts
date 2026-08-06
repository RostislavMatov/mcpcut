import type { Readable } from 'node:stream'
import { createFrameSplitter, type Frame } from '../protocol/split.js'
import type { McpMessage, MessageOrigin, MessageSource } from '../transport/message.js'
import { frameToMessage } from '../transport/stdio-adapter.js'

/**
 * Message-source helpers for `connect` (M3 Task 12): turn a raw stdio
 * `Readable` into the transport-neutral `MessageSource` the session core
 * consumes, and guard a stateless upstream against a sessionful client.
 *
 * The readable adapter mirrors `proxy/pipeline.ts`'s frame dispatch
 * discipline exactly where it is security-relevant:
 *  - `'overflow'` frames are dropped and REPORTED, never converted or
 *    forwarded (C1) — via the dedicated `onOverflow` callback, not the
 *    source's error channel, because the session core ends the whole
 *    session on a source error while the pipeline keeps it alive;
 *  - blank frames pass through by default (the session core forwards them
 *    without gating, exactly like the stdio pipeline), but can be dropped
 *    for destinations that have no wire representation for them (an HTTP
 *    upstream must not POST empty bodies).
 */

export interface ReadableSourceOptions {
  /**
   * Drop blank frames instead of emitting them. Off by default (stdio
   * byte-identity); on for HTTP upstreams, where a blank line has no
   * representation.
   */
  readonly dropBlanks?: boolean
  /** Reports a dropped `'overflow'` fragment (see module doc). */
  readonly onOverflow?: (byteLength: number) => void
}

/**
 * Wraps a readable stdio stream as a `MessageSource`: bytes are split into
 * frames (terminators preserved) and converted 1:1 into messages. The
 * caller must register its handlers in the same synchronous block that
 * created the source — data events only start arriving on a later tick.
 */
export function createReadableMessageSource(
  readable: Readable,
  origin: MessageOrigin,
  opts: ReadableSourceOptions = {},
): MessageSource {
  const splitter = createFrameSplitter()
  let messageHandler: ((message: McpMessage) => void) | null = null
  let errorHandler: ((error: unknown) => void) | null = null
  let endHandler: (() => void) | null = null
  let isDisposed = false

  function deliver(frames: readonly Frame[]): void {
    for (const frame of frames) {
      if (isDisposed) {
        return
      }
      if (frame.reason === 'overflow') {
        opts.onOverflow?.(frame.bytes.length)
        continue
      }
      if (opts.dropBlanks === true && frame.isBlank) {
        continue
      }
      messageHandler?.(frameToMessage(frame, origin))
    }
  }

  const onData = (chunk: Buffer): void => {
    if (!isDisposed) {
      deliver(splitter.push(chunk))
    }
  }
  const onStreamError = (error: unknown): void => {
    if (!isDisposed) {
      errorHandler?.(error)
    }
  }
  const onStreamEnd = (): void => {
    if (isDisposed) {
      return
    }
    // A peer that died mid-line still produced bytes the other side must see.
    deliver(splitter.flush())
    endHandler?.()
  }

  readable.on('data', onData)
  readable.on('error', onStreamError)
  readable.on('end', onStreamEnd)

  return Object.freeze({
    onMessage: (handler: (message: McpMessage) => void) => {
      messageHandler = handler
    },
    onError: (handler: (error: unknown) => void) => {
      errorHandler = handler
    },
    onEnd: (handler: () => void) => {
      endHandler = handler
    },
    dispose: () => {
      if (isDisposed) {
        return
      }
      isDisposed = true
      readable.removeListener('data', onData)
      readable.removeListener('error', onStreamError)
      readable.removeListener('end', onStreamEnd)
    },
  })
}

/**
 * Model-mismatch guard for a `protocol: 'stateless'` upstream (ADR-0002):
 * if the FIRST non-blank client message is an `initialize` request, the
 * client speaks the sessionful model and the pair must be refused — the
 * message is never delivered downstream (so the upstream receives zero
 * bytes), the inner source is disposed, and `onMismatch` fires exactly
 * once. Any other first message passes the guard permanently.
 *
 * The detector is injected (`protocol/mcp.ts`'s `detectInitializeBytes`)
 * so this helper stays free of spec knowledge and trivially testable.
 */
export function guardStatelessInitialize(
  inner: MessageSource,
  isInitialize: (bytes: Buffer) => boolean,
  onMismatch: () => void,
): MessageSource {
  let hasChecked = false

  return Object.freeze({
    onMessage: (handler: (message: McpMessage) => void) => {
      inner.onMessage((message) => {
        if (!hasChecked && message.bytes.length > 0) {
          hasChecked = true
          if (isInitialize(message.bytes)) {
            inner.dispose()
            onMismatch()
            return
          }
        }
        handler(message)
      })
    },
    onError: (handler: (error: unknown) => void) => inner.onError(handler),
    onEnd: (handler: () => void) => inner.onEnd(handler),
    dispose: () => inner.dispose(),
  })
}
