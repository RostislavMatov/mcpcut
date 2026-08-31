import { describe, expect, test } from 'vitest'
import { matchesFilters } from '../../src/journal/search-filters.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * The record-level filter predicate both read arms share. The three fields
 * added for the journal redesign (2026-08-27) are pinned here: the agent of a
 * decision, and the inclusive `from`/`to` day bounds the period control emits.
 */

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-11T10:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
    ...overrides,
  }
}

function decision(agentName: string | undefined, ts = '2026-08-11T10:00:00.000Z'): JournalRecord {
  return record({
    ts,
    kind: 'decision',
    decision: {
      outcome: 'allow',
      rule: 'allow:read',
      serverName: 'github',
      toolName: 'list_issues',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'h',
      ...(agentName !== undefined ? { agentName } : {}),
    },
  })
}

describe('matchesFilters — agent', () => {
  test('keeps only decisions of the named agent', () => {
    expect(matchesFilters(decision('bot-1'), { agentName: 'bot-1' })).toBe(true)
    expect(matchesFilters(decision('bot-2'), { agentName: 'bot-1' })).toBe(false)
  })

  test('drops records with no agent at all — a traffic record is not "any agent"', () => {
    expect(matchesFilters(decision(undefined), { agentName: 'bot-1' })).toBe(false)
    expect(matchesFilters(record(), { agentName: 'bot-1' })).toBe(false)
  })

  test('matches exactly, never as a prefix', () => {
    expect(matchesFilters(decision('bot-10'), { agentName: 'bot-1' })).toBe(false)
  })
})

describe('matchesFilters — period', () => {
  test('from and to are inclusive day bounds on the record day', () => {
    const onDay = record({ ts: '2026-08-11T23:59:59.999Z' })
    expect(matchesFilters(onDay, { from: '2026-08-11', to: '2026-08-11' })).toBe(true)
    expect(matchesFilters(onDay, { from: '2026-08-12' })).toBe(false)
    expect(matchesFilters(onDay, { to: '2026-08-10' })).toBe(false)
  })

  test('an open-ended period bounds only the side that was given', () => {
    const early = record({ ts: '2026-01-01T00:00:00.000Z' })
    const late = record({ ts: '2026-12-31T00:00:00.000Z' })
    expect(matchesFilters(early, { to: '2026-08-11' })).toBe(true)
    expect(matchesFilters(late, { to: '2026-08-11' })).toBe(false)
    expect(matchesFilters(late, { from: '2026-08-11' })).toBe(true)
    expect(matchesFilters(early, { from: '2026-08-11' })).toBe(false)
  })

  test('combines with the other filters rather than replacing them', () => {
    const d = decision('bot-1', '2026-08-11T10:00:00.000Z')
    expect(matchesFilters(d, { agentName: 'bot-1', from: '2026-08-11', outcome: 'allow' })).toBe(true)
    expect(matchesFilters(d, { agentName: 'bot-1', from: '2026-08-12', outcome: 'allow' })).toBe(false)
  })
})
