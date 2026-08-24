import { APPROVAL_RESOLVE_MIN_ROLE, roleSatisfies, type Role } from '../admin/authz.js'

/**
 * Deny-by-default authorization for the admin UI (ADR-0004, Decision 4).
 *
 * `ROUTE_TABLE` is the single, normative registry of every route the UI
 * serves, each pinned to a minimum role (or `'public'`). It is the source of
 * truth for BOTH authorization (this module) and dispatch (`routes.ts` binds a
 * handler to each entry). A request that matches no entry is refused — a new
 * route is unreachable until it is listed here with a role, so a forgotten
 * check is structurally impossible, not merely discouraged. The matrix test
 * (`tests/ui/ui-hardening.test.ts`) enumerates this table against every role.
 */

/**
 * The role vocabulary and its privilege ordering now live in
 * `src/admin/authz.ts` — the CLI enforces the same thresholds and must not
 * carry a second copy of the ordering. Re-exported here so the UI's own
 * surface is unchanged.
 */
export { ROLE_RANK, roleSatisfies, type Role } from '../admin/authz.js'

/** HTTP methods the UI routes cover. */
export type UiMethod = 'GET' | 'POST'

/** One row of the route registry: method × path pattern × min role × handler key. */
export interface RouteEntry {
  readonly method: UiMethod
  /** Path pattern: literal segments, `:name` params, or a trailing `*` wildcard segment. */
  readonly pattern: string
  /** Minimum role, or `'public'` for the unauthenticated surface (`/login`, assets). */
  readonly minRole: Role | 'public'
  /** Key into the handler map (`routes.ts`); `@`-prefixed keys are served by the server core. */
  readonly handler: string
}

/**
 * The normative route table. Ordering is not significant for authorization
 * (patterns are disjoint) but `matchRoute` returns the first match, so keep
 * the most specific patterns above any wildcard sharing a prefix.
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // --- Public surface (no session; `/login` is additionally rate-limited) ---
  { method: 'GET', pattern: '/login', minRole: 'public', handler: 'loginPage' },
  { method: 'POST', pattern: '/login', minRole: 'public', handler: '@login' },
  { method: 'GET', pattern: '/assets/*', minRole: 'public', handler: 'assets' },
  // A browser probes this one unprompted; without a route, deny-by-default put
  // a 403 in the console of every page (manual M4 smoke).
  { method: 'GET', pattern: '/favicon.ico', minRole: 'public', handler: 'assets' },

  // --- viewer: read-only pages, the approvals feed, the SSE stream ---
  { method: 'POST', pattern: '/logout', minRole: 'viewer', handler: '@logout' },
  { method: 'GET', pattern: '/', minRole: 'viewer', handler: 'approvalsPage' },
  { method: 'GET', pattern: '/quarantine', minRole: 'viewer', handler: 'quarantinePage' },
  { method: 'GET', pattern: '/servers', minRole: 'viewer', handler: 'serversPage' },
  { method: 'GET', pattern: '/agents', minRole: 'viewer', handler: 'agentsPage' },
  { method: 'GET', pattern: '/journal', minRole: 'viewer', handler: 'journalPage' },
  { method: 'GET', pattern: '/api/approvals', minRole: 'viewer', handler: 'approvalsApi' },
  { method: 'GET', pattern: '/events', minRole: 'viewer', handler: 'events' },

  // --- operator: approvals, quarantine, agent grant matrix ---
  // The threshold is shared with `mcp-journal approvals approve|deny`: one
  // constant, so the CLI can never become a way around this row.
  { method: 'POST', pattern: '/approvals/:id/approve', minRole: APPROVAL_RESOLVE_MIN_ROLE, handler: 'approvalsApprove' },
  { method: 'POST', pattern: '/approvals/:id/deny', minRole: APPROVAL_RESOLVE_MIN_ROLE, handler: 'approvalsDeny' },
  { method: 'POST', pattern: '/quarantine/approve', minRole: 'operator', handler: 'quarantineApprove' },
  { method: 'POST', pattern: '/quarantine/reject', minRole: 'operator', handler: 'quarantineReject' },
  { method: 'POST', pattern: '/agents/create', minRole: 'operator', handler: 'agentsCreate' },
  { method: 'POST', pattern: '/agents/grant', minRole: 'operator', handler: 'agentsGrant' },
  { method: 'POST', pattern: '/agents/ungrant', minRole: 'operator', handler: 'agentsUngrant' },
  { method: 'POST', pattern: '/agents/revoke', minRole: 'operator', handler: 'agentsRevoke' },

  // --- owner: servers, vault (names only), admin management ---
  { method: 'GET', pattern: '/vault', minRole: 'owner', handler: 'vaultPage' },
  { method: 'POST', pattern: '/servers/add', minRole: 'owner', handler: 'serversAdd' },
  { method: 'POST', pattern: '/servers/edit', minRole: 'owner', handler: 'serversEdit' },
  { method: 'POST', pattern: '/servers/remove', minRole: 'owner', handler: 'serversRemove' },
  { method: 'GET', pattern: '/admins', minRole: 'owner', handler: 'adminsPage' },
  { method: 'POST', pattern: '/admins/add', minRole: 'owner', handler: 'adminsAdd' },
  { method: 'POST', pattern: '/admins/remove', minRole: 'owner', handler: 'adminsRemove' },
  { method: 'POST', pattern: '/admins/rotate', minRole: 'owner', handler: 'adminsRotate' },
  { method: 'POST', pattern: '/admins/role', minRole: 'owner', handler: 'adminsRole' },
]

/** A matched route plus any captured path parameters. */
export interface RouteMatch {
  readonly entry: RouteEntry
  readonly params: Readonly<Record<string, string>>
}

