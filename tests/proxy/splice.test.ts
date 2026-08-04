import { randomBytes } from 'node:crypto'
import { PassThrough, Writable, type Readable } from 'node:stream'
import { once } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { splice } from '../../src/proxy/splice.js'

const SLOW_DESTINATION_DELAY_MS = 5

interface CapturingWritable {
  writable: Writable
  chunks: Buffer[]
}

/** Lets pending stream events and microtasks settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface ListenerCounts {
  sourceData: number
  sourceEnd: number
  sourceError: number
  destinationDrain: number
  destinationError: number
}

function snapshotListenerCounts(source: Readable, destination: Writable): ListenerCounts {
  return {
    sourceData: source.listenerCount('data'),
    sourceEnd: source.listenerCount('end'),
    sourceError: source.listenerCount('error'),
    destinationDrain: destination.listenerCount('drain'),
    destinationError: destination.listenerCount('error'),
  }
}

/** A Writable that records every chunk it receives, for byte-identity assertions. */
function createCapturingWritable(highWaterMark?: number): CapturingWritable {
  const chunks: Buffer[] = []
  const writable = new Writable({
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  return { writable, chunks }
}

describe('splice', () => {
  test('forwards a single chunk to the destination byte-for-byte', async () => {
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()

    splice(source, destination, () => undefined)
    source.write(Buffer.from('hello world\n'))
    source.end()
    await once(destination, 'finish')

    expect(Buffer.concat(chunks)).toEqual(Buffer.from('hello world\n'))
  })

  test('forwards random binary chunks, including a UTF-8 multibyte split, identically', async () => {
    const textPart = Buffer.from('café 🎉 {"a":1}\n', 'utf8')
    const binaryPart = randomBytes(256)
    const full = Buffer.concat([textPart, binaryPart])

    // Split into several arbitrary, unaligned boundaries, including one
    // that lands inside the multibyte "café 🎉" sequence.
    const boundaries = [3, 7, textPart.length - 2, textPart.length + 50, textPart.length + 130]
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()

    splice(source, destination, () => undefined)

    let cursor = 0
    for (const boundary of boundaries) {
      source.write(full.subarray(cursor, boundary))
      cursor = boundary
    }
    source.write(full.subarray(cursor))
    source.end()
    await once(destination, 'finish')

    expect(Buffer.concat(chunks)).toEqual(full)
  })

  test('the tap observes every complete line reassembled across chunk boundaries', async () => {
    const source = new PassThrough()
    const destination = new PassThrough()
    destination.resume()
    const lines: string[] = []

    splice(source, destination, (line) => lines.push(line))

    source.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.')
    source.write('0","id":2}\n')
    source.end()
    await once(source, 'end')
    await new Promise((resolve) => setImmediate(resolve))

    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"method":"a"}', '{"jsonrpc":"2.0","id":2}'])
  })

  test('a throwing onLine callback does not stop forwarding or later lines', async () => {
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()
    const onError = vi.fn()
    const seenLines: string[] = []

    splice(
      source,
      destination,
      (line) => {
        seenLines.push(line)
        if (line === 'boom') {
          throw new Error('onLine exploded')
        }
      },
      { onError },
    )

    source.write('boom\nsurvivor\n')
    source.end()
    await once(destination, 'finish')

    expect(seenLines).toEqual(['boom', 'survivor'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]?.[1]).toBe('tap')
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('boom\nsurvivor\n'))
  })

  test('reports a framing failure as a tap error instead of crashing the forwarder', async () => {
    // An object-mode source hands the framer something it cannot concatenate.
    const source = new PassThrough({ objectMode: true })
    const chunks: unknown[] = []
    const destination = new Writable({
      objectMode: true,
      write(chunk: unknown, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    })
    const onError = vi.fn()

    splice(source, destination, () => undefined, { onError, endDestination: false })
    source.write({ notABuffer: true })
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[1]).toBe('tap')
    expect(chunks).toEqual([{ notABuffer: true }])
  })

  test('writes to process.stderr as the default onError when the tap throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()

    splice(source, destination, () => {
      throw new Error('tap failure')
    })

    source.write('line\n')
    source.end()
    await once(destination, 'finish')

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('tap failure')
    stderrSpy.mockRestore()
  })

  test('ends the destination when the source ends, by default', async () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()

    splice(source, destination, () => undefined)
    source.end()

    await once(destination, 'finish')
    expect(destination.writableEnded).toBe(true)
  })

  test('does not end the destination when endDestination is false', async () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()

    splice(source, destination, () => undefined, { endDestination: false })
    source.write('x\n')
    source.end()
    await once(source, 'end')
    await new Promise((resolve) => setImmediate(resolve))

    expect(destination.writableEnded).toBe(false)
  })

  test('pauses the source when the destination signals backpressure, and resumes on drain', async () => {
    const source = new PassThrough()
    const received: Buffer[] = []
    let releaseWrite: (() => void) | undefined
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk)
        releaseWrite = () => callback()
      },
    })

    splice(source, destination, () => undefined)

    source.write(Buffer.alloc(64, 'a'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(source.isPaused()).toBe(true)

    releaseWrite?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(source.isPaused()).toBe(false)

    source.end()
  })
})

