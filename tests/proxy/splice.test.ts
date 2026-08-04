import { randomBytes } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { once } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { splice } from '../../src/proxy/splice.js'

interface CapturingWritable {
  writable: Writable
  chunks: Buffer[]
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
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('boom\nsurvivor\n'))
  })

  test('uses console.error as the default onError when the tap throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const source = new PassThrough()
    const { writable: destination } = createCapturingWritable()

    splice(source, destination, () => {
      throw new Error('tap failure')
    })

    source.write('line\n')
    source.end()
    await once(destination, 'finish')

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    consoleErrorSpy.mockRestore()
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