/**
 * Matches one method+path against `ROUTE_TABLE`, returning the entry and any
 * captured `:params`, or `null` when nothing matches (→ the server answers a
 * uniform 403: an unlisted route is denied to everyone, no existence oracle).
 * The path must already be split from its query string and must not be URL
 * decoded here — encoded segments simply fail the literal comparison.
 */
export function matchRoute(method: string, path: string): RouteMatch | null {
  if (method !== 'GET' && method !== 'POST') return null
  const pathSegments = splitPath(path)
  for (const entry of ROUTE_TABLE) {
    if (entry.method !== method) continue
    const params = matchPattern(entry.pattern, pathSegments)
    if (params !== null) return { entry, params }
  }
  return null
}

/** Splits a path into segments, dropping the leading empty one (`'/a/b'` → `['a','b']`). */
function splitPath(path: string): readonly string[] {
  const trimmed = path.startsWith('/') ? path.slice(1) : path
  return trimmed === '' ? [] : trimmed.split('/')
}

/**
 * Tries one pattern against already-split path segments. Returns captured
 * params on success, `null` on mismatch. A trailing `*` segment matches one or
 * more remaining segments (used only for `/assets/*`); a `:name` segment
 * captures exactly one non-empty segment.
 */
function matchPattern(
  pattern: string,
  pathSegments: readonly string[],
): Record<string, string> | null {
  const patternSegments = splitPath(pattern)
  const params: Record<string, string> = {}
  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i] as string
    if (patternSegment === '*') {
      // Wildcard (only `/assets/*`): at least one remaining segment, none of
      // them empty and none a `..` traversal token. Rejecting `..` here is
      // fail-closed — the Wave-3 asset handler can never receive a rest that
      // climbs out of the asset root, even if written naively.
      const rest = pathSegments.slice(i)
      if (rest.length === 0 || rest.some((segment) => segment === '' || segment === '..')) {
        return null
      }
      params.rest = rest.join('/')
      return params
    }
    const pathSegment = pathSegments[i]
    if (pathSegment === undefined) return null
    if (patternSegment.startsWith(':')) {
      if (pathSegment === '') return null
      params[patternSegment.slice(1)] = pathSegment
      continue
    }
    if (patternSegment !== pathSegment) return null
  }
  // Every pattern segment consumed; the path must be fully consumed too.
  return pathSegments.length === patternSegments.length ? params : null
}

/** The minimal session shape authorization inspects. */
export interface AuthorizableSession {
  readonly role: Role
}

/** The verdict for one request against one matched route. */
export type AuthzDecision =
  | { readonly kind: 'public' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' }

/**
 * Decides whether a session (or none) may reach a matched route. Deny by
 * default: `public` routes need no session; every other route needs a session
 * whose role meets `minRole`, else `unauthenticated` (no session) or
 * `forbidden` (insufficient role).
 */
export function authorize(
  entry: RouteEntry,
  session: AuthorizableSession | undefined,
): AuthzDecision {
  if (entry.minRole === 'public') return { kind: 'public' }
  if (session === undefined) return { kind: 'unauthenticated' }
  if (!roleSatisfies(session.role, entry.minRole)) return { kind: 'forbidden' }
  return { kind: 'allow' }
}
