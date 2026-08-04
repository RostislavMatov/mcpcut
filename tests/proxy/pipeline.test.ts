import { randomBytes } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { startPipeline, type GateFn, type Verdict } from '../../src/proxy/pipeline.js'
import { createOrderedWriter, type OrderedWriter } from '../../src/proxy/writer.js'

/** Lets pending stream events and microtasks settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A minimal fake OrderedWriter that just records what it was asked to write. */
function createRecordingWriter(): { writer: OrderedWriter; written: Buffer[] } {
  const written: Buffer[] = []
  return {
    writer: {
      writeMessage: (bytes: Buffer) => {
        written.push(bytes)
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    written,
  }
}

interface CapturingWritable {
  writable: Writable
  chunks: Buffer[]
}

function createCapturingWritable(): CapturingWritable {
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  return { writable, chunks }
}

const FORWARD_GATE: GateFn = () => ({ action: 'forward' })

describe('startPipeline byte identity', () => {
  test('a stream with no gated frames comes out byte-for-byte identical, including \\r\\n and blank lines', async () => {
    const textPart = Buffer.from('café 🎉 {"a":1}\r\n\r\n', 'utf8')
    // A trailing terminator is required: protocol/split.ts documents that an
    // unterminated tail is retained internally until more data arrives (or
    // an overflow flush) — there is no source-end flush, so a fragment with
    // no final '\n' would still be sitting in the splitter's buffer when the
    // pipeline's `done` resolves, and never reach the destination.
    const binaryPart = Buffer.concat([randomBytes(256), Buffer.from('\n')])
    const full = Buffer.concat([textPart, binaryPart])

    // Unaligned boundaries, including one inside the multibyte "café 🎉" run.
    const boundaries = [3, 7, textPart.length - 2, textPart.length + 50, textPart.length + 130]
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()
    const writer = createOrderedWriter(destination)

    const handle = startPipeline(source, writer, FORWARD_GATE)

    let cursor = 0
    for (const boundary of boundaries) {
      source.write(full.subarray(cursor, boundary))
      cursor = boundary
    }
    source.write(full.subarray(cursor))
    source.end()

    await handle.done

    expect(Buffer.concat(chunks)).toEqual(full)
  })
})

describe('startPipeline verdict handling', () => {
  test('a deferred verdict does not delay later frames, but still writes once it settles', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    let releaseFrame1: (() => void) | undefined
    const gate: GateFn = (frame) => {
      if (frame.bytes.toString('utf8') === 'frame1') {
        return new Promise<Verdict>((resolve) => {
          releaseFrame1 = () => resolve({ action: 'forward' })
        })
      }
      return { action: 'forward' }
    }

    const handle = startPipeline(source, writer, gate)
    source.write('frame1\nframe2\n')
    await tick()

    expect(written.map((b) => b.toString('utf8'))).toEqual(['frame2\n'])

    releaseFrame1?.()
    await tick()

    expect(written.map((b) => b.toString('utf8'))).toEqual(['frame2\n', 'frame1\n'])

    source.end()
    await handle.done
  })

  test('an emit verdict writes the gate\'s bytes verbatim, not the original frame', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const replacement = Buffer.from('{"replaced":true}\n')
    const gate: GateFn = () => ({ action: 'emit', bytes: replacement })

    const handle = startPipeline(source, writer, gate)
    source.write('original\n')
    source.end()
    await handle.done

    expect(written).toEqual([replacement])
  })

  test('a drop verdict writes nothing', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const gate: GateFn = () => ({ action: 'drop' })

    const handle = startPipeline(source, writer, gate)
    source.write('blocked\n')
    source.end()
    await handle.done

    expect(written).toEqual([])
  })

  test('a gate that throws synchronously drops the frame and reports the error (fail-closed)', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const onError = vi.fn()
    const gate: GateFn = () => {
      throw new Error('gate exploded')
    }

    const handle = startPipeline(source, writer, gate, { onError })
    source.write('doomed\n')
    source.end()
    await handle.done

    expect(written).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('gate exploded')
  })

  test('writes to process.stderr as the default onError when no onError is given', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const source = new PassThrough()
    const { writer } = createRecordingWriter()
    const gate: GateFn = () => {
      throw new Error('unreported gate failure')
    }

    const handle = startPipeline(source, writer, gate)
    source.write('doomed\n')
    source.end()
    await handle.done

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('unreported gate failure')
    stderrSpy.mockRestore()
  })

  test('a rejected verdict promise drops the frame and reports the error (fail-closed)', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const onError = vi.fn()
    const gate: GateFn = () => Promise.reject(new Error('gate rejected'))

    const handle = startPipeline(source, writer, gate, { onError })
    source.write('doomed\n')
    source.end()
    await handle.done

    expect(written).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('gate rejected')
  })

  test('a blank frame is forwarded immediately without reaching the gate', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    let gateCallCount = 0
    const gate: GateFn = () => {
      gateCallCount += 1
      return { action: 'drop' }
    }

    const handle = startPipeline(source, writer, gate)
    source.write('\n')
    source.end()
    await handle.done

    expect(gateCallCount).toBe(0)
    expect(written).toEqual([Buffer.from('\n')])
  })
})

