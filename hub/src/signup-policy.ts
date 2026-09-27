import type { AccountRecord, TombstoneRecord } from './accounts-db.js'

/**
 * The sign-in decision (plan `hub-signin-accounts`, Task 2, HA12): one pure
 * function from "who is signing in, and what does the database already know
 * about them" to "what happens next". No I/O — the caller (`hub/src/server.ts`,
 * Task 5) gathers `existingAccount`/`tombstone`/counts from `accounts-db.ts`
 * and passes them in, which is what makes every branch here unit-testable
 * without a database.
 *
 * `decide` is ADVISORY for the capacity check: the actual seat reservation
 * happens inside `insertAccount`'s transaction (`accounts-db.ts`), which is
 * the one place a race between two concurrent signups is actually closed. A
 * caller that gets `'create'` here but a `'cap-reached'` back from
 * `insertAccount` a moment later should fall back to the waitlist — that race
 * is expected, not a bug.
 */

/** The subset of a fetched GitHub profile the decision needs. */
export interface GithubProfileInput {
  readonly githubId: number
  readonly login: string
  /** The GitHub account's own `created_at`, ISO-8601 UTC. */
  readonly githubCreatedAt: string
}

/**
 * HA9: a self-deleted account's GitHub id is refused re-signup for 30 days,
 * to guard against repeated abuse — separate from
 * `minAccountAgeDays` (HA12's GitHub-account-age gate), even though both
 * default to the same number today. There is no env knob for this one: it is
 * a fixed part of the abuse-cooldown design, not an operator tuning knob.
 */
export const DELETE_COOLDOWN_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export interface SignupPolicyInput {
  readonly profile: GithubProfileInput
  /** Injected "now" (ISO-8601 UTC) — see CLAUDE.md's testing rule on injected clocks. */
  readonly now: string
  /** The account already on file for `profile.githubId`, if any (H3: keyed by id, not login). */
  readonly existingAccount: AccountRecord | null
  /** The tombstone on file for `profile.githubId`, if any. */
  readonly tombstone: TombstoneRecord | null
  /** `countActive()` — every seat currently occupied, pending or active or blocked. */
  readonly accountCount: number
  readonly maxAccounts: number
  readonly minAccountAgeDays: number
  /** Phase 3's interface (`orchestrator.ts`) is not built yet in this phase — see plan "NOT Building". */
  readonly orchestratorAvailable: boolean
  /** How many accounts this IP has created in the trailing rate-limit window. */
  readonly recentSignupsFromIp: number
  readonly signupsPerHourPerIp: number
}

export type SignupRefusalReason = 'too-young' | 'blocked' | 'recently-deleted' | 'rate-limited'

export type SignupDecision =
  /** A known, non-blocked account signed back in. */
  | { readonly kind: 'existing'; readonly account: AccountRecord }
  /** Room for a new account and an orchestrator ready to provision one. */
  | { readonly kind: 'create' }
  /** No room (or no orchestrator yet) — the visitor joins the waitlist instead. */
  | { readonly kind: 'waitlist' }
  /** Refused outright; `eligibleAt` is set for the two time-bound reasons. */
  | {
      readonly kind: 'refused'
      readonly reason: SignupRefusalReason
      readonly eligibleAt?: string
    }

/**
 * Checked in this order, each one short-circuiting the rest:
 *
 * 1. A known account signs back in — `'existing'`, unless it was blocked,
 *    which always wins over everything else (an operator's block must not be
 *    quietly bypassed by whatever else is true about the account).
 * 2. A permanent stop-list entry (`tombstone.reason === 'blocked'`, HA12) —
 *    refused, unconditionally, however old.
 * 3. The GitHub account is younger than `minAccountAgeDays` (HA12) — refused
 *    with the date it becomes eligible. Checked before the delete cooldown
 *    because it is a property of the GitHub account itself, not of this
 *    hub's history with it.
 * 4. A self-delete cooldown (`tombstone.reason === 'deleted'`, HA9) still
 *    running — refused with the date it lifts.
 * 5. The IP has used up its hourly signup allowance (HA12) — refused.
 * 6. No orchestrator yet, or the host is at capacity (HA3) — waitlist.
 * 7. Otherwise — create.
 */
export function decide(input: SignupPolicyInput): SignupDecision {
  const { existingAccount } = input
  if (existingAccount !== null) {
    if (existingAccount.status === 'blocked') return refused('blocked')
    return { kind: 'existing', account: existingAccount }
  }

  if (input.tombstone !== null && input.tombstone.reason === 'blocked') {
    return refused('blocked')
  }

  const eligibleAgeAt = addDaysIso(input.profile.githubCreatedAt, input.minAccountAgeDays)
  if (eligibleAgeAt === null || isBefore(input.now, eligibleAgeAt)) {
    // An unparsable `githubCreatedAt` fails closed as "too young": this
    // decision must never let an unverifiable account through.
    return refused('too-young', eligibleAgeAt ?? undefined)
  }

  if (input.tombstone !== null && input.tombstone.reason === 'deleted') {
    const eligibleAgainAt = addDaysIso(input.tombstone.at, DELETE_COOLDOWN_DAYS)
    if (eligibleAgainAt !== null && isBefore(input.now, eligibleAgainAt)) {
      return refused('recently-deleted', eligibleAgainAt)
    }
  }

  if (input.recentSignupsFromIp >= input.signupsPerHourPerIp) {
    return refused('rate-limited')
  }

  if (!input.orchestratorAvailable || input.accountCount >= input.maxAccounts) {
    return { kind: 'waitlist' }
  }

  return { kind: 'create' }
}

function refused(reason: SignupRefusalReason, eligibleAt?: string): SignupDecision {
  return eligibleAt === undefined
    ? { kind: 'refused', reason }
    : { kind: 'refused', reason, eligibleAt }
}

/** `iso` plus `days`, or `null` when `iso` does not parse as a date. */
function addDaysIso(iso: string, days: number): string | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms + days * DAY_MS).toISOString()
}

/** Whether instant `a` is strictly before instant `b`. Unparsable input compares as "not before". */
function isBefore(a: string, b: string): boolean {
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (Number.isNaN(left) || Number.isNaN(right)) return false
  return left < right
}
