import { describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { matchesFilters } from '../../src/journal/search-filters.js'

function decision(toolName: string, payload: unknown): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G0001',
    ts: '2026-10-07T10:00:00.000Z',
    sessionId: 's',
    direction: 'client→server',
    kind: 'decision',
    payload,
    decision: { outcome: 'allow', rule: 'r', serverName: 'files', toolName, toolClass: 'write', quarantineState: 'known', argsHash: 'h' },
  } as unknown as JournalRecord
}

describe('anyText and toolNames', () => {
  test('anyText matches when any of the substrings occurs, case-insensitively', () => {
    const record = decision('delete_file', { path: '/Root/Dir' })

    expect(matchesFilters(record, { anyText: ['"/nowhere"', '"/root/dir"'] })).toBe(true)
    expect(matchesFilters(record, { anyText: ['"/root/di"'] })).toBe(false)
    expect(matchesFilters(record, { anyText: [] })).toBe(false)
  })

  test('toolNames keeps decisions of any of the tools', () => {
    expect(matchesFilters(decision('move_file', {}), { toolNames: ['move_file', 'delete_file'] })).toBe(true)
    expect(matchesFilters(decision('read_file', {}), { toolNames: ['move_file', 'delete_file'] })).toBe(false)
  })
})
