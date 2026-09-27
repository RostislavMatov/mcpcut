import { describe, expect, test } from 'vitest'
import type { AccountRecord, TombstoneRecord } from '../../hub/src/accounts-db.js'
import { DELETE_COOLDOWN_DAYS, decide, type SignupPolicyInput } from '../../hub/src/signup-policy.js'

/**
 * `hub/src/signup-policy.ts` (plan `hub-signin-accounts`, Task 2, HA12): a
 * pure decision table. Every test builds a full, valid input and overrides
 * only what it is testing, so a failure always points at one branch.
 */

const NOW = '2026-09-27T00:00:00.000Z'

function accountOf(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    githubId: 1,
    login: 'alice',
    subdomain: 'alice',
    status: 'active',
    githubCreatedAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function baseInput(overrides: Partial<SignupPolicyInput> = {}): SignupPolicyInput {
  return {
    profile: { githubId: 1, login: 'alice', githubCreatedAt: '2020-01-01T00:00:00.000Z' },
    now: NOW,
    existingAccount: null,
    tombstone: null,
    accountCount: 3,
    maxAccounts: 15,
    minAccountAgeDays: 30,
    orchestratorAvailable: true,
    recentSignupsFromIp: 0,
    signupsPerHourPerIp: 3,
    ...overrides,
  }
}

describe('decide: a returning account', () => {
  test('a known, non-blocked account signs back in', () => {
    const account = accountOf({ status: 'active' })
    expect(decide(baseInput({ existingAccount: account }))).toEqual({ kind: 'existing', account })
  })

  test('a known pending account (mid-provisioning) also signs back in', () => {
    const account = accountOf({ status: 'pending' })
    expect(decide(baseInput({ existingAccount: account }))).toEqual({ kind: 'existing', account })
  })

  test('a blocked account is refused, even though it still exists', () => {
    const account = accountOf({ status: 'blocked' })
    expect(decide(baseInput({ existingAccount: account }))).toEqual({
      kind: 'refused',
      reason: 'blocked',
    })
  })

  test('an existing account bypasses the age gate entirely', () => {
    const account = accountOf({ status: 'active', githubCreatedAt: NOW })
    expect(decide(baseInput({ existingAccount: account, profile: { githubId: 1, login: 'alice', githubCreatedAt: NOW } }))).toEqual({
      kind: 'existing',
      account,
    })
  })
})

describe('decide: a permanent stop-list entry (blocked tombstone)', () => {
  const tombstone: TombstoneRecord = { githubId: 1, reason: 'blocked', at: '2020-01-01T00:00:00.000Z' }

  test('refused regardless of how long ago the block happened', () => {
    expect(decide(baseInput({ tombstone }))).toEqual({ kind: 'refused', reason: 'blocked' })
  })

  test('takes priority over the age gate', () => {
    const input = baseInput({
      tombstone,
      profile: { githubId: 1, login: 'alice', githubCreatedAt: NOW },
    })
    expect(decide(input)).toEqual({ kind: 'refused', reason: 'blocked' })
  })
})

describe('decide: the age gate (HA12)', () => {
  test('an account exactly minAccountAgeDays old is eligible', () => {
    const input = baseInput({
      now: '2026-01-31T00:00:00.000Z',
      profile: { githubId: 1, login: 'alice', githubCreatedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decide(input)).toEqual({ kind: 'create' })
  })

  test('an account one day younger than the floor is refused with the eligible date', () => {
    const input = baseInput({
      now: '2026-01-30T00:00:00.000Z',
      profile: { githubId: 1, login: 'alice', githubCreatedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decide(input)).toEqual({
      kind: 'refused',
      reason: 'too-young',
      eligibleAt: '2026-01-31T00:00:00.000Z',
    })
  })

  test('an unparsable githubCreatedAt fails closed as too-young', () => {
    const input = baseInput({ profile: { githubId: 1, login: 'alice', githubCreatedAt: 'not-a-date' } })
    expect(decide(input)).toEqual({ kind: 'refused', reason: 'too-young' })
  })

  test('a custom minAccountAgeDays is honored', () => {
    const input = baseInput({
      minAccountAgeDays: 7,
      now: '2026-01-08T00:00:00.000Z',
      profile: { githubId: 1, login: 'alice', githubCreatedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decide(input)).toEqual({ kind: 'create' })
  })
})

describe('decide: the delete cooldown (HA9)', () => {
  test('a deleted tombstone within the cooldown is refused with the eligible date', () => {
    const tombstone: TombstoneRecord = {
      githubId: 1,
      reason: 'deleted',
      at: '2026-09-01T00:00:00.000Z',
    }
    expect(decide(baseInput({ tombstone, now: '2026-09-15T00:00:00.000Z' }))).toEqual({
      kind: 'refused',
      reason: 'recently-deleted',
      eligibleAt: '2026-10-01T00:00:00.000Z',
    })
  })

  test(`a deleted tombstone exactly ${DELETE_COOLDOWN_DAYS} days old is eligible again`, () => {
    const tombstone: TombstoneRecord = {
      githubId: 1,
      reason: 'deleted',
      at: '2026-08-01T00:00:00.000Z',
    }
    expect(decide(baseInput({ tombstone, now: '2026-08-31T00:00:00.000Z' }))).toEqual({
      kind: 'create',
    })
  })

  test('the age gate is still checked first even with an expired deleted tombstone', () => {
    const tombstone: TombstoneRecord = {
      githubId: 1,
      reason: 'deleted',
      at: '2020-01-01T00:00:00.000Z',
    }
    const input = baseInput({
      tombstone,
      now: '2026-01-30T00:00:00.000Z',
      profile: { githubId: 1, login: 'alice', githubCreatedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decide(input)).toEqual({
      kind: 'refused',
      reason: 'too-young',
      eligibleAt: '2026-01-31T00:00:00.000Z',
    })
  })
})

describe('decide: per-IP rate limit (HA12)', () => {
  test('at the limit, refused as rate-limited', () => {
    expect(decide(baseInput({ recentSignupsFromIp: 3, signupsPerHourPerIp: 3 }))).toEqual({
      kind: 'refused',
      reason: 'rate-limited',
    })
  })

  test('one below the limit, allowed through to the capacity check', () => {
    expect(decide(baseInput({ recentSignupsFromIp: 2, signupsPerHourPerIp: 3 }))).toEqual({
      kind: 'create',
    })
  })
})

describe('decide: capacity and the orchestrator (HA3)', () => {
  test('capacity reached goes to the waitlist', () => {
    expect(decide(baseInput({ accountCount: 15, maxAccounts: 15 }))).toEqual({ kind: 'waitlist' })
  })

  test('an unavailable orchestrator goes to the waitlist even with room', () => {
    expect(decide(baseInput({ orchestratorAvailable: false, accountCount: 0 }))).toEqual({
      kind: 'waitlist',
    })
  })

  test('room and an available orchestrator create the account', () => {
    expect(decide(baseInput({ accountCount: 14, maxAccounts: 15 }))).toEqual({ kind: 'create' })
  })
})
