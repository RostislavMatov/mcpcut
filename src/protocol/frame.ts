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
const EMPTY_BUFFER = Buffer.alloc(0)

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

/** Creates a stateful line framer over newline-delimited byte chunks. */
export function createLineFramer(options: LineFramerOptions = {}): LineFramer {
  const maxBufferBytes = options.maxBufferBytes ?? MAX_LINE_BUFFER_BYTES
  let pending = EMPTY_BUFFER

  function push(chunk: Buffer): string[] {
    pending = Buffer.concat([pending, chunk])
    const lines = drainCompleteLines()

    if (pending.length > maxBufferBytes) {
      appendDecodedLine(lines, pending)
      pending = EMPTY_BUFFER
    }

    return lines
  }

  function drainCompleteLines(): string[] {
    const lines: string[] = []
    let newlineIndex = pending.indexOf(NEWLINE_BYTE)

    while (newlineIndex !== -1) {
      const rawLine = pending.subarray(0, newlineIndex)
      pending = pending.subarray(newlineIndex + 1)
      appendDecodedLine(lines, rawLine)
      newlineIndex = pending.indexOf(NEWLINE_BYTE)
    }

    return lines
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
