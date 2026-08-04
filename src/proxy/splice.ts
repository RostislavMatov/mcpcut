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
 */

export interface SpliceOptions {
  /** Whether source 'end' should call destination.end(). Defaults to true. */
  endDestination?: boolean
  /** Called when the tap (line framing or onLine callback) throws. Defaults to console.error. */
  onError?: (error: unknown) => void
}

function defaultOnError(error: unknown): void {
  console.error(error)
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
): void {
  const endDestination = opts.endDestination ?? true
  const onError = opts.onError ?? defaultOnError
  const framer = createLineFramer()

  source.on('data', (chunk: Buffer) => {
    const hasRoomForMore = destination.write(chunk)
    if (!hasRoomForMore) {
      source.pause()
    }
    tapChunk(framer, chunk, onLine, onError)
  })

  destination.on('drain', () => {
    source.resume()
  })

  if (endDestination) {
    source.on('end', () => {
      destination.end()
    })
  }
}

/** Feeds a chunk into the tap's line framer and dispatches complete lines, isolating errors. */
function tapChunk(
  framer: LineFramer,
  chunk: Buffer,
  onLine: (line: string) => void,
  onError: (error: unknown) => void,
): void {
  let lines: string[]
  try {
    lines = framer.push(chunk)
  } catch (error) {
    onError(error)
    return
  }

  for (const line of lines) {
    try {
      onLine(line)
    } catch (error) {
      onError(error)
    }
  }
}
