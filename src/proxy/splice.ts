import type { Readable, Writable } from 'node:stream'
import { createLineFramer, type LineFramer } from '../protocol/frame.js'

/**
 * Byte-exact pass-through between a source and a destination stream, with
 * a side "tap" that reassembles complete lines for the journal.
 *
 * This module deals only in bytes and lines — never JSON-RPC. Forwarding
 * is the primary path and must never be slowed or broken by the tap: every
 * chunk is written to the destination first, unmodified, and the tap only
 * observes a copy of it afterwards.
 *
 * A splice owns exactly the listeners it installs: `dispose()` removes them
 * again, so a caller can wire the same streams more than once without leaking
 * listeners or keeping the event loop alive after it is done.
 */

/** Where a reported error came from: the tap callback, or one of the two streams. */
export type SpliceErrorOrigin = 'tap' | 'source' | 'destination'

export interface SpliceOptions {
  /** Whether source 'end' should call destination.end(). Defaults to true. */
  endDestination?: boolean
  /**
   * Called for tap failures (line framing or onLine throwing) and for stream
   * errors on either side. A stream error must never surface as an uncaught
   * exception, so this is the only place they are reported.
   * Defaults to writing one line to process.stderr.
   */
  onError?: (error: unknown, origin: SpliceErrorOrigin) => void
}

export interface SpliceHandle {
  /** Removes exactly the listeners this splice installed, and no others. */
  dispose(): void
  /**
   * Resolves once the source has finished and the destination has
   * acknowledged every forwarded chunk — or immediately once a stream error
   * or `dispose()` makes further relaying impossible.
   */
  readonly relayed: Promise<void>
}

function defaultOnError(error: unknown, origin: SpliceErrorOrigin): void {
  process.stderr.write(`[splice] ${origin} error: ${describeError(error)}\n`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Forwards every chunk from `source` to `destination` byte-for-byte, while
 * feeding the same chunk into a line framer and invoking `onLine` for each
 * complete line observed. Respects destination backpressure.
 */
export function splice(
  source: Readable,
  destination: Writable,
  onLine: (line: string) => void,
  opts: SpliceOptions = {},
): SpliceHandle {
  const relay = createRelayTracker()
  const pump = createPump({
    source,
    destination,
    onLine,
    relay,
    endDestination: opts.endDestination ?? true,
    onError: opts.onError ?? defaultOnError,
  })

  const registrations: readonly Registration[] = [
    register(source, 'data', pump.forwardChunk),
    register(source, 'end', pump.handleSourceEnd),
    register(source, 'error', pump.streamErrorReporter('source')),
    register(destination, 'drain', () => source.resume()),
    register(destination, 'error', pump.streamErrorReporter('destination')),
  ]
  // Explicit, because attaching 'data' only auto-resumes a stream that was
  // never explicitly paused — including one a previous splice disposed of.
  source.resume()

  return {
    dispose: () => {
      for (const registration of registrations) {
        registration.remove()
      }
      // Symmetric with attaching 'data', which put the source into flowing
      // mode: pausing releases it so it can no longer hold the event loop open.
      source.pause()
      relay.abort()
    },
    relayed: relay.relayed,
  }
}

interface PumpArgs {
  readonly source: Readable
  readonly destination: Writable
  readonly onLine: (line: string) => void
  readonly relay: RelayTracker
  readonly endDestination: boolean
  readonly onError: (error: unknown, origin: SpliceErrorOrigin) => void
}

/** The event handlers of one splice, sharing its framer and broken-pipe state. */
interface Pump {
  forwardChunk(chunk: Buffer): void
  handleSourceEnd(): void
  streamErrorReporter(origin: 'source' | 'destination'): (error: unknown) => void
}

function createPump(args: PumpArgs): Pump {
  const { source, destination, onLine, relay, onError } = args
  const framer = createLineFramer()
  let isBroken = false

  return {
    forwardChunk: (chunk) => {
      if (isBroken) {
        return
      }
      // Forwarding comes first and unmodified; the tap only ever sees a copy.
      const hasRoomForMore = destination.write(chunk, relay.trackWrite())
      if (!hasRoomForMore) {
        source.pause()
      }
      tapChunk(framer, chunk, onLine, onError)
    },
    handleSourceEnd: () => {
      relay.markSourceFinished()
      if (args.endDestination) {
        destination.end()
      }
    },
    streamErrorReporter: (origin) => (error) => {
      // A broken pipe stays broken: stop forwarding so one failure is reported
      // once instead of storming on every later chunk.
      isBroken = true
      relay.abort()
      onError(error, origin)
    },
  }
}

/** One installed listener, paired with the removal of exactly that listener. */
interface Registration {
  readonly remove: () => void
}

/** Attaches one listener and returns the handle that removes exactly it again. */
function register<Args extends unknown[]>(
  emitter: NodeJS.EventEmitter,
  event: string,
  listener: (...args: Args) => void,
): Registration {
  emitter.on(event, listener)
  return { remove: () => emitter.removeListener(event, listener) }
}

/** Tracks when the source is done and every forwarded chunk has been acknowledged. */
interface RelayTracker {
  readonly relayed: Promise<void>
  /** Registers one in-flight write and returns its completion callback. */
  trackWrite(): () => void
  markSourceFinished(): void
  /** Settles the relay immediately, for error and dispose paths. */
  abort(): void
}

function createRelayTracker(): RelayTracker {
  let pendingWrites = 0
  let isSourceFinished = false
  let settle: () => void = () => undefined
  const relayed = new Promise<void>((resolve) => {
    settle = resolve
  })

  function settleIfComplete(): void {
    if (isSourceFinished && pendingWrites === 0) {
      settle()
    }
  }

  function trackWrite(): () => void {
    pendingWrites += 1
    let isSettled = false
    return () => {
      if (isSettled) {
        return
      }
      isSettled = true
      pendingWrites -= 1
      settleIfComplete()
    }
  }

  return {
    relayed,
    trackWrite,
    markSourceFinished: () => {
      isSourceFinished = true
      settleIfComplete()
    },
    abort: () => settle(),
  }
}

/** Feeds a chunk into the tap's line framer and dispatches complete lines, isolating errors. */
function tapChunk(
  framer: LineFramer,
  chunk: Buffer,
  onLine: (line: string) => void,
  onError: (error: unknown, origin: SpliceErrorOrigin) => void,
): void {
  let lines: string[]
  try {
    lines = framer.push(chunk)
  } catch (error) {
    onError(error, 'tap')
    return
  }

  for (const line of lines) {
    try {
      onLine(line)
    } catch (error) {
      onError(error, 'tap')
    }
  }
}
