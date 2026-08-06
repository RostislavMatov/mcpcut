import { StringDecoder } from 'node:string_decoder'
import { MAX_UPSTREAM_RESPONSE_BYTES } from './constants.js'

/**
 * Incremental Server-Sent Events parser for the HTTP transport.
 *
 * Follows the WHATWG event-stream grammar as far as the MCP transport needs
 * it (`docs/research/http-spec-matrix.md`):
 * - an event is dispatched on a blank line; its multiple `data:` lines are
 *   joined with `\n` (byte-for-byte what the server serialized);
 * - `event:`/`id:` fields and `:` comments are ignored (resumability via
 *   event ids is explicitly out of M3 — matrix §1.4);
 * - `retry:` IS surfaced: the sessionful spec (Δ 2025-11-25) makes honoring
 *   it a client MUST, so the parser reports it as its own item;
 * - an event with no data (e.g. the 2025-11-25 priming event: `id` + empty
 *   `data`) dispatches nothing, per the WHATWG "empty data buffer" rule.
 *
 * The parser deals in text and field names only — it never inspects the
 * payload (no JSON-RPC knowledge; CLAUDE.md layering invariant).
 */

/** One parsed item: a complete event's data, or a `retry:` directive. */
export type SseItem =
  | { readonly kind: 'message'; readonly data: string }
  | { readonly kind: 'retry'; readonly retryMs: number }

/** Raised for a malformed/truncated stream (ended mid-event) or an oversized event. */
export class SseParseError extends Error {
  constructor(reason: string) {
    super(`invalid SSE stream: ${reason}`)
    this.name = 'SseParseError'
  }
}

export interface SseParser {
  /** Consumes one chunk; returns every item completed by it, in order. */
  feed(chunk: Buffer): SseItem[]
  /**
   * Signals end of stream. Throws `SseParseError` if the stream ended in
   * the middle of an event (unterminated line or undispatched data) —
   * a truncated stream must surface as an error, never be silently
   * accepted as complete.
   */
  end(): SseItem[]
}

const LINE_BREAK = /\r\n|\n|\r/
const DIGITS_ONLY = /^\d+$/
const UTF8_BOM = '﻿'

/**
 * Creates a fresh incremental parser. `maxBufferedChars` bounds the text
 * buffered for a single line/event so a hostile upstream cannot balloon
 * memory (chars ≥ bytes never understates usage).
 */
export function createSseParser(maxBufferedChars: number = MAX_UPSTREAM_RESPONSE_BYTES): SseParser {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let dataLines: string[] = []
  let sawFirstChunk = false

  function dispatch(): SseItem | null {
    if (dataLines.length === 0) {
      return null
    }
    const data = dataLines.join('\n')
    dataLines = []
    // WHATWG: an event whose data buffer is the empty string dispatches nothing.
    return data === '' ? null : Object.freeze({ kind: 'message' as const, data })
  }

  function handleLine(line: string): SseItem | null {
    if (line === '') {
      return dispatch()
    }
    if (line.startsWith(':')) {
      return null
    }
    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    const rawValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'data') {
      dataLines.push(value)
      return null
    }
    if (field === 'retry' && DIGITS_ONLY.test(value)) {
      return Object.freeze({ kind: 'retry' as const, retryMs: Number(value) })
    }
    // `event:`, `id:` and unknown fields are deliberately ignored (module doc).
    return null
  }

  function drainCompleteLines(): SseItem[] {
    const items: SseItem[] = []
    for (;;) {
      const match = LINE_BREAK.exec(buffer)
      if (match === null) {
        break
      }
      // A lone '\r' at the very end may be half of a '\r\n' split across
      // chunks — wait for the next chunk before treating it as a break.
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        break
      }
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const item = handleLine(line)
      if (item !== null) {
        items.push(item)
      }
    }
    return items
  }

  function ingest(text: string): SseItem[] {
    let cleaned = text
    if (!sawFirstChunk) {
      sawFirstChunk = true
      if (cleaned.startsWith(UTF8_BOM)) {
        cleaned = cleaned.slice(UTF8_BOM.length)
      }
    }
    buffer += cleaned
    if (buffer.length > maxBufferedChars) {
      throw new SseParseError(`event exceeds ${maxBufferedChars} buffered characters`)
    }
    return drainCompleteLines()
  }

  return Object.freeze({
    feed(chunk: Buffer): SseItem[] {
      return ingest(decoder.write(chunk))
    },
    end(): SseItem[] {
      const items = ingest(decoder.end())
      if (buffer.length > 0) {
        throw new SseParseError('stream ended with an unterminated line')
      }
      if (dataLines.length > 0) {
        throw new SseParseError('stream ended mid-event (data without a dispatching blank line)')
      }
      return items
    },
  })
}
