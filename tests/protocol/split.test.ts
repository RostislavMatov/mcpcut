import { describe, expect, test } from 'vitest'
import { createFrameSplitter, type Frame } from '../../src/protocol/split.js'

describe('createFrameSplitter', () => {
  test('returns a complete frame without the trailing newline, terminator preserved', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('hello world\n'))

    expect(frames).toHaveLength(1)
    expect(frames[0].bytes.toString('utf8')).toBe('hello world')
    expect(frames[0].terminator).toBe('\n')
    expect(frames[0].isBlank).toBe(false)
  })

  test('returns an empty array when no newline has arrived yet', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('partial message without newline'))

    expect(frames).toEqual([])
  })

  test('emits multiple messages contained in a single chunk', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'))

    expect(frames.map((f) => f.bytes.toString('utf8'))).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(frames.every((f) => f.terminator === '\n')).toBe(true)
  })

  test('reassembles one message split across many chunks', () => {
    const splitter = createFrameSplitter()

    const first = splitter.push(Buffer.from('{"jsonrpc":"2.'))
    const second = splitter.push(Buffer.from('0","method":"pi'))
    const third = splitter.push(Buffer.from('ng"}\n'))

    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(third).toHaveLength(1)
    expect(third[0].bytes.toString('utf8')).toBe('{"jsonrpc":"2.0","method":"ping"}')
    expect(third[0].terminator).toBe('\n')
  })

  test('reassembles a UTF-8 multibyte character split across the chunk boundary', () => {
    const splitter = createFrameSplitter()
    const full = Buffer.from('café 🎉\n', 'utf8')
    const splitPoint = full.length - 3

    const first = splitter.push(full.subarray(0, splitPoint))
    const second = splitter.push(full.subarray(splitPoint))

    expect(first).toEqual([])
    expect(second).toHaveLength(1)
    expect(second[0].bytes.toString('utf8')).toBe('café 🎉')
  })

  test('emits a blank frame for consecutive newlines, terminator \\n', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('one\n\n\ntwo\n'))

    expect(frames.map((f) => f.bytes.toString('utf8'))).toEqual(['one', '', '', 'two'])
    expect(frames.map((f) => f.isBlank)).toEqual([false, true, true, false])
  })

  test('reports \\r\\n as terminator and strips the trailing carriage return', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('one\r\ntwo\r\n'))

    expect(frames.map((f) => f.bytes.toString('utf8'))).toEqual(['one', 'two'])
    expect(frames.map((f) => f.terminator)).toEqual(['\r\n', '\r\n'])
  })

  test('a lone \\r\\n line yields an empty, blank frame with terminator \\r\\n', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('a\r\n\r\nb\r\n'))

    expect(frames.map((f) => f.bytes.toString('utf8'))).toEqual(['a', '', 'b'])
    expect(frames[1].terminator).toBe('\r\n')
    expect(frames[1].isBlank).toBe(true)
  })

  test('tolerates a lone carriage return in the middle of a line (not stripped, terminator \\n)', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('a\rb\n'))

    expect(frames).toHaveLength(1)
    expect(frames[0].bytes.toString('utf8')).toBe('a\rb')
    expect(frames[0].terminator).toBe('\n')
  })

  test('buffers an incomplete tail across push calls without emitting it early', () => {
    const splitter = createFrameSplitter()

    const first = splitter.push(Buffer.from('line-one\nline-two-incomplete'))
    const second = splitter.push(Buffer.from('-still-going'))
    const third = splitter.push(Buffer.from('-done\n'))

    expect(first.map((f) => f.bytes.toString('utf8'))).toEqual(['line-one'])
    expect(second).toEqual([])
    expect(third.map((f) => f.bytes.toString('utf8'))).toEqual(['line-two-incomplete-still-going-done'])
  })

  test('flushes an unterminated buffer once it exceeds maxBufferBytes with terminator none', () => {
    const maxBufferBytes = 8
    const splitter = createFrameSplitter({ maxBufferBytes })

    const frames = splitter.push(Buffer.from('0123456789'))

    expect(frames).toHaveLength(1)
    expect(frames[0].bytes.toString('utf8')).toBe('0123456789')
    expect(frames[0].terminator).toBe('none')
    expect(frames[0].isBlank).toBe(false)
    // A mid-stream overflow fragment must be classified 'overflow', so the
    // mode-B pipeline can fail closed on it instead of forwarding a fragment
    // a downstream reassembler would splice back together and execute (C1).
    expect(frames[0].reason).toBe('overflow')
  })

  test('classifies a normally terminated frame as reason "line"', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.from('hello\n'))

    expect(frames[0].reason).toBe('line')
  })

  test('resumes framing normally after an overflow flush', () => {
    const maxBufferBytes = 8
    const splitter = createFrameSplitter({ maxBufferBytes })

    const overflowFrames = splitter.push(Buffer.from('0123456789'))
    const nextFrames = splitter.push(Buffer.from('next-message\n'))

    expect(overflowFrames[0].terminator).toBe('none')
    expect(nextFrames.map((f) => f.bytes.toString('utf8'))).toEqual(['next-message'])
    expect(nextFrames[0].terminator).toBe('\n')
  })

  test('does not flush a buffered frame that is still within maxBufferBytes', () => {
    const maxBufferBytes = 8
    const splitter = createFrameSplitter({ maxBufferBytes })

    const frames = splitter.push(Buffer.from('short'))

    expect(frames).toEqual([])
  })

  test('uses MAX_LINE_BUFFER_BYTES from config as the default guard', async () => {
    const { MAX_LINE_BUFFER_BYTES } = await import('../../src/config.js')
    const splitter = createFrameSplitter()

    const justUnderLimit = Buffer.alloc(MAX_LINE_BUFFER_BYTES, 'x')
    const frames = splitter.push(justUnderLimit)

    expect(frames).toEqual([])
  })

  test('handles an empty chunk push without error', () => {
    const splitter = createFrameSplitter()

    const frames = splitter.push(Buffer.alloc(0))

    expect(frames).toEqual([])
  })

  test('reassembles an 8MB message split into 64KB chunks quickly, without quadratic slowdown', () => {
    const CHUNK_SIZE = 64 * 1024
    const LINE_BODY_SIZE = 8 * 1024 * 1024
    const WALL_CLOCK_BOUND_MS = 2000
    const splitter = createFrameSplitter()
    const full = Buffer.concat([Buffer.alloc(LINE_BODY_SIZE, 'x'), Buffer.from('\n')])

    const startedAt = Date.now()
    let observedFrames: Frame[] = []
    for (let offset = 0; offset < full.length; offset += CHUNK_SIZE) {
      const chunk = full.subarray(offset, Math.min(offset + CHUNK_SIZE, full.length))
      observedFrames = observedFrames.concat(splitter.push(chunk))
    }
    const elapsedMs = Date.now() - startedAt

    expect(observedFrames).toHaveLength(1)
    expect(observedFrames[0].bytes).toHaveLength(LINE_BODY_SIZE)
    expect(observedFrames[0].terminator).toBe('\n')
    expect(elapsedMs).toBeLessThan(WALL_CLOCK_BOUND_MS)
  })

  describe('terminator round-trip property', () => {
    /** Deterministic PRNG (mulberry32) so failures reproduce without external deps. */
    function mulberry32(seed: number): () => number {
      let state = seed
      return () => {
        state |= 0
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    function frameBytesToOriginal(frame: Frame): Buffer {
      const terminatorBytes = frame.terminator === 'none' ? Buffer.alloc(0) : Buffer.from(frame.terminator)
      return Buffer.concat([frame.bytes, terminatorBytes])
    }

    function randomSlices(rng: () => number, input: Buffer, maxSliceSize: number): Buffer[] {
      const slices: Buffer[] = []
      let offset = 0
      while (offset < input.length) {
        const size = Math.max(1, Math.floor(rng() * maxSliceSize))
        const end = Math.min(offset + size, input.length)
        slices.push(input.subarray(offset, end))
        offset = end
      }
      return slices
    }

    test('concatenating frame bytes + terminator reproduces the original input, for many random chunk slicings', () => {
      // Every message below ends in a terminator, so the whole input is
      // always fully framed by the end of the loop (no unflushed tail).
      const messages = [
        '{"jsonrpc":"2.0","method":"ping"}\n',
        '\n',
        'line with a lone \r inside\n',
        'crlf terminated\r\n',
        '\r\n',
        'café 🎉 unicode\n',
        '{"id":1,"result":{}}\r\n',
        'x'.repeat(500) + '\n',
      ]
      const original = Buffer.from(messages.join(''), 'utf8')

      for (let seed = 1; seed <= 25; seed += 1) {
        const rng = mulberry32(seed)
        const splitter = createFrameSplitter()
        const slices = randomSlices(rng, original, 17)

        const frames: Frame[] = []
        for (const slice of slices) {
          frames.push(...splitter.push(slice))
        }

        const reconstructed = Buffer.concat(frames.map(frameBytesToOriginal))
        expect(reconstructed.equals(original)).toBe(true)
      }
    })

    test('an overflow-flushed unterminated frame round-trips as bytes with no terminator suffix', () => {
      const maxBufferBytes = 4
      const splitter = createFrameSplitter({ maxBufferBytes })
      const original = Buffer.from('abcdefghij')

      const frames = splitter.push(original)

      const reconstructed = Buffer.concat(frames.map(frameBytesToOriginal))
      expect(reconstructed.equals(original)).toBe(true)
      expect(frames[0].terminator).toBe('none')
    })
  })
})

