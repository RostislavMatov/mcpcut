import { createServer } from 'node:http'
import { describe, expect, test } from 'vitest'
import { applyConnectionTimeouts, readConnectionTimeouts } from '../../src/net/connection-timeouts.js'

describe('connection timeouts shared by both HTTP fronts', () => {
  test('applies all three timers and reads them back from the live server', () => {
    // Arrange
    const server = createServer()
    const timeouts = { headersTimeoutMs: 1_000, requestTimeoutMs: 2_000, keepAliveTimeoutMs: 500 }

    // Act
    applyConnectionTimeouts(server, timeouts)

    // Assert
    expect(readConnectionTimeouts(server)).toEqual(timeouts)
    server.close()
  })

  test('refuses a headersTimeout above requestTimeout at startup, leaving the server untouched', () => {
    const server = createServer()
    const before = readConnectionTimeouts(server)

    expect(() =>
      applyConnectionTimeouts(server, { headersTimeoutMs: 3_000, requestTimeoutMs: 2_000, keepAliveTimeoutMs: 500 }),
    ).toThrow(RangeError)

    expect(readConnectionTimeouts(server)).toEqual(before)
    server.close()
  })

  test('an equal pair is allowed', () => {
    const server = createServer()

    applyConnectionTimeouts(server, { headersTimeoutMs: 2_000, requestTimeoutMs: 2_000, keepAliveTimeoutMs: 500 })

    expect(readConnectionTimeouts(server).headersTimeoutMs).toBe(2_000)
    server.close()
  })
})
