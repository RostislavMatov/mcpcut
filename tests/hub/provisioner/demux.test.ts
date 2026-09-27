import { describe, expect, test } from 'vitest'
import {
  DEMUX_HEADER_BYTES,
  INITIAL_DEMUX_STATE,
  MalformedStreamError,
  demuxChunk,
  isDemuxComplete,
  type DemuxPiece,
  type DemuxState,
} from '../../../hub/src/provisioner/docker-demux.js'

/** One frame as Docker's `stdcopy` writes it: `[stream,0,0,0,size u32 BE] + payload`. */
function frame(stream: number, payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const header = Buffer.alloc(DEMUX_HEADER_BYTES)
  header.writeUInt8(stream, 0)
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

/** Feeds `chunks` one by one and joins what came out, per stream. */
function feed(chunks: readonly Buffer[]): { state: DemuxState; stdout: string; stderr: string; pieces: DemuxPiece[] } {
  let state = INITIAL_DEMUX_STATE
  const pieces: DemuxPiece[] = []
  for (const chunk of chunks) {
    const result = demuxChunk(state, chunk)
    state = result.state
    pieces.push(...result.pieces)
  }
  const joined = (stream: 'stdout' | 'stderr'): string =>
    Buffer.concat(pieces.filter((piece) => piece.stream === stream).map((piece) => piece.data)).toString('utf8')
  return { state, stdout: joined('stdout'), stderr: joined('stderr'), pieces }
}

/** Splits `buffer` into pieces of `size` bytes (the last may be shorter). */
function sliced(buffer: Buffer, size: number): Buffer[] {
  const out: Buffer[] = []
  for (let offset = 0; offset < buffer.length; offset += size) out.push(buffer.subarray(offset, offset + size))
  return out
}

describe('demuxChunk', () => {
  test('separates stdout and stderr frames delivered in one chunk', () => {
    // Arrange
    const stream = Buffer.concat([frame(1, 'out-1 '), frame(2, 'err-1'), frame(1, 'out-2')])

    // Act
    const result = feed([stream])

    // Assert
    expect(result.stdout).toBe('out-1 out-2')
    expect(result.stderr).toBe('err-1')
    expect(isDemuxComplete(result.state)).toBe(true)
  })

  test('stream type 0 (stdin) is written on stdout, as the Docker docs say', () => {
    const result = feed([frame(0, 'echoed')])

    expect(result.stdout).toBe('echoed')
    expect(result.stderr).toBe('')
  })

  test.each([1, 2, 3, 5, 7, 8, 9, 13])('a stream cut into %i-byte chunks demuxes to the same output', (size) => {
    // Arrange: headers and payloads both straddle chunk boundaries.
    const stream = Buffer.concat([frame(1, '{"admin":"alice"}'), frame(2, 'warning: stdout'), frame(1, '\n')])

    // Act
    const result = feed(sliced(stream, size))

    // Assert
    expect(result.stdout).toBe('{"admin":"alice"}\n')
    expect(result.stderr).toBe('warning: stdout')
    expect(isDemuxComplete(result.state)).toBe(true)
  })

  test('a header split across chunks is carried in the state, not emitted', () => {
    const whole = frame(1, 'abc')

    const first = demuxChunk(INITIAL_DEMUX_STATE, whole.subarray(0, 5))

    expect(first.pieces).toEqual([])
    expect(isDemuxComplete(first.state)).toBe(false)
    const second = demuxChunk(first.state, whole.subarray(5))
    expect(Buffer.concat(second.pieces.map((piece) => piece.data)).toString()).toBe('abc')
    expect(isDemuxComplete(second.state)).toBe(true)
  })

  test('a payload is emitted as it arrives, before its frame is complete (no whole-frame buffering)', () => {
    // A header that announces 1 GiB: the demuxer must not wait for it.
    const header = Buffer.alloc(DEMUX_HEADER_BYTES)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(1024 * 1024 * 1024, 4)

    const result = demuxChunk(INITIAL_DEMUX_STATE, Buffer.concat([header, Buffer.from('partial')]))

    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0]?.data.toString()).toBe('partial')
    expect(isDemuxComplete(result.state)).toBe(false)
  })

  test('zero-length frames are skipped', () => {
    const result = feed([Buffer.concat([frame(1, ''), frame(2, ''), frame(1, 'x')])])

    expect(result.pieces.map((piece) => piece.data.toString())).toEqual(['x'])
    expect(isDemuxComplete(result.state)).toBe(true)
  })

  test('the input state is never changed (a new state is returned)', () => {
    const start = demuxChunk(INITIAL_DEMUX_STATE, frame(1, 'abcdef').subarray(0, 10)).state
    const snapshot = { header: Buffer.from(start.header), stream: start.stream, remaining: start.remaining }

    demuxChunk(start, Buffer.from('cdef'))

    expect({ header: Buffer.from(start.header), stream: start.stream, remaining: start.remaining }).toEqual(snapshot)
    expect(INITIAL_DEMUX_STATE.header).toHaveLength(0)
    expect(INITIAL_DEMUX_STATE.remaining).toBe(0)
  })

  test('an empty chunk changes nothing', () => {
    const result = demuxChunk(INITIAL_DEMUX_STATE, Buffer.alloc(0))

    expect(result.pieces).toEqual([])
    expect(result.state).toEqual(INITIAL_DEMUX_STATE)
  })

  test.each([
    ['an unknown stream type', frame(3, 'x')],
    ['raw TTY text, which is not framed', Buffer.from('hello world, this is not framed')],
    ['non-zero padding bytes', Buffer.from([1, 0, 1, 0, 0, 0, 0, 1, 0x41])],
  ])('refuses %s with an error that quotes nothing', (_label, bytes) => {
    const act = (): unknown => demuxChunk(INITIAL_DEMUX_STATE, bytes)

    expect(act).toThrow(MalformedStreamError)
    try {
      act()
    } catch (error: unknown) {
      expect((error as Error).message).not.toMatch(/hello|world|x$/)
    }
  })

  test('a stream that stops mid-header or mid-payload is not complete', () => {
    expect(isDemuxComplete(feed([frame(1, 'abc').subarray(0, 3)]).state)).toBe(false)
    expect(isDemuxComplete(feed([frame(1, 'abc').subarray(0, 9)]).state)).toBe(false)
    expect(isDemuxComplete(INITIAL_DEMUX_STATE)).toBe(true)
  })
})
