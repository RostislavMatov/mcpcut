import { describe, expect, test } from 'vitest'
import { decide, type DecideInput } from '../../src/policy/decide.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/** Parses a raw policy fixture and unwraps it, failing loudly if invalid. */
function policy(raw: unknown): Policy {
  const result = parsePolicy(raw)
  if (!result.ok) {
    throw new Error(`invalid policy fixture: ${JSON.stringify(result.error.issues)}`)
  }
  return result.policy
}

/** Base input with every field explicit; tests override only what they need. */
function input(overrides: Partial<DecideInput> & { policy: Policy }): DecideInput {
  return {
    serverName: 'github',
    toolName: 'search_index',
    toolClass: 'read',
    quarantineState: 'known',
    hasActiveGrant: false,
    ...overrides,
  }
}

describe('decide: step 1 -- active grant', () => {
  test('an active grant allows, short-circuiting everything else', () => {
    const result = decide(
      input({
        policy: policy({ version: 1, defaultDecision: 'deny' }),
        hasActiveGrant: true,
      }),
    )

    expect(result).toEqual({
      outcome: 'allow',
      rule: 'grant',
      reason: expect.stringContaining('grant'),
    })
  })

  test('an active grant beats an explicit deny tool rule', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          servers: { github: { tools: { search_index: 'deny' } } },
        }),
        hasActiveGrant: true,
      }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('grant')
  })

  test('an active grant beats an enabled quarantine on a new tool', () => {
    const result = decide(
      input({
        policy: policy({ version: 1, quarantine: { enabled: true, onQuarantined: 'deny' } }),
        hasActiveGrant: true,
        quarantineState: 'new',
      }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('grant')
  })
})

describe('decide: step 2 -- server tool rule', () => {
  test('exact tool rule wins with the expected rule string', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          servers: { github: { tools: { search_index: 'deny' } } },
        }),
      }),
    )

    expect(result).toEqual({
      outcome: 'deny',
      rule: 'servers.github.tools.search_index',
      reason: expect.any(String),
    })
  })

  test('glob tool rule wins with the pattern (not the tool name) in the rule string', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          servers: { github: { tools: { 'search_*': 'require-approval' } } },
        }),
      }),
    )

    expect(result).toEqual({
      outcome: 'require-approval',
      rule: 'servers.github.tools.search_*',
      reason: expect.any(String),
    })
  })

  test('an explicit allow tool rule beats an enabled quarantine on a new tool', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'deny' },
          servers: { github: { tools: { search_index: 'allow' } } },
        }),
        quarantineState: 'new',
      }),
    )

    expect(result.outcome).toBe('allow')
    expect(result.rule).toBe('servers.github.tools.search_index')
  })

  test('a tool rule on a different server does not apply', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'deny',
          servers: { other: { tools: { search_index: 'allow' } } },
        }),
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('deny')
  })
})

describe('decide: step 3 -- quarantine', () => {
  test('quarantine state "new" resolves to onQuarantined (require-approval) and names the state', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'require-approval' },
        }),
        quarantineState: 'new',
      }),
    )

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe('quarantine')
    expect(result.reason).toContain('new')
  })

  test('quarantine state "changed" resolves to onQuarantined (deny) and names the state', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          quarantine: { enabled: true, onQuarantined: 'deny' },
        }),
        quarantineState: 'changed',
      }),
    )

    expect(result.outcome).toBe('deny')
    expect(result.rule).toBe('quarantine')
    expect(result.reason).toContain('changed')
  })

  test('quarantine disabled skips straight to defaults even for a "new" tool', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'allow',
          quarantine: { enabled: false, onQuarantined: 'deny' },
        }),
        quarantineState: 'new',
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('allow')
  })

  test('quarantine state "known" does not trigger quarantine even when enabled', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'allow',
          quarantine: { enabled: true, onQuarantined: 'deny' },
        }),
        quarantineState: 'known',
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('allow')
  })

  test('quarantine state "unknown" falls through to defaults, not quarantine (inventory has not observed tools/list yet)', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'allow',
          quarantine: { enabled: true, onQuarantined: 'deny' },
        }),
        quarantineState: 'unknown',
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('allow')
  })
})

