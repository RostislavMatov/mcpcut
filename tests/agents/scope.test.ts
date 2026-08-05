import { describe, expect, test } from 'vitest'
import { agentScope } from '../../src/agents/scope.js'
import type { AgentRecord } from '../../src/agents/schema.js'

const HASH = 'f'.repeat(64)
const CREATED = '2026-08-05T10:00:00.000Z'

function agentWith(
  tools: readonly string[] | '*',
  extra: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    name: 'research-bot',
    tokenHash: HASH,
    createdAt: CREATED,
    grants: { github: { tools: tools === '*' ? '*' : [...tools] } },
    ...extra,
  }
}

describe('agentScope: grant shapes', () => {
  test("'*' grants every tool", () => {
    const scope = agentScope(agentWith('*'), 'github')

    expect(scope.isGranted('anything_at_all')).toBe(true)
    expect(scope.filterVisible(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('no grant for the server → nothing granted, nothing visible', () => {
    const scope = agentScope(agentWith('*'), 'jira')

    expect(scope.isGranted('get_issue')).toBe(false)
    expect(scope.filterVisible(['get_issue'])).toEqual([])
  })

  test('an empty tools array grants nothing', () => {
    const scope = agentScope(agentWith([]), 'github')

    expect(scope.isGranted('get_issue')).toBe(false)
  })

  test('a revoked agent has NOTHING granted, even with a wildcard grant', () => {
    const revoked = agentWith('*', { revokedAt: '2026-08-06T00:00:00.000Z' })

    const scope = agentScope(revoked, 'github')

    expect(scope.isGranted('get_issue')).toBe(false)
    expect(scope.filterVisible(['get_issue', 'list_issues'])).toEqual([])
  })
})

/**
 * Table mirroring `tests/policy/match.ts` semantics: exact name or a single
 * trailing `*` prefix glob; a pattern without `*` never behaves as a glob.
 */
describe('agentScope: pattern semantics mirror policy/match.ts', () => {
  test.each<[patterns: string[], tool: string, granted: boolean]>([
    // exact match
    [['list_issues'], 'list_issues', true],
    [['list_issues'], 'list_issue', false],
    [['list_issues'], 'list_issues_x', false],
    // trailing-glob prefix match
    [['get_*'], 'get_issue', true],
    [['get_*'], 'get_', true],
    [['get_*'], 'get', false],
    [['get_*'], 'forget_it', false],
    // bare-star-suffix edge: 'x*' matches anything starting with x
    [['x*'], 'x', true],
    [['x*'], 'xylophone', true],
    // several patterns: any hit grants
    [['get_*', 'list_issues'], 'list_issues', true],
    [['get_*', 'list_issues'], 'get_repo', true],
    [['get_*', 'list_issues'], 'delete_repo', false],
    // a literal (no star) is never a prefix glob
    [['get'], 'get_issue', false],
    // case-sensitive, like policy matching
    [['Get_*'], 'get_issue', false],
  ])('patterns %j, tool %j → granted=%s', (patterns, tool, granted) => {
    const scope = agentScope(agentWith(patterns), 'github')

    expect(scope.isGranted(tool)).toBe(granted)
  })

  test('filterVisible keeps input order and drops non-granted tools', () => {
    const scope = agentScope(agentWith(['get_*', 'list_issues']), 'github')

    const visible = scope.filterVisible(['delete_repo', 'get_repo', 'list_issues', 'get_issue'])

    expect(visible).toEqual(['get_repo', 'list_issues', 'get_issue'])
  })

  test('filterVisible on an empty input → empty output', () => {
    const scope = agentScope(agentWith('*'), 'github')

    expect(scope.filterVisible([])).toEqual([])
  })
})

describe('agentScope: hostile tool names', () => {
  test('a tool literally named __proto__ in the CATALOG never pollutes and is not granted by unrelated patterns', () => {
    const scope = agentScope(agentWith(['get_*']), 'github')

    expect(scope.isGranted('__proto__')).toBe(false)
    expect(scope.isGranted('constructor')).toBe(false)
    expect(({} as { granted?: unknown }).granted).toBeUndefined()
  })
})