describe('splice stream errors', () => {
  test('routes a source stream error to onError instead of letting it go uncaught', async () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()
    const onError = vi.fn()

    splice(source, destination, () => undefined, { onError, endDestination: false })
    source.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }))
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]?.[1]).toBe('source')
  })

  test('routes a destination stream error to onError instead of letting it go uncaught', async () => {
    const source = new PassThrough()
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      },
    })
    const onError = vi.fn()

    splice(source, destination, () => undefined, { onError, endDestination: false })
    source.write('payload\n')
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[1]).toBe('destination')
    expect((onError.mock.calls[0]?.[0] as NodeJS.ErrnoException).code).toBe('EPIPE')
  })

  test('stops forwarding once the destination has failed, even while it still accepts writes', async () => {
    // Models how a socket surfaces EPIPE: the write itself succeeds and the
    // stream stays writable, and the error arrives asynchronously afterwards.
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()
    const onError = vi.fn()

    splice(source, destination, () => undefined, { onError, endDestination: false })
    source.write('one\n')
    await tick()
    destination.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    source.write('two\n')
    await tick()

    expect(Buffer.concat(chunks)).toEqual(Buffer.from('one\n'))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('relayed settles rather than hanging when a stream errors', async () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()

    const handle = splice(source, destination, () => undefined, {
      onError: () => undefined,
      endDestination: false,
    })
    source.destroy(new Error('read failed'))

    await expect(handle.relayed).resolves.toBeUndefined()
  })
})

describe('splice handle', () => {
  test('dispose removes exactly the listeners it added, restoring prior listener counts', () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()
    const before = snapshotListenerCounts(source, destination)

    const handle = splice(source, destination, () => undefined)
    expect(source.listenerCount('data')).toBe(before.sourceData + 1)

    handle.dispose()

    expect(snapshotListenerCounts(source, destination)).toEqual(before)
  })

  test('dispose leaves pre-existing listeners on the same streams untouched', () => {
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()
    const preExisting = (): void => undefined
    source.on('data', preExisting)
    destination.on('error', preExisting)

    const handle = splice(source, destination, () => undefined)
    handle.dispose()

    expect(source.listeners('data')).toContain(preExisting)
    expect(destination.listeners('error')).toContain(preExisting)
  })

  test('dispose stops forwarding and pauses the source it put into flowing mode', async () => {
    const source = new PassThrough()
    const { writable: destination, chunks } = createCapturingWritable()

    const handle = splice(source, destination, () => undefined)
    source.write('before\n')
    await tick()
    handle.dispose()
    source.write('after\n')
    await tick()

    expect(Buffer.concat(chunks)).toEqual(Buffer.from('before\n'))
    expect(source.isPaused()).toBe(true)
  })

  test('relayed resolves only after a slow destination has acknowledged every chunk', async () => {
    const source = new PassThrough()
    const acknowledged: Buffer[] = []
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setTimeout(() => {
          acknowledged.push(chunk)
          callback()
        }, SLOW_DESTINATION_DELAY_MS)
      },
    })

    const handle = splice(source, destination, () => undefined, { endDestination: false })
    const expected = ['a\n', 'b\n', 'c\n', 'd\n']
    for (const line of expected) {
      source.write(line)
    }
    source.end()

    await handle.relayed

    expect(Buffer.concat(acknowledged).toString('utf8')).toBe(expected.join(''))
  })

  test('relayed does not resolve while chunks are still unacknowledged', async () => {
    const source = new PassThrough()
    let releaseWrite: (() => void) | undefined
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        releaseWrite = () => callback()
      },
    })
    let isRelayed = false

    const handle = splice(source, destination, () => undefined, { endDestination: false })
    void handle.relayed.then(() => {
      isRelayed = true
    })

    source.write('pending\n')
    source.end()
    await tick()
    expect(isRelayed).toBe(false)

    releaseWrite?.()
    await handle.relayed
    expect(isRelayed).toBe(true)
  })
})
