import { describe, expect, test } from 'vitest'
import { POOL_FANOUT_ID_PREFIX } from '../../src/pool/constants.js'
import { createPoolCorrelator } from '../../src/pool/correlator.js'

describe('createPoolCorrelator', () => {
  test('settles a client request against the server it was sent to', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'github')

    expect(correlator.settle('github', 1)).toEqual({ kind: 'client' })
  })

  test('forgets a settled request, so the id may be reused', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'github')
    correlator.settle('github', 1)

    expect(correlator.trackClient(1, 'fs')).toEqual({ ok: true })
    expect(correlator.settle('fs', 1)).toEqual({ kind: 'client' })
  })

  test('one server cannot answer another server’s in-flight id', () => {
    // PRD risk #1: B's reply must never leave as the answer to a call to A.
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')
    correlator.trackClient(2, 'B')

    expect(correlator.settle('B', 1)).toEqual({ kind: 'unexpected' })
    // …and A's own entry survived the attempt untouched.
    expect(correlator.settle('A', 1)).toEqual({ kind: 'client' })
    expect(correlator.settle('B', 2)).toEqual({ kind: 'client' })
  })

  test('an unknown id is unexpected, not a silent pass-through', () => {
    const correlator = createPoolCorrelator(10)

    expect(correlator.settle('github', 99)).toEqual({ kind: 'unexpected' })
  })

  test('a null id can belong to nothing and is unexpected', () => {
    const correlator = createPoolCorrelator(10)

    expect(correlator.settle('github', null)).toEqual({ kind: 'unexpected' })
  })

  test('numeric 1 and string "1" are different requests', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')
    correlator.trackClient('1', 'B')

    expect(correlator.settle('A', '1')).toEqual({ kind: 'unexpected' })
    expect(correlator.settle('B', '1')).toEqual({ kind: 'client' })
    expect(correlator.settle('A', 1)).toEqual({ kind: 'client' })
  })

  test('refuses a duplicate id that is still in flight', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')

    expect(correlator.trackClient(1, 'B')).toEqual({ ok: false, reason: 'duplicate-id' })
    // The original entry is the one that survives.
    expect(correlator.settle('A', 1)).toEqual({ kind: 'client' })
  })

  test('refuses a client id inside the plane’s own id namespace', () => {
    const correlator = createPoolCorrelator(10)

    expect(correlator.trackClient(`${POOL_FANOUT_ID_PREFIX}7`, 'A')).toEqual({
      ok: false,
      reason: 'reserved-id',
    })
    expect(correlator.pending).toBe(0)
  })

  test('refuses at capacity instead of evicting an in-flight request', () => {
    // Evicting would mean a reply with nowhere to go — "one outcome per id"
    // broken. Fail-closed: the caller answers the new request with an error.
    const correlator = createPoolCorrelator(2)
    correlator.trackClient(1, 'A')
    correlator.trackClient(2, 'A')

    expect(correlator.trackClient(3, 'A')).toEqual({ ok: false, reason: 'at-capacity' })
    expect(correlator.settle('A', 1)).toEqual({ kind: 'client' })
    expect(correlator.settle('A', 2)).toEqual({ kind: 'client' })
  })

  test('accepts again once a slot frees up', () => {
    const correlator = createPoolCorrelator(1)
    correlator.trackClient(1, 'A')
    correlator.settle('A', 1)

    expect(correlator.trackClient(2, 'A')).toEqual({ ok: true })
  })

  test('refuses a fan-out id at capacity, so fan-out cannot starve the agent', () => {
    // Fan-out shares the pending map with client requests, and an agent can
    // drive it: every `tools/list` it sends fans out to every pool member. An
    // uncapped fan-out would fill the map and make `trackClient` refuse every
    // real request while holding no client slot at all.
    const correlator = createPoolCorrelator(2)
    correlator.trackFanout('A', 'tools/list')
    correlator.trackFanout('B', 'tools/list')

    expect(correlator.trackFanout('C', 'tools/list')).toBeNull()
    expect(correlator.pending).toBe(2)
  })

  test('a client request still fits while fan-out is below the cap', () => {
    const correlator = createPoolCorrelator(2)
    correlator.trackFanout('A', 'tools/list')

    expect(correlator.trackClient(1, 'A')).toEqual({ ok: true })
    expect(correlator.trackClient(2, 'A')).toEqual({ ok: false, reason: 'at-capacity' })
  })

  test('mints fan-out ids in a namespace of its own, never colliding', () => {
    const correlator = createPoolCorrelator(10)

    const first = correlator.trackFanout('A', 'tools/list')!
    const second = correlator.trackFanout('B', 'tools/list')!

    expect(first.startsWith(POOL_FANOUT_ID_PREFIX)).toBe(true)
    expect(second).not.toBe(first)
  })

  test('a fan-out answer settles as the plane’s own, never as the client’s', () => {
    const correlator = createPoolCorrelator(10)
    const id = correlator.trackFanout('A', 'tools/list')!

    expect(correlator.settle('A', id)).toEqual({ kind: 'fanout', tag: 'tools/list' })
  })

  test('a fan-out id answered by the wrong server is unexpected too', () => {
    const correlator = createPoolCorrelator(10)
    const id = correlator.trackFanout('A', 'initialize')!

    expect(correlator.settle('B', id)).toEqual({ kind: 'unexpected' })
    expect(correlator.settle('A', id)).toEqual({ kind: 'fanout', tag: 'initialize' })
  })

  test('serverOf names the child holding an in-flight client id', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'github')

    expect(correlator.serverOf(1)).toBe('github')
    correlator.settle('github', 1)
    expect(correlator.serverOf(1)).toBeUndefined()
  })

  test('dropServer returns the client ids that now need a synthesized error', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')
    correlator.trackClient(2, 'B')
    correlator.trackFanout('A', 'tools/list')

    const orphaned = correlator.dropServer('A')

    // The plane's own fan-out id is not an orphan: nobody is waiting on it.
    expect(orphaned).toEqual([1])
    expect(correlator.settle('B', 2)).toEqual({ kind: 'client' })
  })

  test('dropServer forgets everything of that server, pending included', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')
    correlator.trackFanout('A', 'tools/list')
    correlator.trackClient(2, 'B')
    expect(correlator.pending).toBe(3)

    correlator.dropServer('A')

    expect(correlator.pending).toBe(1)
    expect(correlator.serverOf(1)).toBeUndefined()
  })

  test('dropping a server with nothing in flight is not an error', () => {
    const correlator = createPoolCorrelator(10)

    expect(correlator.dropServer('absent')).toEqual([])
  })

  test('counts both client and fan-out requests against the cap', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'A')
    correlator.trackFanout('A', 'tools/list')

    expect(correlator.pending).toBe(2)
  })
})

