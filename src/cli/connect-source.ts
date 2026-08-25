import type { McpMessage, MessageSource } from '../transport/message.js'

/**
 * Message-source helpers for `mcp-journal connect` (M3 Task 12).
 *
 * The Readable → `MessageSource` adapter moved to
 * `src/upstream/readable-source.ts` with the upstream extraction (M5.5,
 * probe engine); the re-export below keeps existing importers working. The
 * stateless-initialize guard stays here: it protects the CLIENT side of a
 * `connect` session and has no upstream consumer.
 */
export {
  createReadableMessageSource,
  type ReadableSourceOptions,
} from '../upstream/readable-source.js'

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
