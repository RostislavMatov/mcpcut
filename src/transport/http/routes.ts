import { LOCALHOST_HOSTNAMES, ROUTE_NAME_PATTERN } from './server-constants.js'

/**
 * Route parsing and Origin screening for the downstream HTTP front. Pure
 * functions over method/URL/header strings — no routing framework (three
 * routes do not justify one; plan decision) and no request semantics.
 *
 * The single route shape is `/agents/:agent/servers/:server` with method
 * POST | GET | DELETE. Path segment names are validated against the shared
 * registry/agent name pattern; anything else is "no route" — the server
 * answers 404 (only AFTER authentication, so an unauthenticated caller can
 * never scan the name space; see `server.ts`).
 */

/** Methods the MCP endpoint serves (spec matrix §1.2/§1.3/§1.5). */
export type RouteMethod = 'POST' | 'GET' | 'DELETE'

/** A successfully parsed `/agents/:agent/servers/:server` request. */
export interface RouteMatch {
  readonly method: RouteMethod
  readonly agentName: string
  readonly serverName: string
}

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
    method: method as RouteMethod,
    agentName: agentName as string,
    serverName: serverName as string,
  })
}

/**
 * Origin screening (spec MUST in both revisions; matrix §4.2). Absent header
 * → allowed (non-browser agents don't send Origin). Present → must be a
 * localhost origin (`http(s)://localhost|127.0.0.1|[::1]`, any port) or an
 * exact match in `extraAllowed`; anything else the server rejects with 403
 * before doing anything else. `'null'` (opaque origin) is NOT allowed.
 */
export function isOriginAllowed(
  originHeader: string | undefined,
  extraAllowed: readonly string[],
): boolean {
  if (originHeader === undefined) {
    return true
  }
  if (extraAllowed.includes(originHeader)) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(originHeader)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  return LOCALHOST_HOSTNAMES.includes(parsed.hostname)
}