/**
 * ADR-0015 phase 5 (N2): the progress token an agent put on a request belongs
 * to that request's entry, and leaves with it -- on the reply, on a dropped
 * server, and nowhere else. One owner of the request's lifecycle, so a token
 * cannot outlive its call on some path nobody remembered (the lesson of the
 * phase-3 CRITICAL).
 */
describe('createPoolCorrelator: progress tokens (N2)', () => {
  test('binds a token to the server its request was sent to', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 'p-1')

    expect(correlator.progressServerOf('p-1')).toBe('alpha')
  })

  test('knows no server for a token nobody gave', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha')

    expect(correlator.progressServerOf('p-1')).toBeUndefined()
  })

  test('releases the token once its request is answered', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 'p-1')

    correlator.settle('alpha', 1)

    expect(correlator.progressServerOf('p-1')).toBeUndefined()
  })

  test('keeps the token when another server answers the id', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 'p-1')

    expect(correlator.settle('beta', 1)).toEqual({ kind: 'unexpected' })

    expect(correlator.progressServerOf('p-1')).toBe('alpha')
  })

  test('releases the token when its server is dropped', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 'p-1')
    correlator.trackClient(2, 'beta', 'p-2')

    correlator.dropServer('alpha')

    expect(correlator.progressServerOf('p-1')).toBeUndefined()
    expect(correlator.progressServerOf('p-2')).toBe('beta')
  })

  test('first wins: a token reused while its first request lives binds nothing new', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 'shared')

    expect(correlator.trackClient(2, 'beta', 'shared')).toEqual({ ok: true })
    expect(correlator.progressServerOf('shared')).toBe('alpha')

    // The second request's reply must not release the first one's token...
    correlator.settle('beta', 2)
    expect(correlator.progressServerOf('shared')).toBe('alpha')
    // ...and the first one's reply frees it for a later request.
    correlator.settle('alpha', 1)
    expect(correlator.progressServerOf('shared')).toBeUndefined()
    correlator.trackClient(3, 'beta', 'shared')
    expect(correlator.progressServerOf('shared')).toBe('beta')
  })

  test('tells numeric 1 and string "1" apart as tokens', () => {
    const correlator = createPoolCorrelator(10)
    correlator.trackClient(1, 'alpha', 1)
    correlator.trackClient(2, 'beta', '1')

    expect(correlator.progressServerOf(1)).toBe('alpha')
    expect(correlator.progressServerOf('1')).toBe('beta')
  })

  test('binds nothing for a request it refused', () => {
    const correlator = createPoolCorrelator(1)
    correlator.trackClient(1, 'alpha')

    expect(correlator.trackClient(2, 'beta', 'p-2')).toEqual({ ok: false, reason: 'at-capacity' })
    expect(correlator.trackClient(1, 'beta', 'p-3')).toEqual({ ok: false, reason: 'duplicate-id' })
    expect(correlator.progressServerOf('p-2')).toBeUndefined()
    expect(correlator.progressServerOf('p-3')).toBeUndefined()
  })

  test('a fan-out id never owns a token, even one spelled like it', () => {
    const correlator = createPoolCorrelator(10)
    const fanoutId = correlator.trackFanout('alpha', 'tools')

    expect(fanoutId).not.toBeNull()
    expect(correlator.progressServerOf(fanoutId ?? '')).toBeUndefined()
  })
})
