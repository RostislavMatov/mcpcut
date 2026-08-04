import { describe, expect, test } from 'vitest'
import { parsePolicy, policySchema } from '../../src/policy/schema.js'
import { MAX_SERVERS_IN_POLICY, MAX_TOOL_RULES_PER_SERVER } from '../../src/policy/constants.js'

describe('parsePolicy', () => {
  test('accepts the minimal valid config', () => {
    const result = parsePolicy({ version: 1 })

    expect(result.ok).toBe(true)
  })

  test('accepts a fully populated valid config', () => {
    const result = parsePolicy({
      version: 1,
      defaultDecision: 'deny',
      classDefaults: { read: 'allow', write: 'require-approval', destructive: 'deny' },
      quarantine: { enabled: false, onQuarantined: 'deny' },
      toolsList: { filter: 'off' },
      approval: { timeoutMs: 30_000, onTimeout: 'deny', grantTtlMs: 120_000 },
      journal: { failClosed: true },
      servers: {
        github: {
          defaultDecision: 'allow',
          classOverrides: { 'delete_*': 'destructive', read_file: 'read' },
          tools: { create_issue: 'allow', 'delete_*': 'require-approval' },
        },
        'auto:0123456789ab': {
          tools: { 'admin_*': 'deny' },
        },
      },
    })

    expect(result.ok).toBe(true)
  })

  test('rejects an unknown top-level key with the exact path', () => {
    const result = parsePolicy({ version: 1, extraTopLevelField: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    const issue = result.error.issues[0]
    expect(issue.code).toBe('unrecognized_keys')
    expect(issue.path).toEqual([])
    expect((issue as { keys: string[] }).keys).toEqual(['extraTopLevelField'])
  })

  test('rejects an unknown nested key (typo: tols instead of tools)', () => {
    const result = parsePolicy({
      version: 1,
      servers: { github: { tols: { create_issue: 'allow' } } },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    const issue = result.error.issues[0]
    expect(issue.code).toBe('unrecognized_keys')
    expect(issue.path).toEqual(['servers', 'github'])
    expect((issue as { keys: string[] }).keys).toEqual(['tols'])
  })

  test('rejects version 2', () => {
    const result = parsePolicy({ version: 2 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues[0].path).toEqual(['version'])
  })

  test('rejects an unknown outcome value', () => {
    const result = parsePolicy({ version: 1, defaultDecision: 'maybe' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues[0].path).toEqual(['defaultDecision'])
  })

  test('rejects an unknown class value in classDefaults', () => {
    const result = parsePolicy({ version: 1, classDefaults: { read: 'not-an-outcome' } })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues[0].path).toEqual(['classDefaults', 'read'])
  })

  test('rejects a tool rule name with a mid-name wildcard', () => {
    const result = parsePolicy({
      version: 1,
      servers: { github: { tools: { 'a*b': 'allow' } } },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.some((i) => i.path.includes('a*b'))).toBe(true)
  })

  test('accepts a tool rule name with a single trailing wildcard', () => {
    const result = parsePolicy({
      version: 1,
      servers: { github: { tools: { 'delete_*': 'deny' } } },
    })

    expect(result.ok).toBe(true)
  })

  test('rejects a server name that does not match the allowed pattern', () => {
    const result = parsePolicy({
      version: 1,
      servers: { 'bad name with spaces': { tools: {} } },
    })

    expect(result.ok).toBe(false)
  })

  test('rejects more than MAX_SERVERS_IN_POLICY server entries', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_SERVERS_IN_POLICY + 1 }, (_, i) => [`server${i}`, {}]),
    )

    const result = parsePolicy({ version: 1, servers })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.some((i) => i.path.includes('servers'))).toBe(true)
  })

  test('accepts exactly MAX_SERVERS_IN_POLICY server entries', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_SERVERS_IN_POLICY }, (_, i) => [`server${i}`, {}]),
    )

    const result = parsePolicy({ version: 1, servers })

    expect(result.ok).toBe(true)
  })

  test('rejects more than MAX_TOOL_RULES_PER_SERVER tool rules for one server', () => {
    const tools = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES_PER_SERVER + 1 }, (_, i) => [`tool${i}`, 'allow']),
    )

    const result = parsePolicy({ version: 1, servers: { github: { tools } } })

    expect(result.ok).toBe(false)
  })

  describe('defaults', () => {
    test('applies every documented default when only version is given', () => {
      const result = parsePolicy({ version: 1 })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.policy.defaultDecision).toBe('require-approval')
      expect(result.policy.quarantine.enabled).toBe(true)
      expect(result.policy.quarantine.onQuarantined).toBe('require-approval')
      expect(result.policy.toolsList.filter).toBe('hide-denied')
      expect(result.policy.approval.timeoutMs).toBe(60_000)
      expect(result.policy.approval.onTimeout).toBe('deny')
      expect(result.policy.approval.grantTtlMs).toBe(300_000)
      expect(result.policy.journal.failClosed).toBe(false)
    })
  })

  describe('edge cases', () => {
    test('rejects null', () => {
      expect(parsePolicy(null).ok).toBe(false)
    })

    test('rejects an array', () => {
      expect(parsePolicy([]).ok).toBe(false)
    })

    test('rejects a missing version field', () => {
      expect(parsePolicy({}).ok).toBe(false)
    })

    test('rejects a non-positive approval.timeoutMs', () => {
      const result = parsePolicy({ version: 1, approval: { timeoutMs: 0 } })

      expect(result.ok).toBe(false)
    })

    test('rejects a non-integer approval.grantTtlMs', () => {
      const result = parsePolicy({ version: 1, approval: { grantTtlMs: 1.5 } })

      expect(result.ok).toBe(false)
    })

    test('rejects approval.onTimeout values other than "deny"', () => {
      const result = parsePolicy({ version: 1, approval: { onTimeout: 'allow' } })

      expect(result.ok).toBe(false)
    })

    test('never throws on structurally hostile input', () => {
      expect(() => parsePolicy(undefined)).not.toThrow()
      expect(() => parsePolicy('not an object')).not.toThrow()
      expect(() => parsePolicy(42)).not.toThrow()
    })
  })
})

describe('policySchema', () => {
  test('is exported for callers that need the raw zod schema', () => {
    expect(policySchema.safeParse({ version: 1 }).success).toBe(true)
  })
})