describe('createFrameSplitter flush', () => {
  test('returns an empty array when nothing is buffered', () => {
    const splitter = createFrameSplitter()

    expect(splitter.flush()).toEqual([])
  })

  test('returns an empty array when the last chunk ended exactly on a terminator', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('complete\n'))

    expect(splitter.flush()).toEqual([])
  })

  test('returns the pending unterminated fragment as a single frame with terminator "none"', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('done\npart'))

    const frames = splitter.flush()

    expect(frames).toHaveLength(1)
    expect(frames[0].bytes.toString('utf8')).toBe('part')
    expect(frames[0].terminator).toBe('none')
    expect(frames[0].isBlank).toBe(false)
    // A source-end fragment is legitimate final output, classified 'eof' —
    // distinct from an 'overflow' fragment, so the pipeline still relays it.
    expect(frames[0].reason).toBe('eof')
  })

  test('distinguishes an eof flush fragment from an overflow force-emit by reason', () => {
    const overflow = createFrameSplitter({ maxBufferBytes: 4 })
    const overflowFrames = overflow.push(Buffer.from('abcdefgh'))

    const eof = createFrameSplitter()
    eof.push(Buffer.from('tail-fragment'))
    const eofFrames = eof.flush()

    expect(overflowFrames[0].reason).toBe('overflow')
    expect(eofFrames[0].reason).toBe('eof')
    // Both look identical on the wire (terminator 'none'); only reason differs.
    expect(overflowFrames[0].terminator).toBe('none')
    expect(eofFrames[0].terminator).toBe('none')
  })

  test('joins a fragment spread across several chunks into one frame', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('{"jsonrpc":"2.'))
    splitter.push(Buffer.from('0","id":1'))

    const frames = splitter.flush()

    expect(frames.map((frame) => frame.bytes.toString('utf8'))).toEqual(['{"jsonrpc":"2.0","id":1'])
  })

  test('does not strip a trailing \\r: no terminator was seen, so those bytes are content', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('tail\r'))

    const frames = splitter.flush()

    expect(frames[0].bytes.toString('utf8')).toBe('tail\r')
    expect(frames[0].terminator).toBe('none')
  })

  test('clears the buffer: a second flush is empty and the splitter stays usable', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('part'))

    expect(splitter.flush()).toHaveLength(1)
    expect(splitter.flush()).toEqual([])

    const frames = splitter.push(Buffer.from('next\n'))

    expect(frames.map((frame) => frame.bytes.toString('utf8'))).toEqual(['next'])
  })

  test('returns a frozen frame, like every other frame the splitter emits', () => {
    const splitter = createFrameSplitter()
    splitter.push(Buffer.from('part'))

    expect(Object.isFrozen(splitter.flush()[0])).toBe(true)
  })

  test('push + flush together reproduce the original bytes of a stream ending mid-frame', () => {
    const splitter = createFrameSplitter()
    const original = Buffer.from('first\r\n\nlast fragment', 'utf8')

    const frames = [...splitter.push(original), ...splitter.flush()]

    const reconstructed = Buffer.concat(frames.map(originalBytesOf))
    expect(reconstructed.equals(original)).toBe(true)
  })
})

/** Reproduces a frame's original wire bytes (duplicated from the nested suite above). */
function originalBytesOf(frame: Frame): Buffer {
  const terminator = frame.terminator === 'none' ? '' : frame.terminator
  return Buffer.concat([frame.bytes, Buffer.from(terminator, 'utf8')])
}
