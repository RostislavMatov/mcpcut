import { POOL_ROUTE_PATH, ROUTE_NAME_PATTERN } from './server-constants.js'

/**
 * Route parsing for the downstream HTTP front. Pure functions over
 * method/URL strings — no routing framework (three routes do not justify
 * one; plan decision) and no request semantics.
 *
 * Origin screening moved to the shared `src/net/origin-host.ts` (M4 Task 1,
 * so the admin UI reuses the same defense without importing transport);
 * the re-export below keeps this module's public API unchanged.
 *
 * Two route shapes, with method POST | GET | DELETE on both:
 *
 *  - `/agents/:agent/servers/:server` — one agent at one server (M3). Path
 *    segment names are validated against the shared registry/agent name
 *    pattern.
 *  - `POOL_ROUTE_PATH` — the agent pool (ADR-0015 phase 3). It carries NO
 *    agent name: the bearer token names the agent (PE5), and the operator is
 *    handed a base address whose path is an internal detail.
 *
 * Anything else is "no route" — the server answers 404 (only AFTER
 * authentication, so an unauthenticated caller can never scan the name
 * space, nor learn whether this installation serves a pool; see `server.ts`).
 *
 * The result is a discriminated union rather than an optional agent name, so
 * `server.ts` cannot compare a path's agent against the token's on a route
 * that has no such segment — the compiler refuses it.
 */

/** Methods the MCP endpoint serves (spec matrix §1.2/§1.3/§1.5). */
export type RouteMethod = 'POST' | 'GET' | 'DELETE'

/** A successfully parsed request line: one of the two shapes above. */
export type RouteMatch =
  | {
      readonly kind: 'server'
      readonly method: RouteMethod
      readonly agentName: string
      readonly serverName: string
    }
  | { readonly kind: 'pool'; readonly method: RouteMethod }

const ROUTE_METHODS: ReadonlySet<string> = new Set<RouteMethod>(['POST', 'GET', 'DELETE'])

/** Expected segments of the pathname split on '/': ['', 'agents', a, 'servers', s]. */
const ROUTE_SEGMENT_COUNT = 5

/**
 * Parses one request line into a route, or `null` when nothing matches
 * (unknown path shape, invalid names, unsupported method, trailing slash).
 * The query string is ignored; the path is not URL-decoded — encoded names
 * simply fail the pattern, which is the strict behavior we want.
 */
export function parseRoute(method: string | undefined, url: string | undefined): RouteMatch | null {
  if (method === undefined || url === undefined || !ROUTE_METHODS.has(method)) {
    return null
  }
  const queryStart = url.indexOf('?')
  const path = queryStart === -1 ? url : url.slice(0, queryStart)
  if (path === POOL_ROUTE_PATH) {
    return Object.freeze({ kind: 'pool' as const, method: method as RouteMethod })
  }
  const segments = path.split('/')
  if (segments.length !== ROUTE_SEGMENT_COUNT) {
    return null
  }
  const [head, agentsLiteral, agentName, serversLiteral, serverName] = segments
  if (head !== '' || agentsLiteral !== 'agents' || serversLiteral !== 'servers') {
    return null
  }
  if (!ROUTE_NAME_PATTERN.test(agentName ?? '') || !ROUTE_NAME_PATTERN.test(serverName ?? '')) {
    return null
  }
  return Object.freeze({
    kind: 'server' as const,
    method: method as RouteMethod,
    agentName: agentName as string,
    serverName: serverName as string,
  })
}

export { isOriginAllowed } from '../../net/origin-host.js'
