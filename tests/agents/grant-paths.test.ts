import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { effectiveGrantsOf } from '../../src/agents/effective.js'
import { agentGrantSchema, type AgentRecord } from '../../src/agents/schema.js'
import { MAX_PATHS_PER_GRANT } from '../../src/files/constants.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import { grantsHashOf } from '../../src/policy/provenance.js'

/**
 * ADR-0020 §2 (M24): file rights live in the agent's grant for the built-in
 * `files` server as an optional `paths` field, so they inherit through groups
 * (ADR-0010) exactly like tools: a personal grant wins wholesale, otherwise
 * the groups' rules add up. Absent stays absent — "no file rights" must never
 * turn into "an empty list that exists".
 */

const AGENT_NAME = 'writer-bot'
const data = resolve('/data')
const team = resolve('/team')

function agentOf(grants: AgentRecord['grants'] = {}): AgentRecord {
  return { name: AGENT_NAME, tokenHash: 'a'.repeat(64), createdAt: '2026-10-03T00:00:00.000Z', grants }
}

function groupOf(name: string, grants: GroupRecord['grants']): GroupRecord {
  return { name, createdAt: '2026-10-03T00:00:00.000Z', grants, members: [AGENT_NAME] }
}

describe('agentGrantSchema — paths', () => {
  test('a grant with folder rules parses, an empty ops list included (a cut-out)', () => {
    const grant = { tools: '*', paths: [{ path: data, ops: ['read', 'write'] }, { path: resolve('/data/secret'), ops: [] }] }
    expect(agentGrantSchema.safeParse(grant).success).toBe(true)
  })

  test('a grant without paths keeps the field absent', () => {
    const parsed = agentGrantSchema.parse({ tools: ['read_*'] })
    expect('paths' in parsed).toBe(false)
  })

  test.each<[label: string, rule: unknown]>([
    ['a relative path', { path: 'data/a', ops: ['read'] }],
    ['a NUL byte', { path: `${data}\u0000x`, ops: ['read'] }],
    ['an unknown operation', { path: data, ops: ['execute'] }],
    ['a repeated operation', { path: data, ops: ['read', 'read'] }],
    ['an extra key', { path: data, ops: ['read'], recursive: false }],
    ['an empty path', { path: '', ops: ['read'] }],
  ])('%s is rejected', (_label, rule) => {
    expect(agentGrantSchema.safeParse({ tools: '*', paths: [rule] }).success).toBe(false)
  })

  test('more rules than the limit are rejected', () => {
    const paths = Array.from({ length: MAX_PATHS_PER_GRANT + 1 }, (_, index) => ({ path: resolve(`/data/${index}`), ops: ['read'] }))
    expect(agentGrantSchema.safeParse({ tools: '*', paths }).success).toBe(false)
  })
})

describe('effectiveGrantsOf — paths through groups', () => {
  test('rules from two groups add up, sorted and without repeats', () => {
    const agent = agentOf()
    const groups = [
      groupOf('writers', { files: { tools: '*', paths: [{ path: team, ops: ['read'] }, { path: data, ops: ['write'] }] } }),
      groupOf('readers', { files: { tools: '*', paths: [{ path: data, ops: ['write'] }] } }),
    ]
    expect(effectiveGrantsOf(agent, groups).grants['files']?.paths).toEqual([
      { path: data, ops: ['write'] },
      { path: team, ops: ['read'] },
    ])
  })

  test("the agent's own grant for files wins wholesale over the groups'", () => {
    const agent = agentOf({ files: { tools: '*', paths: [{ path: data, ops: ['read'] }] } })
    const groups = [groupOf('writers', { files: { tools: '*', paths: [{ path: team, ops: ['write', 'delete'] }] } })]
    expect(effectiveGrantsOf(agent, groups).grants['files']?.paths).toEqual([{ path: data, ops: ['read'] }])
  })

  test('groups that grant files without paths leave the field absent', () => {
    const groups = [groupOf('tools-only', { files: { tools: ['list_roots'] } })]
    const merged = effectiveGrantsOf(agentOf(), groups).grants['files']
    expect(merged !== undefined && 'paths' in merged).toBe(false)
  })
})

describe('grantsHashOf — paths', () => {
  test('the same rules in another order, with operations in another order, give the same fingerprint', () => {
    const one = { files: { tools: '*' as const, paths: [{ path: data, ops: ['read' as const, 'write' as const] }, { path: team, ops: [] }] } }
    const two = { files: { tools: '*' as const, paths: [{ path: team, ops: [] }, { path: data, ops: ['write' as const, 'read' as const] }] } }
    expect(grantsHashOf(one)).toBe(grantsHashOf(two))
  })

  test('different rules give different fingerprints', () => {
    const one = { files: { tools: '*' as const, paths: [{ path: data, ops: ['read' as const] }] } }
    const two = { files: { tools: '*' as const, paths: [{ path: data, ops: ['read' as const, 'delete' as const] }] } }
    expect(grantsHashOf(one)).not.toBe(grantsHashOf(two))
  })
})

describe('cut-outs of two groups on one path', () => {
  test('both stay, so a stale or missing identity in one cannot hide the other', () => {
    const folder = resolve('/data/secret')
    const one = groupOf('one', { files: { tools: '*', paths: [{ path: folder, ops: [], identity: { dev: '1', ino: '42' } }] } })
    const two = groupOf('two', { files: { tools: '*', paths: [{ path: folder, ops: [] }] } })

    const paths = effectiveGrantsOf(agentOf(), [one, two]).grants['files']?.paths

    expect(paths).toHaveLength(2)
    expect(paths).toContainEqual({ path: folder, ops: [], identity: { dev: '1', ino: '42' } })
  })
})