describe('startPipeline lifecycle', () => {
  test('dispose ignores a verdict that settles afterward', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    let resolveVerdict: ((verdict: Verdict) => void) | undefined
    const gate: GateFn = () =>
      new Promise((resolve) => {
        resolveVerdict = resolve
      })

    const handle = startPipeline(source, writer, gate)
    source.write('pending\n')
    await tick()

    handle.dispose()
    resolveVerdict?.({ action: 'forward' })
    await tick()

    expect(written).toEqual([])
  })

  test('dispose removes exactly the listeners it added on the source', () => {
    const source = new PassThrough()
    const { writer } = createRecordingWriter()
    const before = {
      data: source.listenerCount('data'),
      end: source.listenerCount('end'),
      error: source.listenerCount('error'),
    }

    const handle = startPipeline(source, writer, FORWARD_GATE)
    expect(source.listenerCount('data')).toBe(before.data + 1)

    handle.dispose()

    expect(source.listenerCount('data')).toBe(before.data)
    expect(source.listenerCount('end')).toBe(before.end)
    expect(source.listenerCount('error')).toBe(before.error)
  })

  test('dispose is idempotent', () => {
    const source = new PassThrough()
    const { writer } = createRecordingWriter()

    const handle = startPipeline(source, writer, FORWARD_GATE)

    expect(() => {
      handle.dispose()
      handle.dispose()
    }).not.toThrow()
  })

  test('a source error arriving after dispose is ignored, not reported twice', async () => {
    const source = new PassThrough()
    const { writer } = createRecordingWriter()
    const onError = vi.fn()
    // dispose() removes the pipeline's own 'error' listener; keep one of
    // our own attached so emitting 'error' below does not crash the test
    // process (Node throws on an 'error' event with no listeners at all).
    source.on('error', () => undefined)

    const handle = startPipeline(source, writer, FORWARD_GATE, { onError })
    handle.dispose()
    source.emit('error', new Error('too late'))
    await tick()

    expect(onError).not.toHaveBeenCalled()
  })

  test('done resolves only after source end and every pending verdict has settled', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    let resolveVerdict: ((verdict: Verdict) => void) | undefined
    const gate: GateFn = () =>
      new Promise((resolve) => {
        resolveVerdict = resolve
      })

    const handle = startPipeline(source, writer, gate)
    source.write('slow\n')
    source.end()
    await tick()

    let isDone = false
    void handle.done.then(() => {
      isDone = true
    })
    await tick()
    expect(isDone).toBe(false)
    expect(written).toEqual([])

    resolveVerdict?.({ action: 'forward' })
    await handle.done

    expect(isDone).toBe(true)
    expect(written).toEqual([Buffer.from('slow\n')])
  })

  test('calls onEnd once, only after source end and every pending verdict have settled', async () => {
    const source = new PassThrough()
    const { writer } = createRecordingWriter()
    const onEnd = vi.fn()
    let resolveVerdict: ((verdict: Verdict) => void) | undefined
    const gate: GateFn = () =>
      new Promise((resolve) => {
        resolveVerdict = resolve
      })

    startPipeline(source, writer, gate, { onEnd })
    source.write('slow\n')
    source.end()
    await tick()

    expect(onEnd).not.toHaveBeenCalled()

    resolveVerdict?.({ action: 'forward' })
    await tick()

    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  test('does not end the destination itself: lifecycle belongs to the wrap layer', async () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()
    const writer = createOrderedWriter(destination)

    const handle = startPipeline(source, writer, FORWARD_GATE)
    source.write('x\n')
    source.end()
    await handle.done

    expect(destination.writableEnded).toBe(false)
  })

  test('routes a source stream error to onError instead of letting it go uncaught', async () => {
    const source = new PassThrough()
    const { writer } = createRecordingWriter()
    const onError = vi.fn()

    startPipeline(source, writer, FORWARD_GATE, { onError })
    source.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }))
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as NodeJS.ErrnoException).code).toBe('EIO')
  })
})

