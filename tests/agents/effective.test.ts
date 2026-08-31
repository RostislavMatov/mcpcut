import { describe, expect, test } from 'vitest'
import { effectiveGrantsOf, materializeAgent } from '../../src/agents/effective.js'
import type { AgentRecord } from '../../src/agents/schema.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import { grantsHashOf } from '../../src/policy/provenance.js'

/**
 * Per-server override (decision G2) and the byte-identity gate that protects
 * every installation without groups: an agent that belongs to no group must
 * come out of `materializeAgent` as the very same object, so `grantsHash` in
 * its decision records cannot move (G5).
 */

const AGENT_NAME = 'research-bot'

function agentOf(grants: AgentRecord['grants'] = {}): AgentRecord {
  return {
    name: AGENT_NAME,
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-08-31T00:00:00.000Z',
    grants,
  }
}

function groupOf(overrides: Partial<GroupRecord> & { name: string }): GroupRecord {
  return {
    createdAt: '2026-08-31T00:00:00.000Z',
    grants: {},
    members: [AGENT_NAME],
    ...overrides,
  }
}

describe('effectiveGrantsOf: an agent without contributing groups', () => {
  test('returns the personal matrix BY REFERENCE, so the fingerprint cannot move', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })

    // Act
    const effective = effectiveGrantsOf(agent, [])

    // Assert
    expect(effective.grants).toBe(agent.grants)
    expect(grantsHashOf(effective.grants)).toBe(grantsHashOf(agent.grants))
    expect(effective.sources).toEqual({ github: { kind: 'agent', shadowedGroups: [] } })
  })

  test('ignores groups the agent is not a member of, however much they grant', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })
    const foreign = groupOf({ name: 'analytics', grants: { postgres: { tools: '*' } }, members: ['other-bot'] })

    // Act
    const effective = effectiveGrantsOf(agent, [foreign])

    // Assert
    expect(effective.grants).toBe(agent.grants)
    expect(Object.keys(effective.grants)).toEqual(['github'])
  })

  test('a member group that grants nothing leaves the matrix untouched', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })
    const empty = groupOf({ name: 'analytics' })

    // Act
    const effective = effectiveGrantsOf(agent, [empty])

    // Assert
    expect(effective.grants).toBe(agent.grants)
  })
})

describe('effectiveGrantsOf: G2 per-server override', () => {
  test('a personal grant wins wholesale, even when it is narrower than the group grant', () => {
    // Arrange
    const agent = agentOf({ postgres: { tools: ['read_rows'] } })
    const group = groupOf({
      name: 'analytics',
      grants: { postgres: { tools: '*', resources: '*', prompts: '*' } },
    })

    // Act
    const effective = effectiveGrantsOf(agent, [group])

    // Assert — the group's wider grant is NOT merged in, not even its fields
    expect(effective.grants).toEqual({ postgres: { tools: ['read_rows'] } })
    expect(effective.grants.postgres).toBe(agent.grants.postgres)
    expect(effective.sources).toEqual({
      postgres: { kind: 'agent', shadowedGroups: ['analytics'] },
    })
  })

  test('names every group whose grant for that server was shadowed, in input order', () => {
    // Arrange
    const agent = agentOf({ postgres: { tools: [] }, github: { tools: '*' } })
    const analytics = groupOf({ name: 'analytics', grants: { postgres: { tools: '*' } } })
    const billing = groupOf({ name: 'billing', grants: { postgres: { tools: ['count'] } } })

    // Act
    const effective = effectiveGrantsOf(agent, [analytics, billing])

    // Assert
    expect(effective.sources).toEqual({
      postgres: { kind: 'agent', shadowedGroups: ['analytics', 'billing'] },
      github: { kind: 'agent', shadowedGroups: [] },
    })
  })
})

