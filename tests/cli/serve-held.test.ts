import { describe, expect, test } from 'vitest'
import type { OpenedChildSession } from '../../src/cli/serve-child.js'
import { createHeldSession, type HeldSessionHooks } from '../../src/cli/serve-held.js'
import { createMemoryPipe } from '../../src/cli/serve-pipe.js'
import type { SessionEndReason } from '../../src/session/core.js'
import { clientMessage, serverMessage } from '../../src/transport/message.js'

/**
 * A held session over the REAL memory pipe (RS5): the session keeps living,
 * attachments come and go, and a released attachment can neither reach the
 * session nor hear from it.
 */

interface Harness {
  readonly held: ReturnType<typeof createHeldSession>
  /** What reached the session (the server side of the pipe). */
  readonly reachedSession: string[]
  /** The session speaks toward whoever is attached. */
  emit(text: string): void
  /** The session ends on its own terms. */
  end(reason: SessionEndReason): void
  readonly released: boolean[]
  readonly ended: Array<{ reason: SessionEndReason | null; wasAttached: boolean }>
  readonly closes: number[]
}

function createHarness(): Harness {
  const pipe = createMemoryPipe()
  const reachedSession: string[] = []
  pipe.session.source.onMessage((message) => reachedSession.push(message.bytes.toString('utf8')))
  let endReason: SessionEndReason | null = null
  const closes: number[] = []
  const opened: OpenedChildSession = {
    sessionId: 'held-1',
    sink: pipe.front.sink,
    source: pipe.front.source,
    close: () => {
      closes.push(1)
      return Promise.resolve()
    },
    endReason: () => endReason,
  }
  const released: boolean[] = []
  const ended: Harness['ended'] = []
  const hooks: HeldSessionHooks = {
    onReleased: (dirty) => {
      released.push(dirty)
      return Promise.resolve()
    },
    onEnded: (reason, wasAttached) => ended.push({ reason, wasAttached }),
  }
  const held = createHeldSession(
    opened,
    { server: 'memory', discipline: { model: 'sessionful', protocolVersion: '2025-11-25' } },
    hooks,
  )
  return {
    held,
    reachedSession,
    emit: (text) => void pipe.session.sink.write(serverMessage(Buffer.from(text, 'utf8'))),
    end: (reason) => {
      endReason = reason
      pipe.endFrontSource()
    },
    released,
    ended,
    closes,
  }
}

function frame(text: string) {
  return clientMessage(Buffer.from(text, 'utf8'))
}

describe('an attachment', () => {
  test('carries its writes to the session and hears the session’s frames', async () => {
    // Arrange
    const harness = createHarness()
    const attachment = harness.held.attach()
    const heard: string[] = []
    attachment?.source.onMessage((message) => heard.push(message.bytes.toString('utf8')))

    // Act
    await attachment?.child.sink.write(frame('{"id":1}'))
    harness.emit('{"id":1,"result":{}}')

    // Assert
    expect(harness.reachedSession).toEqual(['{"id":1}'])
    expect(heard).toEqual(['{"id":1,"result":{}}'])
    expect(attachment?.child.sessionId).toBe('held-1')
    expect(attachment?.child.server).toBe('memory')
  })

  test('is the only one: a second attach while it holds the session is refused', () => {
    const harness = createHarness()
    harness.held.attach()

    expect(harness.held.attach()).toBeNull()
    expect(harness.held.isAttached).toBe(true)
  })

  test('a clean release tells the supervisor, and the session can be attached again', async () => {
    // Arrange
    const harness = createHarness()
    const first = harness.held.attach()

    // Act
    await first?.child.close()
    const second = harness.held.attach()

    // Assert
    expect(harness.released).toEqual([false])
    expect(second).not.toBeNull()
    expect(second?.child).not.toBe(first?.child)
  })

  test('a dirty release says so', async () => {
    const harness = createHarness()

    await harness.held.attach()?.child.close({ dirty: true })

    expect(harness.released).toEqual([true])
  })

  test('releasing twice tells the supervisor once', async () => {
    const harness = createHarness()
    const attachment = harness.held.attach()

    await attachment?.child.close()
    await attachment?.child.close({ dirty: true })

    expect(harness.released).toEqual([false])
  })
})

describe('a released attachment (the epoch lock)', () => {
  test('cannot reach the session through its old sink, even once another is attached', async () => {
    // The lock alone: without it, a cancellation or a retried call from a
    // closed pool session would EXECUTE on the server under the new one.
    const harness = createHarness()
    const old = harness.held.attach()
    await old?.child.close()
    const next = harness.held.attach()

    // Act
    await old?.child.sink.write(frame('{"id":"stale"}'))
    await next?.child.sink.write(frame('{"id":"fresh"}'))

    // Assert
    expect(harness.reachedSession).toEqual(['{"id":"fresh"}'])
  })

  test('never hears the session again', async () => {
    const harness = createHarness()
    const old = harness.held.attach()
    const heardByOld: string[] = []
    old?.source.onMessage((message) => heardByOld.push(message.bytes.toString('utf8')))
    await old?.child.close()
    const next = harness.held.attach()
    const heardByNext: string[] = []
    next?.source.onMessage((message) => heardByNext.push(message.bytes.toString('utf8')))

    // Act
    harness.emit('{"id":7,"result":{}}')

    // Assert
    expect(heardByOld).toEqual([])
    expect(heardByNext).toEqual(['{"id":7,"result":{}}'])
  })

  test('with nobody attached, a frame from the session goes nowhere', () => {
    const harness = createHarness()

    expect(() => harness.emit('{"method":"notifications/tools/list_changed"}')).not.toThrow()
  })
})

describe('the end of the session', () => {
  test('mid-attachment: the attachment hears it, the supervisor hears it once', async () => {
    // Arrange
    const harness = createHarness()
    const attachment = harness.held.attach()
    let attachmentEnded = 0
    attachment?.source.onEnd(() => {
      attachmentEnded += 1
    })

    // Act
    harness.end('revoked')
    await attachment?.child.close()

    // Assert
    expect(attachmentEnded).toBe(1)
    expect(harness.ended).toEqual([{ reason: 'revoked', wasAttached: true }])
    // The close after the end is not a release: the end already said it all.
    expect(harness.released).toEqual([])
    expect(attachment?.departureReason()).toBe('ungranted')
  })

  test('with nobody attached: the supervisor hears it, and nobody can attach', () => {
    const harness = createHarness()

    harness.end('server-ended')

    expect(harness.ended).toEqual([{ reason: 'server-ended', wasAttached: false }])
    expect(harness.held.attach()).toBeNull()
    expect(harness.held.hasEnded).toBe(true)
  })

  test('a listener wired after the end is told at once', () => {
    const harness = createHarness()
    const attachment = harness.held.attach()
    harness.end('server-ended')
    let told = false

    attachment?.source.onEnd(() => {
      told = true
    })

    expect(told).toBe(true)
    expect(attachment?.departureReason()).toBeUndefined()
  })

  test('close closes the session itself', async () => {
    const harness = createHarness()

    await harness.held.close()

    expect(harness.closes).toEqual([1])
  })
})