describe('decide: step 4 -- server default decision', () => {
  test('server default decision applies with the expected rule string', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'deny',
          servers: { github: { defaultDecision: 'require-approval' } },
        }),
      }),
    )

    expect(result).toEqual({
      outcome: 'require-approval',
      rule: 'servers.github.defaultDecision',
      reason: expect.any(String),
    })
  })

  test('a server default on a different server does not apply', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'deny',
          servers: { other: { defaultDecision: 'allow' } },
        }),
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('deny')
  })
})

describe('decide: step 5 -- class defaults', () => {
  test.each([
    ['read', 'allow'],
    ['write', 'require-approval'],
    ['destructive', 'deny'],
  ] as const)('classDefaults.%s applies with the expected rule string', (toolClass, outcome) => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'allow',
          classDefaults: { [toolClass]: outcome },
        }),
        toolClass,
      }),
    )

    expect(result).toEqual({
      outcome,
      rule: `classDefaults.${toolClass}`,
      reason: expect.any(String),
    })
  })

  test('a class default only for a different class does not apply', () => {
    const result = decide(
      input({
        policy: policy({
          version: 1,
          defaultDecision: 'deny',
          classDefaults: { destructive: 'deny' },
        }),
        toolClass: 'read',
      }),
    )

    expect(result.rule).toBe('defaultDecision')
    expect(result.outcome).toBe('deny')
  })
})

describe('decide: step 6 -- global default decision', () => {
  test.each(['allow', 'deny', 'require-approval'] as const)(
    'defaultDecision "%s" applies when nothing more specific matches',
    (outcome) => {
      const result = decide(
        input({
          policy: policy({ version: 1, defaultDecision: outcome }),
        }),
      )

      expect(result).toEqual({
        outcome,
        rule: 'defaultDecision',
        reason: expect.any(String),
      })
    },
  )

  test('the built-in schema default (require-approval) applies when defaultDecision is omitted entirely', () => {
    const result = decide(input({ policy: policy({ version: 1 }) }))

    expect(result.outcome).toBe('require-approval')
    expect(result.rule).toBe('defaultDecision')
  })
})

describe('decide: full precedence matrix (table-driven)', () => {
  const fullPolicy = policy({
    version: 1,
    defaultDecision: 'allow',
    classDefaults: { write: 'require-approval' },
    quarantine: { enabled: true, onQuarantined: 'deny' },
    servers: {
      github: {
        defaultDecision: 'require-approval',
        tools: { delete_repo: 'deny' },
      },
    },
  })

  test.each([
    {
      name: 'grant beats everything',
      overrides: { hasActiveGrant: true, toolName: 'delete_repo', quarantineState: 'new' as const },
      expected: { outcome: 'allow', rule: 'grant' },
    },
    {
      name: 'explicit tool rule beats quarantine and server default',
      overrides: { toolName: 'delete_repo', quarantineState: 'changed' as const },
      expected: { outcome: 'deny', rule: 'servers.github.tools.delete_repo' },
    },
    {
      name: 'quarantine beats server default',
      overrides: { toolName: 'search_index', quarantineState: 'new' as const },
      expected: { outcome: 'deny', rule: 'quarantine' },
    },
    {
      name: 'server default beats class default',
      overrides: { toolName: 'search_index', toolClass: 'write' as const },
      expected: { outcome: 'require-approval', rule: 'servers.github.defaultDecision' },
    },
    {
      name: 'class default beats global default on a different server',
      overrides: { serverName: 'other', toolName: 'search_index', toolClass: 'write' as const },
      expected: { outcome: 'require-approval', rule: 'classDefaults.write' },
    },
    {
      name: 'global default is the final fallback',
      overrides: { serverName: 'other', toolName: 'search_index', toolClass: 'read' as const },
      expected: { outcome: 'allow', rule: 'defaultDecision' },
    },
  ])('$name', ({ overrides, expected }) => {
    const result = decide(input({ policy: fullPolicy, ...overrides }))

    expect(result.outcome).toBe(expected.outcome)
    expect(result.rule).toBe(expected.rule)
  })
})