describe('effectiveGrantsOf: union across groups', () => {
  test('adds a server the agent holds only through a group', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })
    const group = groupOf({ name: 'analytics', grants: { postgres: { tools: ['query'] } } })

    // Act
    const effective = effectiveGrantsOf(agent, [group])

    // Assert
    expect(effective.grants).toEqual({
      github: { tools: ['read_*'] },
      postgres: { tools: ['query'] },
    })
    expect(effective.sources.postgres).toEqual({ kind: 'group', groups: ['analytics'] })
    expect(effective.grants.github).toBe(agent.grants.github)
  })

  test('merges two groups: sorted by code unit, deduplicated', () => {
    // Arrange
    const agent = agentOf()
    const analytics = groupOf({ name: 'analytics', grants: { postgres: { tools: ['query', 'read_*'] } } })
    const billing = groupOf({ name: 'billing', grants: { postgres: { tools: ['Alpha', 'query'] } } })

    // Act
    const effective = effectiveGrantsOf(agent, [analytics, billing])

    // Assert — 'Alpha' sorts before the lowercase names by UTF-16 code unit
    expect(effective.grants.postgres).toEqual({ tools: ['Alpha', 'query', 'read_*'] })
    expect(effective.sources.postgres).toEqual({ kind: 'group', groups: ['analytics', 'billing'] })
  })

  test("'*' from any group absorbs the other lists", () => {
    // Arrange
    const agent = agentOf()
    const analytics = groupOf({ name: 'analytics', grants: { postgres: { tools: ['query'] } } })
    const billing = groupOf({ name: 'billing', grants: { postgres: { tools: '*' } } })

    // Act
    const effective = effectiveGrantsOf(agent, [analytics, billing])

    // Assert
    expect(effective.grants.postgres).toEqual({ tools: '*' })
  })

  test('an optional field present in only one group is present in the union', () => {
    // Arrange
    const agent = agentOf()
    const analytics = groupOf({
      name: 'analytics',
      grants: { postgres: { tools: ['query'], resources: ['db://public/*'] } },
    })
    const billing = groupOf({ name: 'billing', grants: { postgres: { tools: ['count'] } } })

    // Act
    const effective = effectiveGrantsOf(agent, [analytics, billing])

    // Assert
    expect(effective.grants.postgres).toEqual({
      tools: ['count', 'query'],
      resources: ['db://public/*'],
    })
  })

  test('an optional field absent in EVERY group stays absent (fail-closed)', () => {
    // Arrange
    const agent = agentOf()
    const group = groupOf({ name: 'analytics', grants: { postgres: { tools: ['query'] } } })

    // Act
    const effective = effectiveGrantsOf(agent, [group])

    // Assert — absent, not `undefined`: `Object.hasOwn` must report "no grant"
    expect(Object.hasOwn(effective.grants.postgres, 'resources')).toBe(false)
    expect(Object.hasOwn(effective.grants.postgres, 'prompts')).toBe(false)
  })

  test('merges the prompts dimension the same way as tools', () => {
    // Arrange
    const agent = agentOf()
    const analytics = groupOf({
      name: 'analytics',
      grants: { postgres: { tools: [], prompts: ['summarize'] } },
    })
    const billing = groupOf({
      name: 'billing',
      grants: { postgres: { tools: [], prompts: ['audit', 'summarize'] } },
    })

    // Act
    const effective = effectiveGrantsOf(agent, [analytics, billing])

    // Assert
    expect(effective.grants.postgres).toEqual({ tools: [], prompts: ['audit', 'summarize'] })
  })

  test('never mutates the inputs', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })
    const group = groupOf({ name: 'analytics', grants: { postgres: { tools: ['b', 'a'] } } })
    const agentSnapshot = structuredClone(agent)
    const groupSnapshot = structuredClone(group)

    // Act
    effectiveGrantsOf(agent, [group])

    // Assert
    expect(agent).toEqual(agentSnapshot)
    expect(group).toEqual(groupSnapshot)
  })
})

describe('materializeAgent', () => {
  test('returns the SAME record object when no group contributes a server', () => {
    // Arrange
    const agent = agentOf({ github: { tools: ['read_*'] } })
    const shadowing = groupOf({ name: 'analytics', grants: { github: { tools: '*' } } })

    // Act
    const materialized = materializeAgent(agent, [shadowing])

    // Assert — identity, so `grantsHash` is byte-identical to the pre-groups one
    expect(materialized).toBe(agent)
    expect(grantsHashOf(materialized.grants)).toBe(grantsHashOf(agent.grants))
  })

  test('carries identity and revocation through unchanged while widening grants', () => {
    // Arrange
    const agent: AgentRecord = { ...agentOf(), revokedAt: '2026-08-31T10:00:00.000Z' }
    const group = groupOf({ name: 'analytics', grants: { postgres: { tools: '*' } } })

    // Act
    const materialized = materializeAgent(agent, [group])

    // Assert
    expect(materialized).not.toBe(agent)
    expect(materialized.name).toBe(agent.name)
    expect(materialized.tokenHash).toBe(agent.tokenHash)
    expect(materialized.revokedAt).toBe(agent.revokedAt)
    expect(materialized.grants).toEqual({ postgres: { tools: '*' } })
    expect(agent.grants).toEqual({})
  })

  test('the expanded matrix hashes differently from the personal one (G5)', () => {
    // Arrange
    const agent = agentOf()
    const group = groupOf({ name: 'analytics', grants: { postgres: { tools: ['query'] } } })

    // Act
    const materialized = materializeAgent(agent, [group])

    // Assert
    expect(grantsHashOf(materialized.grants)).not.toBe(grantsHashOf(agent.grants))
  })
})
