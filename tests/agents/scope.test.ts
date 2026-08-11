import { describe, expect, test } from 'vitest'
import { agentScope } from '../../src/agents/scope.js'
import type { AgentGrant, AgentRecord } from '../../src/agents/schema.js'

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

/** Record with one grant for `github`, built from a full grant object (M4). */
function agentWithGrant(grant: AgentGrant, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'research-bot',
    tokenHash: HASH,
    createdAt: CREATED,
    grants: { github: grant },
    ...extra,
  }
}

describe('agentScope.methodGrants: defaults are M3 fail-closed', () => {
  test('absent resources/prompts fields grant nothing and report no grant presence', () => {
    const scope = agentScope(agentWithGrant({ tools: '*' }), 'github')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(false)
    expect(scope.methodGrants.hasPromptsGrant()).toBe(false)
    expect(scope.methodGrants.isResourceGranted('file:///project/readme.md')).toBe(false)
    expect(scope.methodGrants.isPromptGranted('greeting')).toBe(false)
  })

  test('empty arrays are equivalent to absent fields (no grant presence)', () => {
    const scope = agentScope(agentWithGrant({ tools: '*', resources: [], prompts: [] }), 'github')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(false)
    expect(scope.methodGrants.hasPromptsGrant()).toBe(false)
    expect(scope.methodGrants.isResourceGranted('file:///anything')).toBe(false)
  })

  test('a tools grant never bleeds into resources or prompts', () => {
    const scope = agentScope(agentWithGrant({ tools: '*' }), 'github')

    expect(scope.isGranted('any_tool')).toBe(true)
    expect(scope.methodGrants.isResourceGranted('file:///x')).toBe(false)
    expect(scope.methodGrants.isPromptGranted('any_tool')).toBe(false)
  })

  test('no grant for the server → no method grants either', () => {
    const scope = agentScope(agentWithGrant({ tools: '*', resources: '*', prompts: '*' }), 'jira')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(false)
    expect(scope.methodGrants.hasPromptsGrant()).toBe(false)
  })
})

describe('agentScope.methodGrants: resources', () => {
  test("'*' grants every URI and counts as grant presence", () => {
    const scope = agentScope(agentWithGrant({ tools: [], resources: '*' }), 'github')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(true)
    expect(scope.methodGrants.isResourceGranted('file:///etc/passwd')).toBe(true)
    expect(scope.methodGrants.isResourceGranted('doc://anything')).toBe(true)
  })

  test.each<[patterns: string[], uri: string, granted: boolean]>([
    // trailing-glob prefix match, same matcher as tools
    [['file:///project/*'], 'file:///project/readme.md', true],
    [['file:///project/*'], 'file:///project/sub/deep.txt', true],
    [['file:///project/*'], 'file:///projects/readme.md', false],
    [['file:///project/*'], 'file:///etc/passwd', false],
    // exact match
    [['doc://handbook'], 'doc://handbook', true],
    [['doc://handbook'], 'doc://handbook2', false],
    // a literal (no star) is never a prefix glob
    [['file:///project/'], 'file:///project/readme.md', false],
    // several patterns: any hit grants
    [['doc://a', 'file:///p/*'], 'file:///p/x', true],
    [['doc://a', 'file:///p/*'], 'doc://b', false],
    // case-sensitive
    [['File:///Project/*'], 'file:///project/x', false],
  ])('resources %j, uri %j → granted=%s', (patterns, uri, granted) => {
    const scope = agentScope(agentWithGrant({ tools: [], resources: patterns }), 'github')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(true)
    expect(scope.methodGrants.isResourceGranted(uri)).toBe(granted)
  })
})

describe('agentScope.methodGrants: prompts (same matcher semantics as tools)', () => {
  test.each<[patterns: string[], name: string, granted: boolean]>([
    [['greeting'], 'greeting', true],
    [['greeting'], 'greeting2', false],
    [['greet*'], 'greeting', true],
    [['greet*'], 'greet', true],
    [['greet*'], 'regret', false],
    [['Greet*'], 'greeting', false],
  ])('prompts %j, name %j → granted=%s', (patterns, name, granted) => {
    const scope = agentScope(agentWithGrant({ tools: [], prompts: patterns }), 'github')

    expect(scope.methodGrants.hasPromptsGrant()).toBe(true)
    expect(scope.methodGrants.isPromptGranted(name)).toBe(granted)
  })

  test("prompts '*' grants every name", () => {
    const scope = agentScope(agentWithGrant({ tools: [], prompts: '*' }), 'github')

    expect(scope.methodGrants.isPromptGranted('anything')).toBe(true)
  })
})

describe('agentScope.methodGrants: revoked agent', () => {
  test('a revoked agent has NO method grants, even with wildcard grants', () => {
    const revoked = agentWithGrant(
      { tools: '*', resources: '*', prompts: '*' },
      { revokedAt: '2026-08-06T00:00:00.000Z' },
    )

    const scope = agentScope(revoked, 'github')

    expect(scope.methodGrants.hasResourcesGrant()).toBe(false)
    expect(scope.methodGrants.hasPromptsGrant()).toBe(false)
    expect(scope.methodGrants.isResourceGranted('file:///x')).toBe(false)
    expect(scope.methodGrants.isPromptGranted('greeting')).toBe(false)
  })
})

describe('agentScope.methodGrants: hostile subjects', () => {
  test('reserved names as URI/prompt subjects never pollute and are not granted', () => {
    const scope = agentScope(
      agentWithGrant({ tools: [], resources: ['file:///p/*'], prompts: ['greet*'] }),
      'github',
    )

    expect(scope.methodGrants.isResourceGranted('__proto__')).toBe(false)
    expect(scope.methodGrants.isPromptGranted('__proto__')).toBe(false)
    expect(scope.methodGrants.isPromptGranted('constructor')).toBe(false)
    expect(({} as { granted?: unknown }).granted).toBeUndefined()
  })
})