describe('startPipeline trailing fragment', () => {
  test('forwards an unterminated final fragment when the source ends mid-frame', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()

    const handle = startPipeline(source, writer, FORWARD_GATE)
    source.write('complete\npartial')
    source.end()
    await handle.done

    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual(['complete\n', 'partial'])
  })

  test('routes the trailing fragment through the gate like any other frame', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const seen: string[] = []
    const gate: GateFn = (frame) => {
      seen.push(frame.bytes.toString('utf8'))
      return frame.bytes.toString('utf8') === 'partial'
        ? { action: 'drop' }
        : { action: 'forward' }
    }

    const handle = startPipeline(source, writer, gate)
    source.write('complete\npartial')
    source.end()
    await handle.done

    expect(seen).toEqual(['complete', 'partial'])
    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual(['complete\n'])
  })

  test('waits for an asynchronous verdict on the trailing fragment before resolving done', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    let releaseVerdict: (() => void) | undefined
    const gate: GateFn = () =>
      new Promise<Verdict>((resolve) => {
        releaseVerdict = () => resolve({ action: 'forward' })
      })

    const handle = startPipeline(source, writer, gate)
    source.write('tail-only')
    source.end()
    await tick()

    expect(written).toEqual([])

    releaseVerdict?.()
    await handle.done

    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual(['tail-only'])
  })

  test('resolves done with no extra write when the source ends exactly on a terminator', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()

    const handle = startPipeline(source, writer, FORWARD_GATE)
    source.write('complete\n')
    source.end()
    await handle.done

    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual(['complete\n'])
  })

  test('a stream ending mid-frame is still relayed byte-for-byte, trailing fragment included', async () => {
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()
    const writer = createOrderedWriter(destination)
    const full = Buffer.from('{"a":1}\r\n\n{"b":2} no newline here', 'utf8')

    const handle = startPipeline(source, writer, FORWARD_GATE)
    source.write(full.subarray(0, 5))
    source.write(full.subarray(5, 12))
    source.write(full.subarray(12))
    source.end()
    await handle.done

    expect(Buffer.concat(chunks)).toEqual(full)
  })
})

describe('startPipeline oversized-frame fail-closed (C1)', () => {
  test('an oversized unterminated frame is dropped, never delivered to the destination, and reported', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()
    const onError = vi.fn()
    let gateCalls = 0
    const gate: GateFn = () => {
      gateCalls += 1
      return { action: 'forward' }
    }

    // maxBufferBytes 8: a 16-byte newline-less chunk overflows and is
    // force-emitted as an 'overflow' fragment the pipeline must fail closed on.
    const handle = startPipeline(source, writer, gate, { onError, maxBufferBytes: 8 })
    source.write('0123456789ABCDEF')
    source.end()
    await handle.done

    expect(written).toEqual([]) // never forwarded to the server
    expect(gateCalls).toBe(0) // and never even reaches the gate
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('a legitimate eof trailing fragment still forwards while overflow fragments do not', async () => {
    const source = new PassThrough()
    const { writer, written } = createRecordingWriter()

    // 'short' (5 bytes < 8) never overflows; it is retained and flushed as an
    // 'eof' fragment at source end, which keeps the existing forward behavior.
    const handle = startPipeline(source, writer, FORWARD_GATE, { maxBufferBytes: 8 })
    source.write('short')
    source.end()
    await handle.done

    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual(['short'])
  })
})

describe('startPipeline backpressure', () => {
  test('pauses the source once pending frames exceed the high-water mark, and resumes once they settle', async () => {
    const source = new PassThrough()
    const releasers: Array<() => void> = []
    const writer: OrderedWriter = {
      writeMessage: () =>
        new Promise((resolve) => {
          releasers.push(resolve)
        }),
      dispose: () => undefined,
    }

    startPipeline(source, writer, FORWARD_GATE, { highWaterMark: 1 })
    source.write('a\nb\nc\n')
    await tick()

    expect(source.isPaused()).toBe(true)
    expect(releasers).toHaveLength(3)

    for (const release of releasers) {
      release()
    }
    await tick()

    expect(source.isPaused()).toBe(false)
    source.end()
  })
})
