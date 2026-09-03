import { describe, expect, test } from 'vitest'
import { createLineReader } from '../../src/cli/serve-upstream.js'

/**
 * The stderr tap of a stdio server `serve` spawned (security audit 2026-09-02,
 * finding F1): the line reader must be bounded exactly like the stdout
 * framing. A child that writes stderr without ever sending a newline must
 * not grow the shared `serve` daemon's heap for the life of the session.
 */

/** Small injected cap so the overflow path runs without allocating MAX_LINE_BUFFER_BYTES. */
const CAP_BYTES = 64
const CHUNK_BYTES = 16
/** Enough newline-less chunks to pass the cap two and a half times over. */
const CHUNK_COUNT = 10

function collect(): { readonly lines: string[]; onLine(line: string): void } {
  const lines: string[] = []
  return { lines, onLine: (line) => lines.push(line) }
}

function bytesDelivered(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0)
}

describe('createLineReader — line reassembly', () => {
  test('a line split across chunks is delivered once, whole', () => {
    const { lines, onLine } = collect()
    const reader = createLineReader(onLine)

    reader.push(Buffer.from('hel', 'utf8'))
    reader.push(Buffer.from('lo\nwor', 'utf8'))
    expect(lines).toEqual(['hello'])

    reader.push(Buffer.from('ld\n', 'utf8'))
    expect(lines).toEqual(['hello', 'world'])
  })

  test('blank lines are skipped and a CRLF terminator leaves no stray \\r', () => {
    const { lines, onLine } = collect()
    const reader = createLineReader(onLine)

    reader.push(Buffer.from('\n\nfirst\r\n\nsecond\n', 'utf8'))

    expect(lines).toEqual(['first', 'second'])
  })

  test('a multi-byte UTF-8 character split across chunks decodes intact', () => {
    // 'é' is C3 A9; decoding each chunk on its own would yield two U+FFFD.
    const { lines, onLine } = collect()
    const reader = createLineReader(onLine)

    reader.push(Buffer.from([0xc3]))
    reader.push(Buffer.from([0xa9, 0x0a]))

    expect(lines).toEqual(['é'])
  })
})

describe('createLineReader — bounded against a newline-less stream (audit F1)', () => {
  test('flush() delivers the final unterminated line — a crash message rarely ends in a newline', () => {
    // Arrange
    const lines: string[] = []
    const reader = createLineReader((line) => lines.push(line))
    reader.push(Buffer.from('ok line\nFatal error: out of memory'))

    // Act
    reader.flush()

    // Assert
    expect(lines).toEqual(['ok line', 'Fatal error: out of memory'])
  })

  test('flush() with nothing buffered delivers nothing', () => {
    const lines: string[] = []
    const reader = createLineReader((line) => lines.push(line))
    reader.push(Buffer.from('done\n'))

    reader.flush()

    expect(lines).toEqual(['done'])
  })

  test('never retains more than the cap; the overflow is flushed as diagnostic lines', () => {
    const { lines, onLine } = collect()
    const reader = createLineReader(onLine, { maxBufferBytes: CAP_BYTES })
    const chunk = Buffer.alloc(CHUNK_BYTES, 'x')
    let fed = 0

    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      reader.push(chunk)
      fed += CHUNK_BYTES
      // The observable tail: what went in and has not come back out yet.
      expect(fed - bytesDelivered(lines)).toBeLessThanOrEqual(CAP_BYTES)
    }

    expect(fed).toBeGreaterThanOrEqual(2 * CAP_BYTES)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // An overflow flush fires the moment the tail passes the cap, so each
      // flushed line exceeds the cap by at most the chunk that tipped it over.
      expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(CAP_BYTES)
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(CAP_BYTES + CHUNK_BYTES)
    }
  })

  test('a newline after an overflow flush starts a fresh line, not a spliced one', () => {
    const { lines, onLine } = collect()
    const reader = createLineReader(onLine, { maxBufferBytes: CAP_BYTES })

    reader.push(Buffer.alloc(CAP_BYTES + 1, 'x'))
    reader.push(Buffer.from('tail\n', 'utf8'))

    expect(lines).toEqual(['x'.repeat(CAP_BYTES + 1), 'tail'])
  })
})
