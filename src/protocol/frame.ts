import { createFrameSplitter } from './split.js'

/**
 * Newline-delimited framing for the MCP stdio transport.
 *
 * This module deals only in bytes and lines. It does not know about
 * JSON-RPC, and must never parse JSON — that is the job of a separate,
 * replaceable layer above it (see the architectural invariant in
 * CLAUDE.md: transport framing must stay ignorant of message semantics).
 *
 * This is a thin decode-and-filter wrapper over `protocol/split.ts`, which
 * owns the actual byte-level splitting algorithm. `split.ts` reports every
 * frame verbatim (terminator kind, blank lines included) for callers that
 * need to relay bytes exactly as received (the M2 pipeline); this module
 * keeps its original M1 contract — decoded UTF-8 strings, terminator
 * stripped, blank lines omitted — unchanged.
 */

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
  const splitter = createFrameSplitter(options)

  function push(chunk: Buffer): string[] {
    const lines: string[] = []
    for (const frame of splitter.push(chunk)) {
      if (frame.isBlank) {
        continue
      }
      lines.push(frame.bytes.toString('utf8'))
    }
    return lines
  }

  return { push }
}
