import { describe, expect, test } from 'vitest'
import {
  diffMembership,
  emptyRouteTable,
  routeOf,
  serversOf,
  withoutRoute,
  withRoute,
} from '../../src/pool/route-table.js'

/** Stand-in for whatever a child session turns out to be; the core is generic. */
interface Child {
  readonly id: string
}

const child = (id: string): Child => ({ id })

describe('route table', () => {
  test('starts empty', () => {
    const table = emptyRouteTable<Child>()

    expect(serversOf(table)).toEqual([])
    expect(routeOf(table, 'github')).toBeUndefined()
  })

  test('withRoute returns a new table and leaves the original alone', () => {
    const before = emptyRouteTable<Child>()

    const after = withRoute(before, 'github', child('a'))

    expect(routeOf(after, 'github')).toEqual({ id: 'a' })
    expect(routeOf(before, 'github')).toBeUndefined()
    expect(serversOf(before)).toEqual([])
  })

  test('withRoute replaces an existing route for the same server', () => {
    const table = withRoute(withRoute(emptyRouteTable<Child>(), 'fs', child('old')), 'fs', child('new'))

    expect(routeOf(table, 'fs')).toEqual({ id: 'new' })
    expect(serversOf(table)).toEqual(['fs'])
  })

  test('withoutRoute drops the route and leaves the original alone', () => {
    const before = withRoute(withRoute(emptyRouteTable<Child>(), 'fs', child('a')), 'gh', child('b'))

    const after = withoutRoute(before, 'fs')

    expect(serversOf(after)).toEqual(['gh'])
    expect(serversOf(before)).toEqual(['fs', 'gh'])
  })

  test('withoutRoute returns the SAME table when there was nothing to remove', () => {
    // Reference equality is the cheap "nothing changed" signal the pool watch
    // uses to avoid re-deriving state on every poll.
    const table = withRoute(emptyRouteTable<Child>(), 'fs', child('a'))

    expect(withoutRoute(table, 'absent')).toBe(table)
  })

  test('serversOf is sorted, so the caller never depends on insertion order', () => {
    const table = withRoute(
      withRoute(withRoute(emptyRouteTable<Child>(), 'zeta', child('z')), 'alpha', child('a')),
      'mid',
      child('m'),
    )

    expect(serversOf(table)).toEqual(['alpha', 'mid', 'zeta'])
  })

  test.each([
    ['constructor', 'constructor'],
    ['tostring', 'tostring'],
    ['valueof', 'valueof'],
  ])('a server named %s does not resolve through the prototype chain', (_label, server) => {
    // `[a-z0-9-]` lets `constructor` through as a registry name, and this
    // module is one JSON.parse away from untrusted data.
    const table = emptyRouteTable<Child>()

    expect(routeOf(table, server)).toBeUndefined()
  })

  test('a server named constructor still works as an ordinary route', () => {
    const table = withRoute(emptyRouteTable<Child>(), 'constructor', child('c'))

    expect(routeOf(table, 'constructor')).toEqual({ id: 'c' })
    expect(serversOf(table)).toEqual(['constructor'])
  })
})

describe('diffMembership', () => {
  test('names what to open and what to close', () => {
    expect(diffMembership(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] })
  })

  test('an unchanged pool diffs to nothing', () => {
    expect(diffMembership(['a', 'b'], ['b', 'a'])).toEqual({ added: [], removed: [] })
  })

  test('a fresh pool is all additions', () => {
    expect(diffMembership([], ['b', 'a'])).toEqual({ added: ['a', 'b'], removed: [] })
  })

  test('a revoked pool is all removals', () => {
    expect(diffMembership(['b', 'a'], [])).toEqual({ added: [], removed: ['a', 'b'] })
  })

  test('both halves come back sorted', () => {
    expect(diffMembership(['z', 'y'], ['q', 'p'])).toEqual({
      added: ['p', 'q'],
      removed: ['y', 'z'],
    })
  })

  test('does not reorder the caller’s arrays', () => {
    const current = ['z', 'a']
    const granted = ['q', 'b']

    diffMembership(current, granted)

    expect(current).toEqual(['z', 'a'])
    expect(granted).toEqual(['q', 'b'])
  })
})
