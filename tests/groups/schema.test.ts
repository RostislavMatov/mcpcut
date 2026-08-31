import { describe, expect, test } from 'vitest'
import { parseGroupsFile } from '../../src/groups/schema.js'

const CREATED = '2026-08-31T10:00:00.000Z'

function validRecord(name = 'analytics'): Record<string, unknown> {
  return {
    name,
    createdAt: CREATED,
    grants: { postgres: { tools: ['get_*', 'list_tables'] } },
    members: ['bot-a', 'bot-b'],
  }
}

function validFile(): Record<string, unknown> {
  return { version: 1, groups: { analytics: validRecord() } }
}

describe('parseGroupsFile: accepted shapes', () => {
  test('a well-formed file parses', () => {
    const result = parseGroupsFile(validFile())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.groups['analytics']?.grants['postgres']?.tools).toEqual([
        'get_*',
        'list_tables',
      ])
      expect(result.file.groups['analytics']?.members).toEqual(['bot-a', 'bot-b'])
    }
  })

  test("tools: '*' plus optional resources/prompts parse (same grant shape as agents)", () => {
    const record = {
      ...validRecord(),
      grants: { postgres: { tools: '*', resources: ['db://tables/*'], prompts: '*' } },
    }

    expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(true)
  })

  test('an empty groups map parses (fresh store default)', () => {
    expect(parseGroupsFile({ version: 1, groups: {} }).ok).toBe(true)
  })

  test('a group with no grants and no members parses', () => {
    const record = { ...validRecord(), grants: {}, members: [] }

    expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(true)
  })

  test('members at the cap parse', () => {
    const members = Array.from({ length: 200 }, (_, i) => `bot-${String(i).padStart(3, '0')}`)
    const record = { ...validRecord(), members }

    expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(true)
  })
})

describe('parseGroupsFile: rejected shapes (strictObject + format guards)', () => {
  test.each([
    ['unknown top-level key', { ...validFile(), extra: true }],
    ['wrong version', { version: 2, groups: {} }],
    ['missing groups map', { version: 1 }],
    [
      'unknown key inside a record',
      { version: 1, groups: { analytics: { ...validRecord(), owner: 'x' } } },
    ],
    [
      'missing members',
      { version: 1, groups: { analytics: { name: 'analytics', createdAt: CREATED, grants: {} } } },
    ],
    ['missing createdAt', { version: 1, groups: { analytics: { name: 'analytics', grants: {}, members: [] } } }],
    ['createdAt is not an ISO datetime', { version: 1, groups: { analytics: { ...validRecord(), createdAt: 'yesterday' } } }],
    ['uppercase group name', { version: 1, groups: { Analytics: validRecord('Analytics') } }],
    ['group name starting with a dash', { version: 1, groups: { '-bad': validRecord('-bad') } }],
    ['group name over 64 chars', { version: 1, groups: { ['a'.repeat(65)]: validRecord('a'.repeat(65)) } }],
    ['invalid server name in grants', { version: 1, groups: { analytics: { ...validRecord(), grants: { 'Bad Name': { tools: '*' } } } } }],
    ['invalid tool pattern in a grant', { version: 1, groups: { analytics: { ...validRecord(), grants: { postgres: { tools: ['a**'] } } } } }],
    ['members entry is not an agent name', { version: 1, groups: { analytics: { ...validRecord(), members: ['Bot A'] } } }],
    ['members entry is not a string', { version: 1, groups: { analytics: { ...validRecord(), members: [42] } } }],
  ])('%s is rejected', (_label, value) => {
    expect(parseGroupsFile(value).ok).toBe(false)
  })

  test("a groups key that does not match the record's name is rejected", () => {
    const value = { version: 1, groups: { analytics: validRecord('reporting') } }

    const result = parseGroupsFile(value)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain(
        'does not match',
      )
    }
  })
})

describe('parseGroupsFile: members are a sorted, duplicate-free list', () => {
  test('unsorted members are rejected (the document must be deterministic)', () => {
    const record = { ...validRecord(), members: ['bot-b', 'bot-a'] }

    const result = parseGroupsFile({ version: 1, groups: { analytics: record } })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('sorted')
    }
  })

  test('duplicate members are rejected', () => {
    const record = { ...validRecord(), members: ['bot-a', 'bot-a'] }

    const result = parseGroupsFile({ version: 1, groups: { analytics: record } })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('duplicate')
    }
  })

  test('sorting is by UTF-16 code unit, not locale: "bot-z" before "bota" is REJECTED', () => {
    // `localeCompare` would call this pair sorted; code-unit order does not
    // ('-' = 0x2D < 'a' = 0x61 means "bot-z" < "bota" — so this IS sorted).
    const sorted = { ...validRecord(), members: ['bot-z', 'bota'] }
    expect(parseGroupsFile({ version: 1, groups: { analytics: sorted } }).ok).toBe(true)

    const unsorted = { ...validRecord(), members: ['bota', 'bot-z'] }
    expect(parseGroupsFile({ version: 1, groups: { analytics: unsorted } }).ok).toBe(false)
  })
})

describe('parseGroupsFile: limits', () => {
  test('more than 100 groups is rejected', () => {
    const groups = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => {
        const name = `g-${String(i).padStart(3, '0')}`
        return [name, validRecord(name)]
      }),
    )

    expect(parseGroupsFile({ version: 1, groups }).ok).toBe(false)
  })

  test('more than 100 server grants in one group is rejected', () => {
    const grants = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`srv-${String(i).padStart(3, '0')}`, { tools: '*' }]),
    )
    const record = { ...validRecord(), grants }

    expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(false)
  })

  test('more than 200 members is rejected', () => {
    const members = Array.from({ length: 201 }, (_, i) => `bot-${String(i).padStart(3, '0')}`)
    const record = { ...validRecord(), members }

    expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(false)
  })
})

describe('parseGroupsFile: prototype-pollution hardening', () => {
  test('__proto__ as a groups key (materialized by JSON.parse) is rejected loudly', () => {
    const raw = JSON.parse(
      `{"version":1,"groups":{"__proto__":${JSON.stringify(validRecord('__proto__'))}}}`,
    ) as unknown

    expect(parseGroupsFile(raw).ok).toBe(false)
  })

  test('__proto__ as a grants key is rejected loudly', () => {
    const raw = JSON.parse(
      `{"version":1,"groups":{"analytics":{"name":"analytics","createdAt":"${CREATED}","grants":{"__proto__":{"tools":"*"}},"members":[]}}}`,
    ) as unknown

    expect(parseGroupsFile(raw).ok).toBe(false)
    expect(({} as { tools?: unknown }).tools).toBeUndefined()
  })

  test.each(['__proto__', 'constructor', 'prototype'])(
    'reserved name %j as a members element is rejected',
    (member) => {
      const record = { ...validRecord(), members: [member] }

      expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(false)
    },
  )

  test.each(['__proto__', 'constructor', 'prototype'])(
    'reserved name %j as a tools array element is rejected',
    (tool) => {
      const record = { ...validRecord(), grants: { postgres: { tools: [tool] } } }

      expect(parseGroupsFile({ version: 1, groups: { analytics: record } }).ok).toBe(false)
    },
  )
})
