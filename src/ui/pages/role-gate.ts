import { ROLE_RANK, roleSatisfies, type Role } from '../authz.js'
import type { CurrentAdmin } from './layout.js'

/**
 * "May this session use the control I am about to draw?" — for the two pages
 * whose mutating forms sit inside a live region and therefore cannot be tucked
 * into a role-gated drawer the way `/agents` and `/groups` do it.
 *
 * A form the route answers with a 403 is worse than no form (user-journey smoke
 * 2026-09-18, UX-5): a `viewer` pressed APPROVE and got a bare refusal, on the
 * only two pages that still offered it. The THRESHOLD always comes from the
 * same constant `ROUTE_TABLE` pins the POST route to, so a page cannot drift
 * from its check: hiding a control is ergonomics, the table is the enforcement.
 *
 * `CurrentAdmin.role` is a plain string (the nav only ever prints it), so an
 * unrecognized value — and a page rendered with no session at all — answers
 * "no": fail closed in the display too.
 */
export function roleAllows(admin: CurrentAdmin | undefined, minRole: Role): boolean {
  if (admin === undefined) return false
  return isRole(admin.role) && roleSatisfies(admin.role, minRole)
}

function isRole(role: string): role is Role {
  return Object.hasOwn(ROLE_RANK, role)
}
