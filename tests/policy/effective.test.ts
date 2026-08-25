import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { decide, type DecideInput } from '../../src/policy/decide.js'
import {
  UnmappedPolicyRuleError,
  effectiveToolRule,
  hasExplicitRule,
  type EffectiveToolInput,
} from '../../src/policy/effective.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/**
 * `effectiveToolRule` is the projection the `/servers` card renders: the
 * outcome a plain view of the tool resolves to, plus WHICH rule produced it.
 * It must be a thin wrapper over `decide()` -- never a second reading of the
 * policy -- so the suite pins two things: the parity of `outcome` with
 * `decide()`, and an exhaustive mapping of every `rule:` string `decide()`
 * can emit (a rule added there must fail here, not silently mis-label).
 */

function policy(raw: unknown): Policy {
  const result = parsePolicy(raw)
  if (!result.ok) throw new Error(`invalid policy fixture: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function input(overrides: Partial<EffectiveToolInput> & { policy: Policy }): EffectiveToolInput {
  return {
    serverName: 'github',
    tool: { name: 'search_index', quarantineState: 'known' },
    ...overrides,
  }
}

const QUARANTINE_ON = { enabled: true, onQuarantined: 'require-approval' }

describe('effectiveToolRule: source per rule', () => {
  test('exact tool rule -> explicit, with the config path and the pattern', () => {
    const result = effectiveToolRule(
      input({ policy: policy({ version: 1, servers: { github: { tools: { search_index: 'deny' } } } }) }),
    )

    expect(result).toEqual({
      outcome: 'deny',
      source: 'explicit',
      rulePath: 'servers.github.tools.search_index',
      pattern: 'search_index',
      toolClass: 'write',
    })
  })

  test('trailing-glob rule -> wildcard, exposing the pattern that matched', () => {
    const result = effectiveToolRule(
      input({ policy: policy({ version: 1, servers: { github: { tools: { 'search_*': 'allow' } } } }) }),
    )

    expect(result.source).toBe('wildcard')
    expect(result.pattern).toBe('search_*')
    expect(result.rulePath).toBe('servers.github.tools.search_*')
    expect(result.outcome).toBe('allow')
  })

  test('exact rule beats a wildcard covering the same tool', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({
          version: 1,
          servers: { github: { tools: { 'search_*': 'allow', search_index: 'deny' } } },
        }),
      }),
    )

    expect(result.source).toBe('explicit')
    expect(result.pattern).toBe('search_index')
    expect(result.outcome).toBe('deny')
  })

  test('server defaultDecision -> server-default, no pattern', () => {
    const result = effectiveToolRule(
      input({ policy: policy({ version: 1, servers: { github: { defaultDecision: 'allow' } } }) }),
    )

    expect(result.source).toBe('server-default')
    expect(result.rulePath).toBe('servers.github.defaultDecision')
    expect(result.outcome).toBe('allow')
    expect(result).not.toHaveProperty('pattern')
  })

  test('classDefaults.<class> -> class-default, class taken from the descriptor', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, classDefaults: { read: 'allow', write: 'deny' } }),
        tool: {
          name: 'search_index',
          descriptor: { name: 'search_index', annotations: { readOnlyHint: true } },
          quarantineState: 'known',
        },
      }),
    )

    expect(result.source).toBe('class-default')
    expect(result.rulePath).toBe('classDefaults.read')
    expect(result.toolClass).toBe('read')
    expect(result.outcome).toBe('allow')
  })

  test('no descriptor -> classified from the bare name, exactly like the catalog fallback', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, classDefaults: { destructive: 'deny' } }),
        tool: { name: 'delete_repo', quarantineState: 'known' },
      }),
    )

    expect(result.toolClass).toBe('destructive')
    expect(result.source).toBe('class-default')
    expect(result.outcome).toBe('deny')
  })

  test('per-server classOverrides are honored, as the gate does', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({
          version: 1,
          classDefaults: { read: 'allow', write: 'require-approval' },
          servers: { github: { classOverrides: { search_index: 'read' } } },
        }),
      }),
    )

    expect(result.toolClass).toBe('read')
    expect(result.outcome).toBe('allow')
  })

  test('top-level defaultDecision -> global-default', () => {
    const result = effectiveToolRule(input({ policy: policy({ version: 1, defaultDecision: 'deny' }) }))

    expect(result).toEqual({
      outcome: 'deny',
      source: 'global-default',
      rulePath: 'defaultDecision',
      toolClass: 'write',
    })
  })

  test.each(['new', 'changed'] as const)('quarantine state %s -> quarantine', (quarantineState) => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, defaultDecision: 'allow', quarantine: { enabled: true, onQuarantined: 'deny' } }),
        tool: { name: 'search_index', quarantineState },
      }),
    )

    expect(result.source).toBe('quarantine')
    expect(result.rulePath).toBe('quarantine')
    expect(result.outcome).toBe('deny')
  })

  test('unknown state after the catalog was observed -> shadow-tool (a plain view has seen the catalog)', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, defaultDecision: 'allow', quarantine: QUARANTINE_ON }),
        tool: { name: 'ghost', quarantineState: 'unknown' },
      }),
    )

    expect(result.source).toBe('shadow-tool')
    expect(result.rulePath).toBe('shadow-tool')
    expect(result.outcome).toBe('require-approval')
  })

  test('explicit allow withdrawn by a widened surface -> surface-changed, pattern still named', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, quarantine: QUARANTINE_ON, servers: { github: { tools: { search_index: 'allow' } } } }),
        tool: { name: 'search_index', quarantineState: 'changed', surfaceDelta: 'widened' },
      }),
    )

    expect(result.source).toBe('surface-changed')
    expect(result.rulePath).toBe('surface-changed')
    expect(result.outcome).toBe('require-approval')
    expect(result).not.toHaveProperty('pattern')
  })

  test('explicit allow survives a narrowed surface -> still explicit', () => {
    const result = effectiveToolRule(
      input({
        policy: policy({ version: 1, quarantine: QUARANTINE_ON, servers: { github: { tools: { search_index: 'allow' } } } }),
        tool: { name: 'search_index', quarantineState: 'changed', surfaceDelta: 'narrowed' },
      }),
    )

    expect(result.source).toBe('explicit')
    expect(result.outcome).toBe('allow')
  })

  test('a server name containing dots does not confuse path parsing', () => {
    const result = effectiveToolRule(
      input({
        serverName: 'acme.internal',
        policy: policy({ version: 1, servers: { 'acme.internal': { tools: { 'fs.*': 'deny' } } } }),
        tool: { name: 'fs.read', quarantineState: 'known' },
      }),
    )

    expect(result.source).toBe('wildcard')
    expect(result.pattern).toBe('fs.*')
    expect(result.rulePath).toBe('servers.acme.internal.tools.fs.*')
  })
})

describe('effectiveToolRule: parity with decide()', () => {
  const policies: readonly Policy[] = [
    policy({ version: 1 }),
    policy({ version: 1, defaultDecision: 'deny' }),
    policy({ version: 1, classDefaults: { read: 'allow', write: 'require-approval', destructive: 'deny' } }),
    policy({ version: 1, servers: { github: { defaultDecision: 'allow' } } }),
    policy({ version: 1, servers: { github: { tools: { 'search_*': 'allow', delete_repo: 'deny' } } } }),
    policy({ version: 1, quarantine: { enabled: false }, servers: { github: { tools: { search_index: 'allow' } } } }),
    policy({ version: 1, quarantine: { enabled: true, onQuarantined: 'deny' }, servers: { github: { tools: { search_index: 'allow' } } } }),
  ]
  const tools: readonly EffectiveToolInput['tool'][] = [
    { name: 'search_index', quarantineState: 'known', descriptor: { name: 'search_index', annotations: { readOnlyHint: true } } },
    { name: 'search_index', quarantineState: 'changed', surfaceDelta: 'widened' },
    { name: 'search_index', quarantineState: 'changed', surfaceDelta: 'neutral' },
    { name: 'search_index', quarantineState: 'changed' },
    { name: 'search_index', quarantineState: 'new' },
    { name: 'delete_repo', quarantineState: 'known' },
    { name: 'ghost', quarantineState: 'unknown' },
  ]

  test('outcome always equals decide() on the gate-shaped input for a plain view', () => {
    for (const p of policies) {
      for (const tool of tools) {
        const effective = effectiveToolRule({ policy: p, serverName: 'github', tool })
        const decideInput: DecideInput = {
          policy: p,
          serverName: 'github',
          toolName: tool.name,
          toolClass: effective.toolClass,
          quarantineState: tool.quarantineState,
          hasActiveGrant: false,
          catalogObserved: true,
          catalogTrusted: true,
          ...(tool.surfaceDelta !== undefined ? { surfaceDelta: tool.surfaceDelta } : {}),
        }
        const decision = decide(decideInput)

        expect(effective.outcome, `${JSON.stringify(tool)} under ${decision.rule}`).toBe(decision.outcome)
      }
    }
  })
})

describe('effectiveToolRule: exhaustive over the rule strings decide() can produce', () => {
  /**
   * Every `rule:` expression in `decide.ts`, as written in source. A rule
   * added to `decide()` shows up here and fails the assertion below until it
   * is either mapped to a source or listed as unreachable for a plain view.
   */
  const RULE_EXPRESSIONS_IN_DECIDE = readFileSync(new URL('../../src/policy/decide.ts', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => /^\s*rule:\s*(.+?),?\s*$/.exec(line)?.[1])
    .filter((expression): expression is string => expression !== undefined)
    .sort()

  const MAPPED = [
    "'defaultDecision'",
    "`classDefaults.${input.toolClass}`",
    "`servers.${input.serverName}.defaultDecision`",
    'SURFACE_CHANGED_RULE',
    "isShadow ? 'shadow-tool' : 'quarantine'",
    'path',
  ]
  /** Never fire for a plain view: the input is built with no grant, no agent, a trusted catalog. */
  const UNREACHABLE_FOR_PLAIN_VIEW = [
    "'catalog-untrusted'",
    "'grant'",
    '`agent: no grant for ${input.serverName}/${input.toolName}`',
  ]

  test('every rule expression in decide.ts is either mapped or documented as unreachable', () => {
    expect(RULE_EXPRESSIONS_IN_DECIDE).toEqual([...MAPPED, ...UNREACHABLE_FOR_PLAIN_VIEW].sort())
  })

  test('a rule string the mapping does not know is a loud error, never a mislabel', () => {
    expect(() =>
      effectiveToolRule(
        input({ policy: policy({ version: 1 }) }),
        { decideFn: () => ({ outcome: 'allow', rule: 'brand-new-rule', reason: 'x' }) },
      ),
    ).toThrow(UnmappedPolicyRuleError)
  })
})

describe('hasExplicitRule', () => {
  const p = policy({ version: 1, servers: { github: { tools: { search_index: 'deny', 'fs_*': 'allow' } } } })

  test('true only for an exact key under servers.<name>.tools', () => {
    expect(hasExplicitRule(p, 'github', 'search_index')).toBe(true)
  })

  test('a wildcard that covers the tool is not an explicit rule', () => {
    expect(hasExplicitRule(p, 'github', 'fs_read')).toBe(false)
  })

  test('the wildcard key itself counts as explicit for its own literal name', () => {
    expect(hasExplicitRule(p, 'github', 'fs_*')).toBe(true)
  })

  test('false for an unknown server, a server without tools, and a prototype key', () => {
    expect(hasExplicitRule(p, 'gitlab', 'search_index')).toBe(false)
    expect(hasExplicitRule(policy({ version: 1, servers: { github: {} } }), 'github', 'search_index')).toBe(false)
    expect(hasExplicitRule(p, 'github', 'toString')).toBe(false)
  })
})
