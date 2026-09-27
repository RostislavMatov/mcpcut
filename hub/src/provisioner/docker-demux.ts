/**
 * The demultiplexer for Docker's attach/exec stream (plan
 * `tenant-orchestrator`, Task 3). Without a TTY the daemon writes stdout and
 * stderr through `stdcopy` writers onto one stream of frames:
 *
 *     [stream u8, 0, 0, 0, size u32 BE] + payload
 *
 * where stream is 0 (stdin, written on stdout), 1 (stdout) or 2 (stderr).
 *
 * A pure step function: it takes the carried state and one chunk as the
 * socket delivered it, and returns a new state and the payload pieces found.
 * Headers and payloads may be cut anywhere between chunks. A payload is
 * emitted as it arrives, never buffered until its frame is whole, so a header
 * announcing 4 GiB costs nothing — the caller's cap decides what is kept.
 *
 * Errors quote no bytes: the stream is a command's output, and the command
 * the provisioner runs prints an owner token.
 */

export const DEMUX_HEADER_BYTES = 8

const STREAM_BYTE = 0
const SIZE_OFFSET = 4
const STDIN_TYPE = 0
const STDOUT_TYPE = 1
const STDERR_TYPE = 2

export type DockerStream = 'stdout' | 'stderr'

export interface DemuxState {
  /** The bytes of a header cut by a chunk boundary (fewer than 8). */
  readonly header: Buffer
  /** The stream of the frame being read, while `remaining > 0`. */
  readonly stream: DockerStream | undefined
  /** Payload bytes of the current frame not yet seen. */
  readonly remaining: number
}

export interface DemuxPiece {
  readonly stream: DockerStream
  readonly data: Buffer
}

export interface DemuxResult {
  readonly state: DemuxState
  readonly pieces: readonly DemuxPiece[]
}

export class MalformedStreamError extends Error {
  override readonly name = 'MalformedStreamError'
}

export const INITIAL_DEMUX_STATE: DemuxState = Object.freeze({
  header: Buffer.alloc(0),
  stream: undefined,
  remaining: 0,
})

export function demuxChunk(state: DemuxState, chunk: Buffer): DemuxResult {
  const pieces: DemuxPiece[] = []
  let current = state
  let offset = 0
  while (offset < chunk.length) {
    if (current.remaining > 0 && current.stream !== undefined) {
      const take = Math.min(current.remaining, chunk.length - offset)
      pieces.push({ stream: current.stream, data: chunk.subarray(offset, offset + take) })
      current = { header: current.header, stream: current.stream, remaining: current.remaining - take }
      offset += take
      continue
    }
    const wanted = DEMUX_HEADER_BYTES - current.header.length
    const taken = chunk.subarray(offset, offset + wanted)
    offset += taken.length
    const header = Buffer.concat([current.header, taken])
    current = header.length < DEMUX_HEADER_BYTES ? { header, stream: undefined, remaining: 0 } : frameStateOf(header)
  }
  return { state: current, pieces }
}

/** True when the stream ended on a frame boundary; false means output was cut. */
export function isDemuxComplete(state: DemuxState): boolean {
  return state.header.length === 0 && state.remaining === 0
}

function frameStateOf(header: Buffer): DemuxState {
  const padding = header.subarray(STREAM_BYTE + 1, SIZE_OFFSET)
  if (padding.some((byte) => byte !== 0)) {
    throw new MalformedStreamError('the exec stream is not framed (non-zero header padding)')
  }
  return { header: INITIAL_DEMUX_STATE.header, stream: streamOf(header.readUInt8(STREAM_BYTE)), remaining: header.readUInt32BE(SIZE_OFFSET) }
}

function streamOf(type: number): DockerStream {
  if (type === STDIN_TYPE || type === STDOUT_TYPE) return 'stdout'
  if (type === STDERR_TYPE) return 'stderr'
  throw new MalformedStreamError('the exec stream is not framed (unknown stream type)')
}
