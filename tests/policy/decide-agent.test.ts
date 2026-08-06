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
    catalogObserved: false,
    catalogTrusted: true,
    ...overrides,
  }
}

describe('decide: step 0 -- agent grant (not-granted denies before everything)', () => {
  const AGENT_DENY_RULE = 'agent: no grant for github/search_index'

  test.each([
    {
      name: 'beats an active approvals grant',
      overrides: { hasActiveGrant: true },
      raw: { version: 1, defaultDecision: 'allow' },
    },
    {
      name: 'beats an explicit allow tool rule',
      overrides: {},
      raw: {
        version: 1,
        defaultDecision: 'deny',
        servers: { github: { tools: { search_index: 'allow' } } },
      },
    },
    {
      name: 'beats an allow class default',
      overrides: { toolClass: 'read' as const },
      raw: { version: 1, defaultDecision: 'deny', classDefaults: { read: 'allow' } },
    },
    {
      name: 'beats an allow server default',
      overrides: {},
      raw: {
        version: 1,
        defaultDecision: 'deny',
        servers: { github: { defaultDecision: 'allow' } },
      },
    },
    {
      name: 'beats an allow global default',
      overrides: {},
      raw: { version: 1, defaultDecision: 'allow' },
    },
    {
      name: 'fires even on an untrusted catalog (deny, not require-approval)',
      overrides: { catalogTrusted: false },
      raw: { version: 1, defaultDecision: 'allow' },
    },
    {
      name: 'fires even for a quarantined tool (deny with the agent rule, not quarantine)',
      overrides: { quarantineState: 'new' as const },
      raw: {
        version: 1,
        defaultDecision: 'allow',
        quarantine: { enabled: true, onQuarantined: 'require-approval' },
      },
    },
  ])('not-granted $name', ({ overrides, raw }) => {
    const result = decide(input({ policy: policy(raw), agentGrant: 'not-granted', ...overrides }))

    expect(result.outcome).toBe('deny')
    expect(result.rule).toBe(AGENT_DENY_RULE)
    expect(result.reason).toEqual(expect.any(String))
  })

  test('the rule string is stable and names the server and tool', () => {
    const result = decide(
      input({
        policy: policy({ version: 1, defaultDecision: 'allow' }),
        serverName: 'jira',
        toolName: 'delete_issue',
        agentGrant: 'not-granted',
      }),
    )

    expect(result.rule).toBe('agent: no grant for jira/delete_issue')
    expect(result.rule).toContain('jira')
    expect(result.rule).toContain('delete_issue')
  })
})

describe('decide: agentGrant "granted" leaves the M2 chain untouched', () => {
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
      name: 'approvals grant still allows',
      overrides: { hasActiveGrant: true, toolName: 'delete_repo', quarantineState: 'new' as const },
      expected: { outcome: 'allow', rule: 'grant' },
    },
    {
      name: 'explicit tool rule still fires',
      overrides: { toolName: 'delete_repo', quarantineState: 'changed' as const },
      expected: { outcome: 'deny', rule: 'servers.github.tools.delete_repo' },
    },
    {
      name: 'quarantine still fires',
      overrides: { toolName: 'search_index', quarantineState: 'new' as const },
      expected: { outcome: 'deny', rule: 'quarantine' },
    },
    {
      name: 'server default still fires',
      overrides: { toolName: 'search_index', toolClass: 'write' as const },
      expected: { outcome: 'require-approval', rule: 'servers.github.defaultDecision' },
    },
    {
      name: 'class default still fires on another server',
      overrides: { serverName: 'other', toolName: 'search_index', toolClass: 'write' as const },
      expected: { outcome: 'require-approval', rule: 'classDefaults.write' },
    },
    {
      name: 'global default is still the final fallback',
      overrides: { serverName: 'other', toolName: 'search_index', toolClass: 'read' as const },
      expected: { outcome: 'allow', rule: 'defaultDecision' },
    },
    {
      name: 'catalog-untrusted still fails closed (onQuarantined=deny)',
      overrides: { toolName: 'search_index', serverName: 'other', catalogTrusted: false },
      expected: { outcome: 'deny', rule: 'catalog-untrusted' },
    },
  ])('granted: $name', ({ overrides, expected }) => {
    const result = decide(input({ policy: fullPolicy, agentGrant: 'granted', ...overrides }))

    expect(result.outcome).toBe(expected.outcome)
    expect(result.rule).toBe(expected.rule)
  })
})

describe('decide: absent agentGrant is byte-for-byte M2 behavior', () => {
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
    { name: 'approvals grant', overrides: { hasActiveGrant: true } },
    { name: 'explicit tool rule', overrides: { toolName: 'delete_repo' } },
    { name: 'quarantined tool', overrides: { quarantineState: 'new' as const } },
    { name: 'server default', overrides: { toolClass: 'write' as const } },
    {
      name: 'class default',
      overrides: { serverName: 'other', toolClass: 'write' as const },
    },
    { name: 'global default', overrides: { serverName: 'other' } },
    { name: 'untrusted catalog', overrides: { catalogTrusted: false } },
  ])('absent field matches "granted" on the same input: $name', ({ overrides }) => {
    const base = input({ policy: fullPolicy, ...overrides })

    const withoutField = decide(base)
    const withGranted = decide({ ...base, agentGrant: 'granted' })

    expect(withoutField).toEqual(withGranted)
  })
})
