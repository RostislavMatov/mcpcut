import { describe, expect, test } from 'vitest'
import { parseAgentsFile } from '../../src/agents/schema.js'

const HASH = 'a'.repeat(64)
const CREATED = '2026-08-05T10:00:00.000Z'

function validRecord(name = 'research-bot'): Record<string, unknown> {
  return {
    name,
    tokenHash: HASH,
    createdAt: CREATED,
    grants: { github: { tools: ['get_*', 'list_issues'] } },
  }
}

function validFile(): Record<string, unknown> {
  return { version: 1, agents: { 'research-bot': validRecord() } }
}

describe('parseAgentsFile: accepted shapes', () => {
  test('a well-formed file parses', () => {
    const result = parseAgentsFile(validFile())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.agents['research-bot']?.grants['github']?.tools).toEqual([
        'get_*',
        'list_issues',
      ])
    }
  })

  test("tools: '*' literal (everything granted) parses", () => {
    const record = { ...validRecord(), grants: { github: { tools: '*' } } }

    const result = parseAgentsFile({ version: 1, agents: { 'research-bot': record } })

    expect(result.ok).toBe(true)
  })

  test('an empty agents map parses (fresh store default)', () => {
    expect(parseAgentsFile({ version: 1, agents: {} }).ok).toBe(true)
  })

  test('revokedAt is optional but must be an ISO datetime when present', () => {
    const revoked = { ...validRecord(), revokedAt: '2026-08-06T00:00:00.000Z' }
    expect(parseAgentsFile({ version: 1, agents: { 'research-bot': revoked } }).ok).toBe(true)

    const badRevoked = { ...validRecord(), revokedAt: 'yesterday' }
    expect(parseAgentsFile({ version: 1, agents: { 'research-bot': badRevoked } }).ok).toBe(false)
  })
})

describe('parseAgentsFile: rejected shapes (strictObject + format guards)', () => {
  test.each([
    ['unknown top-level key', { ...validFile(), extra: true }],
    ['wrong version', { version: 2, agents: {} }],
    ['missing agents map', { version: 1 }],
    ['unknown key inside a record', { version: 1, agents: { 'research-bot': { ...validRecord(), plaintextToken: 'x' } } }],
    ['missing tokenHash', { version: 1, agents: { 'research-bot': { name: 'research-bot', createdAt: CREATED, grants: {} } } }],
    ['tokenHash not 64 hex chars', { version: 1, agents: { 'research-bot': { ...validRecord(), tokenHash: 'abc' } } }],
    ['createdAt not ISO', { version: 1, agents: { 'research-bot': { ...validRecord(), createdAt: 'today' } } }],
    ['unknown key inside a grant', { version: 1, agents: { 'research-bot': { ...validRecord(), grants: { github: { tools: '*', extra: 1 } } } } }],
  ])('%s → not ok', (_label, value) => {
    expect(parseAgentsFile(value).ok).toBe(false)
  })

  test.each(['Research-Bot', '-leading-dash', 'a'.repeat(65), '', 'under_score', 'dot.name'])(
    'invalid agent name %j is rejected',
    (name) => {
      const file = { version: 1, agents: { [name]: validRecord(name) } }

      expect(parseAgentsFile(file).ok).toBe(false)
    },
  )

  test('agents map key must equal the record\'s own name field', () => {
    const file = { version: 1, agents: { 'other-name': validRecord('research-bot') } }

    expect(parseAgentsFile(file).ok).toBe(false)
  })

  test.each(['GitHub', '-github', 'git hub', ''])('invalid grant server name %j is rejected', (server) => {
    const record = { ...validRecord(), grants: { [server]: { tools: '*' } } }

    expect(parseAgentsFile({ version: 1, agents: { 'research-bot': record } }).ok).toBe(false)
  })

  test.each(['a*b', '*leading', '', '**', 'has space', '*'])(
    'invalid tool pattern %j inside a tools array is rejected',
    (pattern) => {
      const record = { ...validRecord(), grants: { github: { tools: [pattern] } } }

      expect(parseAgentsFile({ version: 1, agents: { 'research-bot': record } }).ok).toBe(false)
    },
  )
})

describe('parseAgentsFile: prototype-pollution hardening', () => {
  test('__proto__ as an agents key (materialized by JSON.parse) is rejected loudly', () => {
    const raw = JSON.parse(
      `{"version":1,"agents":{"__proto__":${JSON.stringify(validRecord('__proto__'))}}}`,
    ) as unknown

    expect(parseAgentsFile(raw).ok).toBe(false)
  })

  test('__proto__ as a grants key is rejected loudly', () => {
    const raw = JSON.parse(
      `{"version":1,"agents":{"research-bot":{"name":"research-bot","tokenHash":"${HASH}","createdAt":"${CREATED}","grants":{"__proto__":{"tools":"*"}}}}}`,
    ) as unknown

    expect(parseAgentsFile(raw).ok).toBe(false)
    expect(({} as { tools?: unknown }).tools).toBeUndefined()
  })

  test.each(['constructor', 'prototype'])('reserved key %j as a grants key is rejected', (key) => {
    const record = { ...validRecord(), grants: { [key]: { tools: '*' } } }

    expect(parseAgentsFile({ version: 1, agents: { 'research-bot': record } }).ok).toBe(false)
  })

  test.each(['__proto__', 'constructor', 'prototype'])(
    'reserved name %j as a tools array element is rejected',
    (tool) => {
      const record = { ...validRecord(), grants: { github: { tools: [tool] } } }

      expect(parseAgentsFile({ version: 1, agents: { 'research-bot': record } }).ok).toBe(false)
    },
  )
})
