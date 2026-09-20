import type { IncomingMessage } from 'node:http'
import { describe, expect, test } from 'vitest'
import type { AdminResolver, LoginRateLimiter, PenaltyGate } from '../../src/ui/auth.js'
import { resolveConsoleBearer } from '../../src/ui/console-auth.js'

/**
 * Security review of ADR-0014, H1: a Bearer token on the console API is the
 * SAME credential `/login` takes, so guessing it must cost what guessing it on
 * `/login` costs — including the global-ceiling delay a distributed flood pays.
 */

const PENALTY_MS = 750

function requestWith(token: string | undefined): IncomingMessage {
  return {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as IncomingMessage
}

function limiterOwing(penaltyMs: number): LoginRateLimiter {
  return {
    allow: () => true,
    recordFailure: () => undefined,
    recordSuccess: () => undefined,
    penaltyMs: () => penaltyMs,
  } as unknown as LoginRateLimiter
}

function storeLogging(events: string[]): AdminResolver {
  return {
    findAdminByToken: async () => {
      events.push('lookup')
      return undefined
    },
  } as unknown as AdminResolver
}

describe('console bearer auth under the global ceiling', () => {
  test('pays the global penalty BEFORE the token is looked up', async () => {
    const events: string[] = []

    const result = await resolveConsoleBearer(
      {
        adminStore: storeLogging(events),
        rateLimiter: limiterOwing(PENALTY_MS),
        stderr: { write: () => undefined },
        sleep: async (ms) => {
          events.push(`sleep:${ms}`)
        },
      },
      requestWith('mcpa_guess'),
    )

    expect(result.kind).toBe('unauthorized')
    expect(events).toEqual([`sleep:${PENALTY_MS}`, 'lookup'])
  })

  test('owes nothing under the ceiling, so an ordinary request never sleeps', async () => {
    const events: string[] = []

    await resolveConsoleBearer(
      {
        adminStore: storeLogging(events),
        rateLimiter: limiterOwing(0),
        stderr: { write: () => undefined },
        sleep: async (ms) => {
          events.push(`sleep:${ms}`)
        },
      },
      requestWith('mcpa_guess'),
    )

    expect(events).toEqual(['lookup'])
  })

  test('a full penalty gate skips the delay instead of holding another socket', async () => {
    const events: string[] = []
    const fullGate: PenaltyGate = { acquire: () => false, release: () => undefined }

    await resolveConsoleBearer(
      {
        adminStore: storeLogging(events),
        rateLimiter: limiterOwing(PENALTY_MS),
        stderr: { write: () => undefined },
        penaltyGate: fullGate,
        sleep: async (ms) => {
          events.push(`sleep:${ms}`)
        },
      },
      requestWith('mcpa_guess'),
    )

    expect(events).toEqual(['lookup'])
  })
})
