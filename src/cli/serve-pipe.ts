import type { McpMessage, MessageSink, MessageSource } from '../transport/message.js'

/**
 * In-memory `MessageSource`/`MessageSink` pair connecting the HTTP front to
 * one `session/core.ts` session (M3 Task 13).
 *
 * The front's `OpenedSession` writes agent bytes into `front.sink`; those
 * surface on `session.source` (the session's client-side source). Whatever
 * the session relays or synthesizes toward the agent goes into
 * `session.sink` and surfaces on `front.source`, which the front routes to
 * the waiting POST response / GET stream.
 *
 *   front.sink ──▶ session.source        (agent → plane)
 *   session.sink ──▶ front.source        (plane → agent)
 *
 * Contracts honored (`transport/message.ts`): one handler per channel, no
 * delivery after `dispose()`, sink writes resolve as no-ops after either
 * side is disposed. Delivery is synchronous, like the test memory transport
 * — ordering is the call order, which both producers already serialize.
 */

interface Channel {
  readonly sink: MessageSink
  readonly source: MessageSource
  /** Fires the source's `onEnd` once (no-op after source dispose). */
  end(): void
}

function createChannel(): Channel {
  let onMessage: ((message: McpMessage) => void) | null = null
  let onEnd: (() => void) | null = null
  let isSinkDisposed = false
  let isSourceDisposed = false
  let hasEnded = false

  const sink: MessageSink = Object.freeze({
    write(message: McpMessage): Promise<void> {
      if (!isSinkDisposed && !isSourceDisposed) {
        onMessage?.(message)
      }
      return Promise.resolve()
    },
    dispose(): void {
      isSinkDisposed = true
    },
  })

  const source: MessageSource = Object.freeze({
    onMessage(handler: (message: McpMessage) => void): void {
      onMessage = handler
    },
    onError(): void {
      // This channel never produces transport errors of its own.
    },
    onEnd(handler: () => void): void {
      onEnd = handler
    },
    dispose(): void {
      isSourceDisposed = true
    },
  })

  return {
    sink,
    source,
    end(): void {
      if (hasEnded || isSourceDisposed) {
        return
      }
      hasEnded = true
      onEnd?.()
    },
  }
}

/** The two faces of one front⇄session bridge. */
export interface MemoryPipe {
  /** Handed to the HTTP front as the opened session's endpoints. */
  readonly front: { readonly sink: MessageSink; readonly source: MessageSource }
  /** Handed to `createSession` as its `client` endpoints. */
  readonly session: { readonly sink: MessageSink; readonly source: MessageSource }
  /**
   * Signals the front that this conversation is over (fires
   * `front.source.onEnd` once) — called after the session has fully ended,
   * so the front tears its `ActiveSession` down.
   */
  endFrontSource(): void
}

export function createMemoryPipe(): MemoryPipe {
  const agentToPlane = createChannel()
  const planeToAgent = createChannel()

  return Object.freeze({
    front: Object.freeze({ sink: agentToPlane.sink, source: planeToAgent.source }),
    session: Object.freeze({ sink: planeToAgent.sink, source: agentToPlane.source }),
    endFrontSource: () => planeToAgent.end(),
  })
}
