import { MAX_LINE_BUFFER_BYTES } from '../config.js'

/**
 * Byte-level, terminator-preserving frame splitter for the MCP stdio
 * transport.
 *
 * This module deals only in bytes. It does not know about JSON-RPC, and
 * must never parse JSON — that is the job of a separate, replaceable layer
 * above it (see the architectural invariant in CLAUDE.md: transport framing
 * must stay ignorant of message semantics).
 *
 * Unlike `frame.ts` (which decodes to UTF-8 strings and discards both the
 * terminator and blank lines), this splitter reports every frame exactly as
 * it appeared on the wire — terminator kind and blank-ness included. Which
 * terminator a message arrived with, and whether it was a lone blank line,
 * are byte-exact facts a transparent relay (M2 pipeline) must be able to
 * reproduce; `frame.ts` throws that information away by design, which is
 * why it is not reused directly.
 */

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

/** How a frame's content ended on the wire. */
export type Terminator = '\n' | '\r\n' | 'none'

/**
 * One frame produced by the splitter: the content bytes with any line
 * terminator removed, plus enough metadata to reproduce the original bytes
 * exactly (`bytes` followed by the terminator's own bytes).
 */
export interface Frame {
  /** Frame content, with the terminator (if any) already stripped. */
  readonly bytes: Buffer
  /**
   * `'none'` only occurs for an overflow flush of an unterminated buffer
   * (see `maxBufferBytes`) — no terminator byte was ever seen for it.
   */
  readonly terminator: Terminator
  /** True when `bytes` is empty (a lone terminator with no content). */
  readonly isBlank: boolean
}

export interface FrameSplitter {
  /**
   * Feed a raw chunk of bytes into the splitter. Returns zero or more
   * complete frames. Any incomplete tail is retained internally until the
   * next `push` call or an overflow flush.
   */
  push(chunk: Buffer): Frame[]
}

export interface FrameSplitterOptions {
  /**
   * Maximum number of bytes an unterminated (no `\n` yet) frame may
   * accumulate before it is force-flushed as-is, with `terminator: 'none'`.
   * Defaults to MAX_LINE_BUFFER_BYTES. Guards against unbounded memory
   * growth if a misbehaving peer never sends a newline.
   */
  maxBufferBytes?: number
}

/**
 * Creates a stateful frame splitter over newline-delimited byte chunks.
 *
 * The unterminated tail across `push` calls is kept as an array of Buffer
 * fragments plus a running byte total, instead of being concatenated
 * eagerly on every call: re-concatenating the whole backlog for each new
 * chunk would copy it again and again, turning one large message split
 * across many small chunks into an O(n^2) copy. Each new chunk is scanned
 * for newlines on its own; fragments are only concatenated once, when a
 * complete frame is emitted or the buffer overflows.
 */
export function createFrameSplitter(options: FrameSplitterOptions = {}): FrameSplitter {
  const maxBufferBytes = options.maxBufferBytes ?? MAX_LINE_BUFFER_BYTES
  let pendingChunks: Buffer[] = []
  let pendingBytes = 0

  function push(chunk: Buffer): Frame[] {
    const frames: Frame[] = []
    let searchStart = 0
    let newlineIndex = chunk.indexOf(NEWLINE_BYTE, searchStart)

    while (newlineIndex !== -1) {
      const piece = chunk.subarray(searchStart, newlineIndex)
      frames.push(toTerminatedFrame(completeLine(piece)))
      searchStart = newlineIndex + 1
      newlineIndex = chunk.indexOf(NEWLINE_BYTE, searchStart)
    }

    appendToPending(chunk.subarray(searchStart))

    if (pendingBytes > maxBufferBytes) {
      frames.push(toOverflowFrame(flushPending()))
    }

    return frames
  }

  /** Joins any buffered tail with the newly found line piece, exactly once. */
  function completeLine(piece: Buffer): Buffer {
    if (pendingBytes === 0) {
      return piece
    }
    const combined = Buffer.concat([...pendingChunks, piece], pendingBytes + piece.length)
    resetPending()
    return combined
  }

  /** Appends a chunk's unterminated remainder to the pending tail, without copying it. */
  function appendToPending(remainder: Buffer): void {
    if (remainder.length === 0) {
      return
    }
    pendingChunks.push(remainder)
    pendingBytes += remainder.length
  }

  function resetPending(): void {
    pendingChunks = []
    pendingBytes = 0
  }

  /** Concatenates and clears the whole pending tail, for an overflow flush. */
  function flushPending(): Buffer {
    const flushed = Buffer.concat(pendingChunks, pendingBytes)
    resetPending()
    return flushed
  }

  return { push }
}

/** Builds a frame for a `\n`-terminated line, stripping a trailing `\r` if present. */
function toTerminatedFrame(rawLine: Buffer): Frame {
  const lastIndex = rawLine.length - 1
  const hasTrailingCr = lastIndex >= 0 && rawLine[lastIndex] === CARRIAGE_RETURN_BYTE
  const bytes = hasTrailingCr ? rawLine.subarray(0, lastIndex) : rawLine
  return Object.freeze({
    bytes,
    terminator: hasTrailingCr ? '\r\n' : '\n',
    isBlank: bytes.length === 0,
  })
}

/** Builds a frame for an overflow-flushed, unterminated buffer. */
function toOverflowFrame(flushed: Buffer): Frame {
  return Object.freeze({
    bytes: flushed,
    terminator: 'none',
    isBlank: flushed.length === 0,
  })
}
