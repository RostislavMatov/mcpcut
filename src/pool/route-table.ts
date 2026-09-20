import { compareAsText } from '../agents/effective.js'

/**
 * The pool's server → child-session table, and the membership diff that keeps
 * it in step with the agent's effective grants.
 *
 * Generic in the child type on purpose: this core knows nothing about what a
 * child session is, or how one is opened and closed. Phase 3 supplies both.
 *
 * Every update returns a NEW table; nothing here mutates what it was handed.
 * Reads go through `Object.hasOwn`, because `constructor` is a legal registry
 * server name under `[a-z0-9][a-z0-9-]{0,63}` and this module sits one
 * `JSON.parse` away from untrusted data — the same discipline as
 * `agents/effective.ts`.
 */

export interface RouteTable<T> {
  readonly routes: Readonly<Record<string, T>>
}

export function emptyRouteTable<T>(): RouteTable<T> {
  return { routes: {} }
}

export function withRoute<T>(table: RouteTable<T>, server: string, child: T): RouteTable<T> {
  return { routes: { ...table.routes, [server]: child } }
}

/**
 * Removes one route. Returns the SAME table object when `server` held none, so
 * a caller can tell "nothing changed" by reference rather than by comparing
 * contents — the pool watch runs this on every poll.
 */
export function withoutRoute<T>(table: RouteTable<T>, server: string): RouteTable<T> {
  if (!Object.hasOwn(table.routes, server)) return table

  const routes = { ...table.routes }
  delete routes[server]
  return { routes }
}

export function routeOf<T>(table: RouteTable<T>, server: string): T | undefined {
  return Object.hasOwn(table.routes, server) ? table.routes[server] : undefined
}

/** The servers currently routed, sorted, so no caller depends on insert order. */
export function serversOf<T>(table: RouteTable<T>): readonly string[] {
  return Object.keys(table.routes).sort(compareAsText)
}

/** What the pool must open and what it must close to match the grants again. */
export interface PoolMembershipDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export function diffMembership(
  current: readonly string[],
  granted: readonly string[],
): PoolMembershipDiff {
  const currentSet = new Set(current)
  const grantedSet = new Set(granted)

  return {
    added: [...grantedSet].filter((server) => !currentSet.has(server)).sort(compareAsText),
    removed: [...currentSet].filter((server) => !grantedSet.has(server)).sort(compareAsText),
  }
}
