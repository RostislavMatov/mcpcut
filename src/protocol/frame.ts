import { MAX_LINE_BUFFER_BYTES } from '../config.js'

/**
 * Newline-delimited framing for the MCP stdio transport.
 *
 * This module deals only in bytes and lines. It does not know about
 * JSON-RPC, and must never parse JSON — that is the job of a separate,
 * replaceable layer above it (see the architectural invariant in
 * CLAUDE.md: transport framing must stay ignorant of message semantics).
 */

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

export interface LineFramer {
  /**
   * Feed a raw chunk of bytes into the framer. Returns zero or more
   * complete, decoded lines (trailing `\n`/`\r\n` stripped, empty lines
   * omitted). Any incomplete tail is retained internally until the next
   * `push` call or an overflow flush.
   */
  push(chunk: Buffer): string[]
}

export interface LineFramerOptions {
  /**
   * Maximum number of bytes an unterminated (no `\n` yet) line may
   * accumulate before it is force-flushed as-is. Defaults to
   * MAX_LINE_BUFFER_BYTES. Guards against unbounded memory growth if a
   * misbehaving peer never sends a newline.
   */
  maxBufferBytes?: number
}

/**
 * Creates a stateful line framer over newline-delimited byte chunks.
 *
 * The unterminated tail across `push` calls is kept as an array of Buffer
 * fragments plus a running byte total, instead of being concatenated
 * eagerly on every call: re-concatenating the whole backlog for each new
 * chunk would copy it again and again, turning one large message split
 * across many small chunks into an O(n^2) copy. Each new chunk is scanned
 * for newlines on its own; fragments are only concatenated once, when a
 * complete line is emitted or the buffer overflows.
 */
export function createLineFramer(options: LineFramerOptions = {}): LineFramer {
  const maxBufferBytes = options.maxBufferBytes ?? MAX_LINE_BUFFER_BYTES
  let pendingChunks: Buffer[] = []
  let pendingBytes = 0

  function push(chunk: Buffer): string[] {
    const lines: string[] = []
    let searchStart = 0
    let newlineIndex = chunk.indexOf(NEWLINE_BYTE, searchStart)

    while (newlineIndex !== -1) {
      const piece = chunk.subarray(searchStart, newlineIndex)
      appendDecodedLine(lines, completeLine(piece))
      searchStart = newlineIndex + 1
      newlineIndex = chunk.indexOf(NEWLINE_BYTE, searchStart)
    }

    appendToPending(chunk.subarray(searchStart))

    if (pendingBytes > maxBufferBytes) {
      appendDecodedLine(lines, flushPending())
    }

    return lines
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

/** Strips a trailing `\r`, decodes to UTF-8, and skips empty lines. */
function appendDecodedLine(lines: string[], rawLine: Buffer): void {
  const trimmed = stripTrailingCarriageReturn(rawLine)
  if (trimmed.length === 0) {
    return
  }
  lines.push(trimmed.toString('utf8'))
}

function stripTrailingCarriageReturn(rawLine: Buffer): Buffer {
  const lastIndex = rawLine.length - 1
  const hasTrailingCr = lastIndex >= 0 && rawLine[lastIndex] === CARRIAGE_RETURN_BYTE
  return hasTrailingCr ? rawLine.subarray(0, lastIndex) : rawLine
}
