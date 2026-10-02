import { describe, expect, test } from 'vitest'
import { MAX_CONFIRM_AGENTS, MAX_SERVERS_IN_POLICY, MAX_TOOL_RULES_PER_SERVER } from '../../../src/policy/constants.js'
import { applyConfirmInClientToDocument } from '../../../src/policy/edit/set-confirm-in-client.js'
import { isConfirmInClient } from '../../../src/policy/confirm-in-client.js'

/**
 * `applyConfirmInClientToDocument`: the pure edit behind the per-tool
 * "client" control. Sets or clears the EXACT key under
 * `servers.<server>.confirmInClient` in the RAW document, never touches any
 * other key, never mutates its input and never returns what `parsePolicy`
 * would refuse.
 */

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function okDocument(result: ReturnType<typeof applyConfirmInClientToDocument>): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`)
  return result.document
}

describe('setting the agents of a tool', () => {
  test('creates servers, the server entry and confirmInClient in a minimal document', () => {
    const next = okDocument(applyConfirmInClientToDocument({ version: 1 }, 'github', 'create_issue', ['laptop']))
    expect(next).toEqual({ version: 1, servers: { github: { confirmInClient: { create_issue: ['laptop'] } } } })
  })

  test('keeps the tools rule, the neighbours and every other key as written', () => {
    const before = {
      version: 1,
      classDefaults: { write: 'require-approval' },
      servers: { github: { tools: { create_issue: 'allow' }, confirmInClient: { 'write_*': ['*'] } }, other: {} },
    }
    const next = okDocument(applyConfirmInClientToDocument(before, 'github', 'create_issue', ['b', 'a']))
    expect(next).toEqual({
      version: 1,
      classDefaults: { write: 'require-approval' },
      servers: {
        github: { tools: { create_issue: 'allow' }, confirmInClient: { 'write_*': ['*'], create_issue: ['b', 'a'] } },
        other: {},
      },
    })
  })

  test('dedupes agent names, first occurrence wins', () => {
    const next = okDocument(applyConfirmInClientToDocument({ version: 1 }, 's', 't', ['a', 'b', 'a']))
    expect(next).toEqual({ version: 1, servers: { s: { confirmInClient: { t: ['a', 'b'] } } } })
  })

  test('"*" among names stores just ["*"]', () => {
    const next = okDocument(applyConfirmInClientToDocument({ version: 1 }, 's', 't', ['a', '*', 'b']))
    expect(next).toEqual({ version: 1, servers: { s: { confirmInClient: { t: ['*'] } } } })
  })

  test('an exact key only adds agents: it never narrows a pattern that also matches', () => {
    const before = { version: 1, servers: { s: { confirmInClient: { 'write_*': ['ci'] } } } }
    const result = applyConfirmInClientToDocument(before, 's', 'write_file', ['laptop'])
    if (!result.ok) throw new Error(result.message)
    expect(isConfirmInClient(result.policy, 's', 'write_file', 'laptop')).toBe(true)
    expect(isConfirmInClient(result.policy, 's', 'write_file', 'ci')).toBe(true)
    expect(isConfirmInClient(result.policy, 's', 'write_file', 'other')).toBe(false)
    expect(isConfirmInClient(result.policy, 's', 'write_other', 'ci')).toBe(true)
  })

  test('never mutates its input', () => {
    const before = deepFreeze({ version: 1, servers: { s: { confirmInClient: { t: ['a'] } } } })
    expect(() => applyConfirmInClientToDocument(before, 's', 't', ['b'])).not.toThrow()
    expect(before.servers.s.confirmInClient.t).toEqual(['a'])
  })

  test('returns the parsed policy alongside the document', () => {
    const result = applyConfirmInClientToDocument({ version: 1 }, 's', 't', ['*'])
    expect(result.ok && result.policy.servers?.['s']?.confirmInClient).toEqual({ t: ['*'] })
  })
})

describe('clearing (null)', () => {
  test('removes only the exact key', () => {
    const before = { version: 1, servers: { s: { confirmInClient: { t: ['a'], 'w_*': ['*'] } } } }
    expect(okDocument(applyConfirmInClientToDocument(before, 's', 't', null))).toEqual({
      version: 1,
      servers: { s: { confirmInClient: { 'w_*': ['*'] } } },
    })
  })

  test('drops an emptied confirmInClient but keeps a server that still has other keys', () => {
    const before = { version: 1, servers: { s: { tools: { t: 'deny' }, confirmInClient: { t: ['a'] } } } }
    expect(okDocument(applyConfirmInClientToDocument(before, 's', 't', null))).toEqual({
      version: 1,
      servers: { s: { tools: { t: 'deny' } } },
    })
  })

  test('prunes the server entry and servers when nothing is left', () => {
    const before = { version: 1, servers: { s: { confirmInClient: { t: ['a'] } } } }
    expect(okDocument(applyConfirmInClientToDocument(before, 's', 't', null))).toEqual({ version: 1 })
  })

  test('is a no-op when the key is absent', () => {
    const before = { version: 1, servers: { s: { confirmInClient: { u: ['a'] } } } }
    expect(okDocument(applyConfirmInClientToDocument(before, 's', 't', null))).toEqual(before)
  })
})

describe('refusals', () => {
  test.each([
    ['invalid-server-name', 'bad name', 't', ['a']],
    ['invalid-server-name', '__proto__', 't', ['a']],
    ['invalid-tool-name', 's', 'write_*', ['a']],
    ['invalid-tool-name', 's', '', ['a']],
    ['invalid-tool-name', 's', 'constructor', ['a']],
    ['invalid-agent-name', 's', 't', ['Alice']],
    ['invalid-agent-name', 's', 't', ['a b']],
    ['no-agents', 's', 't', []],
  ] as const)('%s: %s / %s / %j', (reason, server, tool, agents) => {
    const result = applyConfirmInClientToDocument({ version: 1 }, server, tool, agents)
    expect(result).toMatchObject({ ok: false, reason })
    expect(result.ok ? '' : result.message).not.toBe('')
  })

  test('more than MAX_CONFIRM_AGENTS agents', () => {
    const agents = Array.from({ length: MAX_CONFIRM_AGENTS + 1 }, (_, i) => `a${i}`)
    expect(applyConfirmInClientToDocument({ version: 1 }, 's', 't', agents)).toMatchObject({
      ok: false,
      reason: 'too-many-agents',
    })
  })

  test('adding past the per-server entry cap, but replacing on a full map is fine', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_TOOL_RULES_PER_SERVER }, (_, i) => [`t${i}`, ['a']]))
    const document = { version: 1, servers: { s: { confirmInClient: full } } }
    expect(applyConfirmInClientToDocument(document, 's', 'new_tool', ['a'])).toMatchObject({
      ok: false,
      reason: 'too-many-rules',
    })
    expect(applyConfirmInClientToDocument(document, 's', 't0', ['b']).ok).toBe(true)
  })

  test('adding a server past the cap', () => {
    const servers = Object.fromEntries(Array.from({ length: MAX_SERVERS_IN_POLICY }, (_, i) => [`s${i}`, {}]))
    expect(applyConfirmInClientToDocument({ version: 1, servers }, 'extra', 't', ['a'])).toMatchObject({
      ok: false,
      reason: 'too-many-servers',
    })
  })

  test.each([
    ['not an object', 'x'],
    ['servers not an object', { version: 1, servers: [] }],
    ['entry not an object', { version: 1, servers: { s: 1 } }],
    ['confirmInClient not an object', { version: 1, servers: { s: { confirmInClient: [] } } }],
  ])('a document with a malformed path: %s', (_label, document) => {
    expect(applyConfirmInClientToDocument(document, 's', 't', ['a'])).toMatchObject({ ok: false, reason: 'invalid-policy' })
  })

  test('a document that is invalid for another reason is refused with the loader’s words', () => {
    const result = applyConfirmInClientToDocument({ version: 2 }, 's', 't', ['a'])
    expect(result).toMatchObject({ ok: false, reason: 'invalid-policy' })
  })
})
