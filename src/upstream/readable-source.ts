import type { Readable } from 'node:stream'
import { createFrameSplitter, type Frame } from '../protocol/split.js'
import type { McpMessage, MessageOrigin, MessageSource } from '../transport/message.js'
import { frameToMessage } from '../transport/stdio-adapter.js'

/**
 * Readable → `MessageSource` adapter (extracted from `cli/connect-source.ts`
 * for the shared upstream layer; the CLI module re-exports it unchanged).
 *
 * Mirrors `proxy/pipeline.ts`'s frame dispatch discipline exactly where it
 * is security-relevant:
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
