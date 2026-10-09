import { runBridge, type BridgeEnd } from '../../src/bridge/pump.js'
import type { McpMessage, MessageSink, MessageSource } from '../../src/transport/message.js'

/**
 * The hand-driven endpoints the bridge pump tests share (`pump.test.ts`,
 * `pump-retry.test.ts`): a source a test emits into, a sink that records,
 * parks or fails its writes.
 */

/** A `MessageSource` a test drives by hand. */
export function fakeSource() {
  let onMessage: ((message: McpMessage) => void) | undefined
  let onError: ((error: unknown) => void) | undefined
  let onEnd: (() => void) | undefined
  let disposals = 0

  return {
    source: {
      onMessage: (handler: (message: McpMessage) => void) => {
        onMessage = handler
      },
      onError: (handler: (error: unknown) => void) => {
        onError = handler
      },
      onEnd: (handler: () => void) => {
        onEnd = handler
      },
      dispose: () => {
        disposals += 1
      },
    } satisfies MessageSource,
    emit: (message: McpMessage) => onMessage?.(message),
    fail: (error: unknown) => onError?.(error),
    end: () => onEnd?.(),
    disposals: () => disposals,
  }
}

export interface FakeSink {
  readonly sink: MessageSink
  readonly written: McpMessage[]
  /** Makes the NEXT `write` hang until the returned function is called. */
  holdNext(): () => void
  /** Makes the next `write` reject with `error`; called again, the one after it too (in order). */
  failNext(error: unknown): void
}

export function fakeSink(): FakeSink {
  const written: McpMessage[] = []
  let hold: Promise<void> | undefined
  let release: (() => void) | undefined
  const errors: unknown[] = []

  return {
    written,
    sink: {
      write: async (message: McpMessage) => {
        // The hold is taken FIRST, so a write can be parked and then made to
        // fail on release — which is how a real POST that was already on the
        // wire when something else went wrong behaves.
        // An error already queued when the write starts is bound to it, so a
        // parked write fails on release whatever was written meanwhile; a
        // parked write with none takes one queued while it waited.
        const pending = hold
        const bound = errors.length > 0 ? { value: errors.shift() } : undefined
        hold = undefined
        if (pending !== undefined) await pending
        if (bound !== undefined) throw bound.value
        if (pending !== undefined && errors.length > 0) throw errors.shift()
        written.push(message)
      },
      dispose: () => undefined,
    },
    holdNext: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => release?.()
    },
    failNext: (error: unknown) => {
      errors.push(error)
    },
  }
}

export interface Rig {
  readonly clientIn: ReturnType<typeof fakeSource>
  readonly clientOut: FakeSink
  readonly serviceIn: ReturnType<typeof fakeSource>
  readonly serviceOut: FakeSink
  readonly diagnostics: string[]
  closes(): number
  readonly ended: Promise<BridgeEnd>
}

export function startRig(options: { readonly retryDelaysMs?: readonly number[] } = {}): Rig {
  const clientIn = fakeSource()
  const clientOut = fakeSink()
  const serviceIn = fakeSource()
  const serviceOut = fakeSink()
  const diagnostics: string[] = []
  let closes = 0

  const ended = runBridge({
    client: { source: clientIn.source, sink: clientOut.sink },
    service: {
      source: serviceIn.source,
      sink: serviceOut.sink,
      close: () => {
        closes += 1
        return Promise.resolve()
      },
    },
    onDiagnostic: (line) => diagnostics.push(line),
    ...(options.retryDelaysMs !== undefined ? { retryDelaysMs: options.retryDelaysMs } : {}),
  })

  return { clientIn, clientOut, serviceIn, serviceOut, diagnostics, closes: () => closes, ended }
}

/** Lets already-scheduled microtasks (and one macrotask) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function jsonOf(message: McpMessage): Record<string, unknown> {
  return JSON.parse(message.bytes.toString('utf8')) as Record<string, unknown>
}

