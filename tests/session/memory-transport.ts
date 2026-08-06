import type { McpMessage, MessageSink, MessageSource } from '../../src/transport/message.js'
import { clientMessage, serverMessage } from '../../src/transport/message.js'

/**
 * In-memory `MessageSource`/`MessageSink` pair for `session/core.ts` tests:
 * a push-driven source the test feeds by hand, and a sink that records every
 * message it accepted. Both honor the contracts in `transport/message.ts`
 * (one handler per channel, no delivery after dispose, sink writes resolve
 * as no-ops after dispose).
 */

export interface MemorySource extends MessageSource {
  /** Delivers one message to the registered handler (no-op after dispose). */
  emit(message: McpMessage): void
  /** Fires the end handler once (no-op after dispose). */
  end(): void
  /** Fires the error handler (no-op after dispose). */
  fail(error: unknown): void
  isDisposed(): boolean
}

export function createMemorySource(): MemorySource {
  let onMessage: ((message: McpMessage) => void) | null = null
  let onError: ((error: unknown) => void) | null = null
  let onEnd: (() => void) | null = null
  let disposed = false

  return {
    onMessage: (handler) => {
      onMessage = handler
    },
    onError: (handler) => {
      onError = handler
    },
    onEnd: (handler) => {
      onEnd = handler
    },
    dispose: () => {
      disposed = true
    },
    emit: (message) => {
      if (!disposed) onMessage?.(message)
    },
    end: () => {
      if (!disposed) onEnd?.()
    },
    fail: (error) => {
      if (!disposed) onError?.(error)
    },
    isDisposed: () => disposed,
  }
}

export interface MemorySink extends MessageSink {
  readonly written: McpMessage[]
  isDisposed(): boolean
}

export function createMemorySink(): MemorySink {
  const written: McpMessage[] = []
  let disposed = false

  return {
    written,
    write: (message) => {
      if (!disposed) written.push(message)
      return Promise.resolve()
    },
    dispose: () => {
      disposed = true
    },
    isDisposed: () => disposed,
  }
}

/** One terminator-less (HTTP-style) message from the given side. */
export function messageOf(origin: 'client' | 'server', body: unknown): McpMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  return origin === 'client' ? clientMessage(bytes) : serverMessage(bytes)
}

/** Parses one recorded message's content bytes as JSON. */
export function parseMessage(message: McpMessage): Record<string, any> {
  return JSON.parse(message.bytes.toString('utf8')) as Record<string, any>
}
