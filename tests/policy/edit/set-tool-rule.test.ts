import { describe, expect, test } from 'vitest'
import { MAX_SERVERS_IN_POLICY, MAX_TOOL_RULES_PER_SERVER } from '../../../src/policy/constants.js'
import { applyToolRuleToDocument } from '../../../src/policy/edit/set-tool-rule.js'
import { matchToolRule } from '../../../src/policy/match.js'
import { policyHashOf } from '../../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../../src/policy/schema.js'

/**
 * `applyToolRuleToDocument` (policy-tool-rules-ui plan §1): the one pure
 * edit the UI and `policy set` perform on `policy.json`. It writes an EXACT
 * per-tool rule (never a wildcard — an exact key beats every `prefix*` in
 * `match.ts`) into the RAW parsed document, removes it on `null`, never
 * mutates its input, refuses what the schema would refuse, and returns the
 * effective policy alongside because the document went through
 * `parsePolicy`. The first blocks feed it a defaulted `Policy` (a valid
 * document like any other); the last block pins the raw-document promise:
 * the operator's minimal file stays minimal.
 */

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function okPolicy(result: ReturnType<typeof applyToolRuleToDocument>): Policy {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`)
  return result.policy
}

describe('applyToolRuleToDocument: setting a rule', () => {
  test('adds an exact rule to a server that has none', () => {
    const next = okPolicy(applyToolRuleToDocument(policyOf(), 'github', 'create_issue', 'deny'))
    expect(next.servers?.['github']?.tools).toEqual({ create_issue: 'deny' })
  })

  test('replaces an existing exact rule and keeps the neighbours', () => {
    const before = policyOf({
      servers: { github: { tools: { create_issue: 'allow', 'delete_*': 'deny' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'require-approval'))
    expect(next.servers?.['github']?.tools).toEqual({
      create_issue: 'require-approval',
      'delete_*': 'deny',
    })
  })

  test('the exact rule it writes beats a wildcard that also matches', () => {
    const before = policyOf({ servers: { github: { tools: { 'create_*': 'allow' } } } })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'deny'))
    const match = matchToolRule(next.servers?.['github']?.tools, 'create_issue')
    expect(match).toEqual({ value: 'deny', pattern: 'create_issue' })
  })

  test('keeps defaultDecision and classOverrides of the server untouched', () => {
    const before = policyOf({
      servers: { github: { defaultDecision: 'deny', classOverrides: { get_issue: 'read' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'allow'))
    expect(next.servers?.['github']).toEqual({
      defaultDecision: 'deny',
      classOverrides: { get_issue: 'read' },
      tools: { create_issue: 'allow' },
    })
  })

  test('leaves other servers and the global sections byte-identical', () => {
    const before = policyOf({
      defaultDecision: 'deny',
      classDefaults: { read: 'allow' },
      servers: { fs: { tools: { read_file: 'allow' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'allow'))
    expect(next.servers?.['fs']).toEqual(before.servers?.['fs'])
    expect(next.defaultDecision).toBe('deny')
    expect(next.classDefaults).toEqual({ read: 'allow' })
    expect(next.approval).toEqual(before.approval)
  })

  test('never mutates the input policy', () => {
    const before = deepFreeze(policyOf({ servers: { github: { tools: { get_issue: 'allow' } } } }))
    const hashBefore = policyHashOf(before)
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'deny'))
    expect(policyHashOf(before)).toBe(hashBefore)
    expect(before.servers?.['github']?.tools).toEqual({ get_issue: 'allow' })
    expect(next).not.toBe(before)
  })

  test('the result is loadable: re-parsing it is a fixed point', () => {
    const next = okPolicy(applyToolRuleToDocument(policyOf(), 'github', 'create_issue', 'deny'))
    const reparsed = parsePolicy(next)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(policyHashOf(reparsed.policy)).toBe(policyHashOf(next))
  })

  test('changes the policy hash', () => {
    const before = policyOf()
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', 'deny'))
    expect(policyHashOf(next)).not.toBe(policyHashOf(before))
  })
})

describe('applyToolRuleToDocument: removing a rule (null)', () => {
  test('removes only the exact key and keeps a sibling wildcard', () => {
    const before = policyOf({
      servers: { github: { tools: { create_issue: 'deny', 'create_*': 'allow' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers?.['github']?.tools).toEqual({ 'create_*': 'allow' })
  })

  test('drops an emptied tools map but keeps a server that still has a defaultDecision', () => {
    const before = policyOf({
      servers: { github: { defaultDecision: 'deny', tools: { create_issue: 'allow' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers?.['github']).toEqual({ defaultDecision: 'deny' })
    expect(Object.hasOwn(next.servers?.['github'] ?? {}, 'tools')).toBe(false)
  })

  test('keeps a server that still has classOverrides', () => {
    const before = policyOf({
      servers: { github: { classOverrides: { get_issue: 'read' }, tools: { create_issue: 'allow' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers?.['github']).toEqual({ classOverrides: { get_issue: 'read' } })
  })

  test('removes a server entry that is left with nothing, and an emptied servers map', () => {
    const before = policyOf({ servers: { github: { tools: { create_issue: 'allow' } } } })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers).toBeUndefined()
    expect(Object.hasOwn(next, 'servers')).toBe(false)
  })

  test('removing one server entry keeps the other servers', () => {
    const before = policyOf({
      servers: { github: { tools: { create_issue: 'allow' } }, fs: { tools: { read_file: 'allow' } } },
    })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers).toEqual({ fs: { tools: { read_file: 'allow' } } })
  })

  test('removing a rule that does not exist is a no-op with the same hash', () => {
    const before = policyOf({ servers: { github: { tools: { 'create_*': 'allow' } } } })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(policyHashOf(next)).toBe(policyHashOf(before))
  })

  test('removing from a server with no entry is a no-op', () => {
    const before = policyOf()
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(policyHashOf(next)).toBe(policyHashOf(before))
  })

  test('null never matches a wildcard: reset of "create_issue" leaves "create_*" alone', () => {
    const before = policyOf({ servers: { github: { tools: { 'create_*': 'deny' } } } })
    const next = okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(next.servers?.['github']?.tools).toEqual({ 'create_*': 'deny' })
  })

  test('never mutates the input policy on removal', () => {
    const before = deepFreeze(policyOf({ servers: { github: { tools: { create_issue: 'deny' } } } }))
    okPolicy(applyToolRuleToDocument(before, 'github', 'create_issue', null))
    expect(before.servers?.['github']?.tools).toEqual({ create_issue: 'deny' })
  })
})

describe('applyToolRuleToDocument: name validation', () => {
  test.each(['', 'a/b', 'a b', 'x'.repeat(65), 'a*b'])(
    'rejects server name %j',
    (serverName) => {
      const result = applyToolRuleToDocument(policyOf(), serverName, 'create_issue', 'deny')
      expect(result).toMatchObject({ ok: false, reason: 'invalid-server-name' })
    },
  )

  test.each(['__proto__', 'constructor', 'prototype'])(
    'rejects reserved object key %j as a server name',
    (serverName) => {
      const result = applyToolRuleToDocument(policyOf(), serverName, 'create_issue', 'deny')
      expect(result).toMatchObject({ ok: false, reason: 'invalid-server-name' })
    },
  )

  test('accepts a proxy-generated auto:<hash> server identity', () => {
    const next = okPolicy(applyToolRuleToDocument(policyOf(), 'auto:abcdef0123456789', 'create_issue', 'deny'))
    expect(next.servers?.['auto:abcdef0123456789']?.tools).toEqual({ create_issue: 'deny' })
  })

  test.each(['', 'create_*', '*', 'a*b', 'a b', 'a/b'])('rejects tool name %j', (toolName) => {
    const result = applyToolRuleToDocument(policyOf(), 'github', toolName, 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-tool-name' })
  })

  test.each(['__proto__', 'constructor', 'prototype'])(
    'rejects reserved object key %j as a tool name',
    (toolName) => {
      const result = applyToolRuleToDocument(policyOf(), 'github', toolName, 'deny')
      expect(result).toMatchObject({ ok: false, reason: 'invalid-tool-name' })
    },
  )

  test('a wildcard is rejected on removal too: reset is always exact', () => {
    const before = policyOf({ servers: { github: { tools: { 'create_*': 'deny' } } } })
    const result = applyToolRuleToDocument(before, 'github', 'create_*', null)
    expect(result).toMatchObject({ ok: false, reason: 'invalid-tool-name' })
  })

  test('rejects an outcome the schema does not know', () => {
    const result = applyToolRuleToDocument(
      policyOf(),
      'github',
      'create_issue',
      'maybe' as unknown as 'allow',
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid-policy' })
    if (!result.ok) expect(result.message).toContain('servers.github.tools.create_issue')
  })
})

describe('applyToolRuleToDocument: limits are explicit errors, never silent truncation', () => {
  test('refuses to add a server past MAX_SERVERS_IN_POLICY', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_SERVERS_IN_POLICY }, (_, i) => [`server${i}`, {}]),
    )
    const result = applyToolRuleToDocument(policyOf({ servers }), 'one-more', 'create_issue', 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'too-many-servers' })
  })

  test('still edits an EXISTING server when the server map is full', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_SERVERS_IN_POLICY }, (_, i) => [`server${i}`, {}]),
    )
    const next = okPolicy(applyToolRuleToDocument(policyOf({ servers }), 'server0', 'create_issue', 'deny'))
    expect(next.servers?.['server0']?.tools).toEqual({ create_issue: 'deny' })
  })

  test('refuses to add a rule past MAX_TOOL_RULES_PER_SERVER', () => {
    const tools = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES_PER_SERVER }, (_, i) => [`tool${i}`, 'allow']),
    )
    const result = applyToolRuleToDocument(policyOf({ servers: { github: { tools } } }), 'github', 'one_more', 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'too-many-tool-rules' })
  })

  test('still replaces an EXISTING rule when the tools map is full', () => {
    const tools = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES_PER_SERVER }, (_, i) => [`tool${i}`, 'allow']),
    )
    const next = okPolicy(applyToolRuleToDocument(policyOf({ servers: { github: { tools } } }), 'github', 'tool0', 'deny'))
    expect(next.servers?.['github']?.tools?.['tool0']).toBe('deny')
  })

  test('removal is never blocked by a limit', () => {
    const tools = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES_PER_SERVER }, (_, i) => [`tool${i}`, 'allow']),
    )
    const next = okPolicy(applyToolRuleToDocument(policyOf({ servers: { github: { tools } } }), 'github', 'tool0', null))
    expect(Object.keys(next.servers?.['github']?.tools ?? {})).toHaveLength(MAX_TOOL_RULES_PER_SERVER - 1)
  })
})

describe('applyToolRuleToDocument: the raw document stays the operator\'s', () => {
  function okDocument(result: ReturnType<typeof applyToolRuleToDocument>): Record<string, unknown> {
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`)
    return result.document as Record<string, unknown>
  }

  test('a minimal {"version":1} gains only servers.<s>.tools.<t> — no defaults spelled out', () => {
    const document = okDocument(applyToolRuleToDocument({ version: 1 }, 'github', 'create_issue', 'deny'))
    expect(document).toEqual({ version: 1, servers: { github: { tools: { create_issue: 'deny' } } } })
    expect(Object.keys(document)).toEqual(['version', 'servers'])
  })

  test('every unrelated key the operator wrote survives verbatim, in order', () => {
    const original = {
      version: 1,
      defaultDecision: 'deny',
      approval: { timeoutMs: 1234 },
      servers: { fs: { defaultDecision: 'allow', tools: { 'read_*': 'allow' } }, github: { classOverrides: { get_issue: 'read' } } },
      toolsList: { filter: 'off' },
    }
    const document = okDocument(applyToolRuleToDocument(original, 'github', 'create_issue', 'require-approval'))
    expect(Object.keys(document)).toEqual(Object.keys(original))
    expect(document['defaultDecision']).toBe('deny')
    expect(document['approval']).toEqual({ timeoutMs: 1234 })
    expect(document['toolsList']).toEqual({ filter: 'off' })
    expect((document['servers'] as Record<string, unknown>)['fs']).toEqual(original.servers.fs)
    expect((document['servers'] as Record<string, unknown>)['github']).toEqual({
      classOverrides: { get_issue: 'read' },
      tools: { create_issue: 'require-approval' },
    })
    // The input was not touched.
    expect(original.servers.github).toEqual({ classOverrides: { get_issue: 'read' } })
  })

  test('removing the only rule of a minimal document leaves exactly {"version":1}', () => {
    const original = { version: 1, servers: { github: { tools: { create_issue: 'deny' } } } }
    const document = okDocument(applyToolRuleToDocument(original, 'github', 'create_issue', null))
    expect(document).toEqual({ version: 1 })
    expect(Object.keys(document)).toEqual(['version'])
  })

  test('the returned policy is the effective form of the returned document', () => {
    const result = applyToolRuleToDocument({ version: 1 }, 'github', 'create_issue', 'deny')
    if (!result.ok) throw new Error(result.message)
    const reparsed = parsePolicy(result.document)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(policyHashOf(reparsed.policy)).toBe(policyHashOf(result.policy))
    expect(result.policy.approval.timeoutMs).toBeGreaterThan(0)
    expect(Object.hasOwn(result.document as object, 'approval')).toBe(false)
  })

  test.each([null, 'text', 42, [1], undefined])('refuses a non-object document %j', (document) => {
    const result = applyToolRuleToDocument(document, 'github', 'create_issue', 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-policy' })
  })

  test.each([
    ['servers', { version: 1, servers: [] }],
    ['servers.github', { version: 1, servers: { github: 'deny' } }],
    ['servers.github.tools', { version: 1, servers: { github: { tools: ['create_issue'] } } }],
  ])('refuses a document whose %s is not an object', (_path, document) => {
    const result = applyToolRuleToDocument(document, 'github', 'create_issue', 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-policy' })
  })

  test('a document the schema rejects for an unrelated reason is refused, not written around', () => {
    const result = applyToolRuleToDocument({ version: 2 }, 'github', 'create_issue', 'deny')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-policy' })
    if (!result.ok) expect(result.message).toContain('version')
  })
})
