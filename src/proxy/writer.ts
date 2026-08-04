import type { Writable } from 'node:stream'

/**
 * Serialized, single-destination message writer for the M2 transport
 * pipeline.
 *
 * This module deals only in bytes — it does not know about JSON-RPC and
 * must never parse a message (see the architectural invariant in
 * CLAUDE.md: transport stays ignorant of message semantics).
 *
 * In mode B (policy active), two producers can end up writing to the same
 * destination stream: the pipeline relaying forwarded messages, and a
 * synthetic-response injector (deny/timeout errors). `createOrderedWriter`
 * gives both of them a single serialized queue so a whole message is
 * always accepted by the destination — including waiting out backpressure —
 * before the next one is started, and their output can never interleave.
 */

export interface OrderedWriter {
  /**
   * Enqueues `bytes` as one whole message. Writes are processed strictly
   * in the order `writeMessage` was called: the returned promise resolves
   * once the destination has accepted the write (and, if the destination
   * signalled backpressure, once it has drained) — but only after every
   * write queued ahead of it has done the same.
   */
  writeMessage(bytes: Buffer): Promise<void>
  /**
   * Removes exactly the listeners this writer installed on the
   * destination. Any write already queued but not yet performed resolves
   * as a no-op instead of reaching the destination.
   */
  dispose(): void
}

export interface OrderedWriterOptions {
  /**
   * Called when the destination stream emits `'error'`. A destination
   * error must never surface as an uncaught exception, so this is the
   * only place it is reported. Defaults to writing one line to
   * `process.stderr`.
   */
  onError?: (error: unknown) => void
}

function defaultOnError(error: unknown): void {
  process.stderr.write(`[writer] destination error: ${describeError(error)}\n`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Creates a serialized message queue writing to a single destination stream. */
export function createOrderedWriter(
  destination: Writable,
  opts: OrderedWriterOptions = {},
): OrderedWriter {
  const onError = opts.onError ?? defaultOnError
  let isDisposed = false
  // The tail of the internal write queue. Each writeMessage() call chains
  // its own write onto it, so writes are started strictly in call order and
  // a later write never begins before an earlier one has been fully
  // accepted (and drained, if the destination applied backpressure).
  let tail: Promise<void> = Promise.resolve()
  // Settles the single write currently parked on backpressure (waiting for
  // 'drain'/'error'/'close'), if any, and detaches its transient listeners.
  // `dispose()` calls it so a parked write is never left hanging when the
  // destination neither drains nor closes (TS-L3).
  let settleParkedWrite: (() => void) | null = null

  const handleDestinationError = (error: unknown): void => onError(error)
  destination.on('error', handleDestinationError)

  function writeMessage(bytes: Buffer): Promise<void> {
    const write = tail.then(() => performWrite(bytes))
    // Keep the chain alive even though performWrite() itself never rejects:
    // this guards against one write's failure wedging every later message
    // behind a permanently-rejected tail.
    tail = write.catch(() => undefined)
    return write
  }

  function performWrite(bytes: Buffer): Promise<void> {
    if (isDisposed) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const hasRoomForMore = destination.write(bytes)
      if (hasRoomForMore) {
        resolve()
        return
      }
      // A destination that errors while backpressured never emits 'drain'
      // (Node stops processing its internal buffer once errored/destroyed),
      // so this write must also unblock on 'error'/'close' — otherwise a
      // failed write would hang its caller forever instead of resolving
      // once the failure has been reported via onError above.
      const settle = (): void => {
        destination.removeListener('drain', settle)
        destination.removeListener('error', settle)
        destination.removeListener('close', settle)
        settleParkedWrite = null
        resolve()
      }
      // Exposed so dispose() can force-settle this parked write itself.
      settleParkedWrite = settle
      destination.once('drain', settle)
      destination.once('error', settle)
      destination.once('close', settle)
    })
  }

  return {
    writeMessage,
    dispose(): void {
      if (isDisposed) {
        return
      }
      isDisposed = true
      destination.removeListener('error', handleDestinationError)
      // Force-settle a write parked on backpressure so its caller does not
      // hang forever on a destination that neither drains nor closes; the
      // settle callback also detaches its own transient listeners.
      settleParkedWrite?.()
    },
  }
}
