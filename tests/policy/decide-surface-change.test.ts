import { describe, expect, test } from 'vitest'
import { SURFACE_CHANGED_RULE, decide, type DecideInput } from '../../src/policy/decide.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/**
 * M5 wave 6, owner decision O4: an explicit per-tool `allow` stops covering a
 * tool whose advertised surface changed AFTER the operator approved it.
 *
 * Why here and not in `classifyTool`: a `changed` tool is already quarantined,
 * and quarantine already outranks the class defaults -- so raising the class
 * would only change an outcome where quarantine is switched off, i.e. exactly
 * where the operator opted out of drift gating. The path an unchanged rule
 * actually leaves open is the opposite one: a per-tool rule outranks
 * quarantine, so an `allow` written against one surface keeps allowing calls
 * against a surface the server has since widened.
 */

function policy(raw: unknown): Policy {
  const result = parsePolicy(raw)
  if (!result.ok) throw new Error(`invalid policy fixture: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function input(overrides: Partial<DecideInput> & { policy: Policy }): DecideInput {
  return {
    serverName: 'github',
    toolName: 'search_index',
    toolClass: 'read',
    quarantineState: 'changed',
    hasActiveGrant: false,
    catalogObserved: true,
    catalogTrusted: true,
    ...overrides,
  }
}

const ALLOW_RULE_POLICY = {
  version: 1,
  quarantine: { enabled: true, onQuarantined: 'require-approval' },
  servers: { github: { tools: { search_index: 'allow' } } },
}

describe('decide: an explicit allow no longer covers a widened surface (O4)', () => {
  test('widened surface turns the allow into the quarantine outcome, under its own rule', () => {
    const result = decide(input({ policy: policy(ALLOW_RULE_POLICY), surfaceDelta: 'widened' }))

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe(SURFACE_CHANGED_RULE)
    // The superseded rule has to be nameable from the record: an auditor asking
    // "the policy says allow, why was this gated?" must not have to guess.
    expect(result.reason).toContain('servers.github.tools.search_index')
    expect(result.reason).toContain('widened')
  })

  test('an ambiguous "changed" delta escalates too -- it is not provably narrower', () => {
    const result = decide(input({ policy: policy(ALLOW_RULE_POLICY), surfaceDelta: 'changed' }))

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe(SURFACE_CHANGED_RULE)
  })

  test('an UNCOMPUTABLE delta escalates: absence of the signal is not evidence of safety', () => {
    // The real dogfood case: the approved record predates descriptor storage,
    // or the stored schema was truncated, so no direction was derivable.
    const result = decide(input({ policy: policy(ALLOW_RULE_POLICY) }))

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe(SURFACE_CHANGED_RULE)
    expect(result.reason).toContain('could not be determined')
  })

  test('escalation follows onQuarantined: an operator who denies drift gets a deny', () => {
    const result = decide(
      input({
        policy: policy({
          ...ALLOW_RULE_POLICY,
          quarantine: { enabled: true, onQuarantined: 'deny' },
        }),
        surfaceDelta: 'widened',
      }),
    )

    expect(result.outcome).toBe('deny')
    expect(result.rule).toBe(SURFACE_CHANGED_RULE)
  })

  test('a narrowed surface leaves the allow standing', () => {
    const result = decide(input({ policy: policy(ALLOW_RULE_POLICY), surfaceDelta: 'narrowed' }))

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('a neutral (wording-only) change leaves the allow standing', () => {
    const result = decide(input({ policy: policy(ALLOW_RULE_POLICY), surfaceDelta: 'neutral' }))

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('a glob rule escalates the same way, and the reason names the pattern', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'require-approval' },
          servers: { github: { tools: { 'search_*': 'allow' } } },
        }),
        surfaceDelta: 'widened',
      }),
    )

    expect(result.rule).toBe(SURFACE_CHANGED_RULE)
    expect(result.reason).toContain('servers.github.tools.search_*')
  })
})

describe('decide: what O4 deliberately does NOT touch', () => {
  test('state "new" is untouched: the rule was never written against an approved surface', () => {
    const result = decide(
      input({ policy: policy(ALLOW_RULE_POLICY), quarantineState: 'new', surfaceDelta: 'widened' }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('state "known" is untouched even if a stale delta is passed in', () => {
    const result = decide(
      input({ policy: policy(ALLOW_RULE_POLICY), quarantineState: 'known', surfaceDelta: 'widened' }),
    )

    expect(result.outcome).toBe('allow')
  })

  test('a deny rule stays a deny under its own rule string -- escalation only touches allow', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'require-approval' },
          servers: { github: { tools: { search_index: 'deny' } } },
        }),
        surfaceDelta: 'widened',
      }),
    )

    expect(result.outcome).toBe('deny')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('a require-approval rule keeps its own rule string: it already gates the call', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'require-approval' },
          servers: { github: { tools: { search_index: 'require-approval' } } },
        }),
        surfaceDelta: 'widened',
      }),
    )

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('quarantine disabled: the allow stands, because the operator opted out of drift gating', () => {
    const result = decide(
      input({
        policy: policy({
          ...ALLOW_RULE_POLICY,
          quarantine: { enabled: false },
        }),
        surfaceDelta: 'widened',
      }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('an active approvals grant still allows: it was issued for THIS call shape', () => {
    const result = decide(
      input({ policy: policy(ALLOW_RULE_POLICY), hasActiveGrant: true, surfaceDelta: 'widened' }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('grant')
  })

  test('an ungranted agent is still denied first: O4 never resurrects a call step 0 killed', () => {
    const result = decide(
      input({
        policy: policy(ALLOW_RULE_POLICY),
        agentGrant: 'not-granted',
        surfaceDelta: 'widened',
      }),
    )

    expect(result.outcome).toBe('deny')
    expect(result.rule).toContain('agent: no grant')
  })
})
