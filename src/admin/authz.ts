import type { AdminRole } from './constants.js'

/**
 * Privilege ordering for admin roles, and the thresholds that more than one
 * surface has to agree on.
 *
 * This lives next to the admin identities rather than in `src/ui/authz.ts`
 * because it is no longer only the UI's concern: since M5 wave 2 the CLI's
 * `approvals approve|deny` enforces the same minimum role as the equivalent
 * HTTP route. Two definitions of "who outranks whom" — one per surface — is
 * exactly the kind of drift that outlives the people who introduced it, so
 * there is one, here, and `src/ui/authz.ts` re-exports it unchanged.
 */

/** A role in the authorization sense is exactly an admin role (one vocabulary). */
export type Role = AdminRole

/**
 * Privilege ordering. Higher rank strictly includes every lower one:
 * `owner` ⊇ `operator` ⊇ `viewer`. The only ordering that matters lives here
 * (`ADMIN_ROLES` in `constants.ts` is ordered for readability only).
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 1,
  operator: 2,
  owner: 3,
}

/** True when `role` meets or exceeds `minRole`. */
export function roleSatisfies(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole]
}

/**
 * Minimum role allowed to RESOLVE an approval (approve or deny), on every
 * surface: the UI routes `POST /approvals/:id/{approve,deny}` (ADR-0004,
 * §Roles — a `viewer` gets no POST action at all) and the CLI's
 * `approvals approve|deny`. Reading the queue is not gated by a role at all.
 */
export const APPROVAL_RESOLVE_MIN_ROLE: Role = 'operator'

/**
 * Minimum role allowed to RESOLVE a quarantined tool (approve, approve --all
 * or reject), on every surface: the UI routes
 * `POST /quarantine/{approve,reject}` and the CLI's `quarantine
 * approve|reject` (owner decision Q17, 2026-09-08). Letting a tool out of
 * quarantine widens what every agent granted that server can reach, which is
 * the same weight of decision as resolving an approval — and until Q17 the
 * CLI had no threshold at all, so the UI row was a barrier a shell walked
 * around. Reading the queue (`quarantine list|show`) is not gated by a role.
 */
export const QUARANTINE_RESOLVE_MIN_ROLE: Role = 'operator'
