import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PoolChild } from '../../src/pool/children.js'
import { createPoolCorrelator } from '../../src/pool/correlator.js'
import { createPoolFanout } from '../../src/pool/fanout.js'

/**
 * Asking one upstream something in the plane's own name. Every failure is
 * `null`: a full table, a silent upstream, and one abandoned mid-start are all
 * "this server did not answer" (PE6).
 */

const DEFAULT_TIMEOUT_MS = 1000

function childNamed(server: string): PoolChild & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    server,
    sessionId: `session-${server}`,
    lines,
    sink: {
      write: (message) => {
        lines.push(message.bytes.toString('utf8'))
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    close: () => Promise.resolve(),
  }
}

function createHarness() {
  const correlator = createPoolCorrelator(100)
  const timeouts: Array<{ server: string; tag: string }> = []
  const fanout = createPoolFanout({
    correlator,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onTimeout: (server, tag) => timeouts.push({ server, tag }),
  })
  return { correlator, fanout, timeouts }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ask', () => {
  test('resolves with the settled reply', async () => {
    // Arrange
    const { fanout } = createHarness()
    const child = childNamed('alpha')

    // Act
    const answer = fanout.ask(child, 'tools/list', (id) => `{"id":"${id}"}`)
    await vi.advanceTimersByTimeAsync(0)
    const id = (JSON.parse(child.lines[0] as string) as { id: string }).id
    const settled = fanout.settle('alpha', id, 'reply')

    // Assert
    expect(settled).toBe(true)
    await expect(answer).resolves.toBe('reply')
  })

  test('honours a timeout of its own over the default', async () => {
    // Arrange
    const { fanout, timeouts } = createHarness()
    const child = childNamed('alpha')

    // Act
    const answer = fanout.ask(child, 'initialize', (id) => id, { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)

    // Assert
    await expect(answer).resolves.toBeNull()
    expect(timeouts).toEqual([{ server: 'alpha', tag: 'initialize' }])
  })

  test('uses the default when no timeout of its own is given', async () => {
    // Arrange
    const { fanout, timeouts } = createHarness()
    const answer = fanout.ask(childNamed('alpha'), 'tools/list', (id) => id)

    // Act
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
    const before = [...timeouts]
    await vi.advanceTimersByTimeAsync(2)

    // Assert
    expect(before).toEqual([])
    await expect(answer).resolves.toBeNull()
    expect(timeouts).toEqual([{ server: 'alpha', tag: 'tools/list' }])
  })
})

describe('abandon', () => {
  test('ends every wait of its own server at once, and no other', async () => {
    // Arrange
    const { fanout, timeouts } = createHarness()
    const alpha = childNamed('alpha')
    const beta = childNamed('beta')
    const first = fanout.ask(alpha, 'initialize', (id) => id)
    const second = fanout.ask(alpha, 'tools/list', (id) => id)
    const other = fanout.ask(beta, 'initialize', (id) => id)
    await vi.advanceTimersByTimeAsync(0)

    // Act
    fanout.abandon('alpha')

    // Assert
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(fanout.settle('beta', beta.lines[0] as string, 'reply')).toBe(true)
    await expect(other).resolves.toBe('reply')
    // An abandoned wait is not a timeout: the caller already knows why.
    expect(timeouts.filter((entry) => entry.server === 'alpha')).toEqual([])
  })

  test('a reply arriving after the abandon settles nothing', async () => {
    // Arrange
    const { fanout } = createHarness()
    const alpha = childNamed('alpha')
    const answer = fanout.ask(alpha, 'initialize', (id) => id)
    await vi.advanceTimersByTimeAsync(0)
    fanout.abandon('alpha')

    // Act
    const settled = fanout.settle('alpha', alpha.lines[0] as string, 'late')

    // Assert
    expect(settled).toBe(false)
    await expect(answer).resolves.toBeNull()
  })

  test('abandoning a server with nothing in flight is a no-op', () => {
    // Arrange
    const { fanout } = createHarness()

    // Act / Assert
    expect(() => fanout.abandon('nobody')).not.toThrow()
  })
})
