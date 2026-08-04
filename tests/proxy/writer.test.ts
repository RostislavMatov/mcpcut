import { Writable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createOrderedWriter } from '../../src/proxy/writer.js'

/** Lets pending stream events and microtasks settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface CapturingWritable {
  writable: Writable
  chunks: Buffer[]
}

/** A Writable that records every chunk it receives and accepts immediately. */
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

describe('createOrderedWriter', () => {
  test('writeMessage resolves once the destination accepts the message', async () => {
    const { writable, chunks } = createCapturingWritable()
    const writer = createOrderedWriter(writable)

    await writer.writeMessage(Buffer.from('hello\n'))

    expect(chunks).toEqual([Buffer.from('hello\n')])
  })

  test('serializes concurrent writeMessage calls: messages land whole, in call order, never interleaved', async () => {
    const received: Buffer[] = []
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk)
        // Slow, out-of-band completion: if writes were not serialized, a
        // second burst issued before this settles could land out of order
        // or split the destination's view of a message.
        setTimeout(() => callback(), 1)
      },
    })
    const writer = createOrderedWriter(destination)

    const burstA = [Buffer.from('a1\n'), Buffer.from('a2\n')]
    const burstB = [Buffer.from('b1\n'), Buffer.from('b2\n')]
    const callOrder = [burstA[0], burstB[0], burstA[1], burstB[1]] as Buffer[]

    const results = callOrder.map((message) => writer.writeMessage(message))
    await Promise.all(results)

    expect(received).toEqual(callOrder)
  })

  test('awaits drain before resolving when destination.write signals backpressure', async () => {
    const received: Buffer[] = []
    let releaseWrite: (() => void) | undefined
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk)
        releaseWrite = () => callback()
      },
    })
    const writer = createOrderedWriter(destination)

    let isResolved = false
    void writer.writeMessage(Buffer.alloc(64, 'x')).then(() => {
      isResolved = true
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(isResolved).toBe(false)

    releaseWrite?.()
    await tick()

    expect(isResolved).toBe(true)
  })

  test('dispose makes a queued write resolve as a no-op instead of reaching the destination', async () => {
    const received: Buffer[] = []
    let releaseWrite: (() => void) | undefined
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk)
        releaseWrite = () => callback()
      },
    })
    const writer = createOrderedWriter(destination)

    const first = writer.writeMessage(Buffer.from('first\n'))
    await tick()
    // Queued behind `first` in the internal chain; not yet dispatched to the
    // destination because `first` is still awaiting drain.
    const second = writer.writeMessage(Buffer.from('second\n'))

    writer.dispose()
    releaseWrite?.()
    await Promise.all([first, second])

    expect(received).toEqual([Buffer.from('first\n')])
  })

  test('a writeMessage call issued after dispose resolves immediately without writing', async () => {
    const { writable, chunks } = createCapturingWritable()
    const writer = createOrderedWriter(writable)

    writer.dispose()
    await expect(writer.writeMessage(Buffer.from('too late\n'))).resolves.toBeUndefined()

    expect(chunks).toEqual([])
  })

  test('routes a destination error to onError instead of letting it go uncaught', async () => {
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      },
    })
    const onError = vi.fn()
    const writer = createOrderedWriter(destination, { onError })

    await writer.writeMessage(Buffer.from('payload\n'))
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as NodeJS.ErrnoException).code).toBe('EPIPE')
  })

  test('the default onError stringifies a non-Error destination error', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        // @ts-expect-error -- exercising a destination that violates the
        // Error-typed error-first callback convention.
        callback('destination said no')
      },
    })
    const writer = createOrderedWriter(destination)

    await writer.writeMessage(Buffer.from('x\n'))
    await tick()

    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('destination said no')
    stderrSpy.mockRestore()
  })

  test('writes to process.stderr as the default onError when no onError is given', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(new Error('destination exploded'))
      },
    })
    const writer = createOrderedWriter(destination)

    await writer.writeMessage(Buffer.from('x\n'))
    await tick()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('destination exploded')
    stderrSpy.mockRestore()
  })

  test('dispose removes exactly the error listener it added, leaving pre-existing ones untouched', () => {
    const { writable } = createCapturingWritable()
    const preExisting = (): void => undefined
    writable.on('error', preExisting)
    const before = writable.listenerCount('error')

    const writer = createOrderedWriter(writable)
    expect(writable.listenerCount('error')).toBe(before + 1)

    writer.dispose()

    expect(writable.listenerCount('error')).toBe(before)
    expect(writable.listeners('error')).toContain(preExisting)
  })

  test('dispose is idempotent', () => {
    const { writable } = createCapturingWritable()
    const writer = createOrderedWriter(writable)

    expect(() => {
      writer.dispose()
      writer.dispose()
    }).not.toThrow()
  })

  test('dispose() resolves a write parked on backpressure so its caller never hangs (TS-L3)', async () => {
    // A destination that accepts nothing: _write never completes and it never
    // drains, so the write parks on 'drain'/'error'/'close' indefinitely.
    const destination = new Writable({
      highWaterMark: 1,
      write() {
        // Intentionally never call the callback and never emit 'drain'.
      },
    })
    const writer = createOrderedWriter(destination)

    let resolved = false
    const pending = writer.writeMessage(Buffer.from('parked\n')).then(() => {
      resolved = true
    })
    await tick()
    expect(resolved).toBe(false) // genuinely parked on backpressure

    writer.dispose()
    await pending

    expect(resolved).toBe(true)
  })
})
