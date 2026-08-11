import { describe, expect, test } from 'vitest'
import {
  AGENT_METHOD_GRANTED_RULE_PREFIX,
  AGENT_METHOD_LIST_FILTERED_RULE_PREFIX,
  decideMethodGrant,
  filterMethodListResult,
  listItemPredicate,
} from '../../src/agents/method-grants.js'
import { agentScope, type AgentMethodGrants } from '../../src/agents/scope.js'
import type { AgentGrant } from '../../src/agents/schema.js'

/**
 * M4 Task 6: the grant vocabulary for non-tool methods. `decideMethodGrant`
 * is the pure decision core the gate router delegates to; `fallback` means
 * "behave exactly as M3" (the byte-identical non-grantable denial), which is
 * what makes the default — no grants — provably unchanged.
 */

const HASH = 'f'.repeat(64)

/** Real method grants derived through the real scope, so the matcher is the shared one. */
function grantsOf(grant: Partial<AgentGrant>): AgentMethodGrants {
  const record = {
    name: 'research-bot',
    tokenHash: HASH,
    createdAt: '2026-08-05T10:00:00.000Z',
    grants: { testsrv: { tools: [], ...grant } as AgentGrant },
  }
  return agentScope(record, 'testsrv').methodGrants
}

function rawOf(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) })
}

const ALL_FAMILY_METHODS = [
  'resources/read',
  'resources/list',
  'resources/subscribe',
  'resources/unsubscribe',
  'resources/templates/list',
  'prompts/get',
  'prompts/list',
  'completion/complete',
] as const

describe('decideMethodGrant: no grants = M3 fallback for every method', () => {
  test.each(ALL_FAMILY_METHODS)('%s falls back without a methodGrants object', (method) => {
    expect(decideMethodGrant(method, rawOf(method, {}), undefined)).toEqual({ action: 'fallback' })
  })

  test.each(ALL_FAMILY_METHODS)('%s falls back when only tools are granted', (method) => {
    const grants = grantsOf({ tools: '*' } as Partial<AgentGrant>)

    expect(decideMethodGrant(method, rawOf(method, {}), grants)).toEqual({ action: 'fallback' })
  })
})

describe('decideMethodGrant: resources/read', () => {
  const grants = grantsOf({ resources: ['file:///project/*'] })

  test('a matching URI forwards with class read and the granted rule', () => {
    const outcome = decideMethodGrant(
      'resources/read',
      rawOf('resources/read', { uri: 'file:///project/readme.md' }),
      grants,
    )

    expect(outcome).toMatchObject({
      action: 'forward',
      rule: `${AGENT_METHOD_GRANTED_RULE_PREFIX}: resources/read`,
      toolClass: 'read',
    })
  })

  test('a non-matching URI is denied with a rule naming the URI', () => {
    const outcome = decideMethodGrant(
      'resources/read',
      rawOf('resources/read', { uri: 'file:///etc/passwd' }),
      grants,
    )

    expect(outcome).toMatchObject({
      action: 'deny',
      rule: 'agent: no resources grant for file:///etc/passwd',
      toolClass: 'read',
    })
  })

  test('a missing or non-string uri is denied as malformed (worst-case class)', () => {
    const noUri = decideMethodGrant('resources/read', rawOf('resources/read', {}), grants)
    const numberUri = decideMethodGrant(
      'resources/read',
      rawOf('resources/read', { uri: 42 }),
      grants,
    )

    expect(noUri).toMatchObject({
      action: 'deny',
      rule: 'agent: malformed method params: resources/read',
      toolClass: 'destructive',
    })
    expect(numberUri).toMatchObject({ action: 'deny', toolClass: 'destructive' })
  })

  test('an empty resources array behaves as absent (fallback)', () => {
    const empty = grantsOf({ resources: [] })

    expect(
      decideMethodGrant('resources/read', rawOf('resources/read', { uri: 'file:///x' }), empty),
    ).toEqual({ action: 'fallback' })
  })
})

describe('decideMethodGrant: subscribe/unsubscribe are class write', () => {
  const grants = grantsOf({ resources: ['file:///project/*'] })

  test.each(['resources/subscribe', 'resources/unsubscribe'] as const)(
    '%s forwards a granted URI with class write',
    (method) => {
      const outcome = decideMethodGrant(
        method,
        rawOf(method, { uri: 'file:///project/a.txt' }),
        grants,
      )

      expect(outcome).toMatchObject({ action: 'forward', toolClass: 'write' })
    },
  )

  test('a non-granted URI is denied with class write', () => {
    const outcome = decideMethodGrant(
      'resources/subscribe',
      rawOf('resources/subscribe', { uri: 'file:///etc/passwd' }),
      grants,
    )

    expect(outcome).toMatchObject({ action: 'deny', toolClass: 'write' })
  })
})

describe('decideMethodGrant: list methods', () => {
  test('resources/list forwards (class read) and asks for resources-list filtering', () => {
    const outcome = decideMethodGrant(
      'resources/list',
      rawOf('resources/list'),
      grantsOf({ resources: ['file:///project/*'] }),
    )

    expect(outcome).toMatchObject({ action: 'forward', toolClass: 'read', list: 'resources' })
  })

  test('prompts/list forwards and asks for prompts-list filtering', () => {
    const outcome = decideMethodGrant('prompts/list', rawOf('prompts/list'), grantsOf({ prompts: ['greet*'] }))

    expect(outcome).toMatchObject({ action: 'forward', toolClass: 'read', list: 'prompts' })
  })

  test('resources/list without a resources grant falls back to M3', () => {
    expect(
      decideMethodGrant('resources/list', rawOf('resources/list'), grantsOf({ prompts: '*' })),
    ).toEqual({ action: 'fallback' })
  })
})

describe('decideMethodGrant: prompts/get uses the shared matcher', () => {
  const grants = grantsOf({ prompts: ['greet*', 'summary'] })

  test.each<[name: string, granted: boolean]>([
    ['greeting', true],
    ['greet', true],
    ['summary', true],
    ['summarize', false],
    ['regret', false],
  ])('name %j → granted=%s', (name, granted) => {
    const outcome = decideMethodGrant('prompts/get', rawOf('prompts/get', { name }), grants)

    if (granted) {
      expect(outcome).toMatchObject({ action: 'forward', toolClass: 'read' })
    } else {
      expect(outcome).toMatchObject({
        action: 'deny',
        rule: `agent: no prompts grant for ${name}`,
        toolClass: 'read',
      })
    }
  })
})

describe('decideMethodGrant: completion/complete', () => {
  test('allowed with only a resources grant', () => {
    const outcome = decideMethodGrant(
      'completion/complete',
      rawOf('completion/complete', {}),
      grantsOf({ resources: ['file:///p/*'] }),
    )

    expect(outcome).toMatchObject({ action: 'forward', toolClass: 'read' })
  })

  test('allowed with only a prompts grant', () => {
    const outcome = decideMethodGrant(
      'completion/complete',
      rawOf('completion/complete', {}),
      grantsOf({ prompts: '*' }),
    )

    expect(outcome).toMatchObject({ action: 'forward', toolClass: 'read' })
  })

  test('falls back to M3 with neither grant', () => {
    expect(
      decideMethodGrant('completion/complete', rawOf('completion/complete', {}), grantsOf({})),
    ).toEqual({ action: 'fallback' })
  })
})

describe('decideMethodGrant: methods outside the enumerated vocabulary stay M3-denied', () => {
  test('resources/templates/list falls back even with wildcard grants', () => {
    const grants = grantsOf({ resources: '*', prompts: '*' })

    expect(
      decideMethodGrant('resources/templates/list', rawOf('resources/templates/list'), grants),
    ).toEqual({ action: 'fallback' })
  })
})

describe('filterMethodListResult', () => {
  const isProjectUri = listItemPredicate(grantsOf({ resources: ['file:///project/*'] }), 'resources')

  function resourcesResponse(items: unknown[]): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      result: { resources: items, nextCursor: 'c2', _meta: { keep: true } },
    })
  }

  test('keeps granted URIs, removes others, preserves every other field', () => {
    const raw = resourcesResponse([
      { uri: 'file:///project/a.txt', name: 'A', vendorField: 1 },
      { uri: 'file:///etc/passwd', name: 'P' },
    ])

    const filtered = filterMethodListResult(raw, 'resources', isProjectUri)

    expect(filtered).not.toBeNull()
    expect(filtered?.removed).toEqual(['file:///etc/passwd'])
    expect(filtered?.kept).toBe(1)
    expect(filtered?.droppedUnreadable).toBe(0)
    const parsed = JSON.parse(filtered?.serialized ?? '') as {
      result: { resources: Array<Record<string, unknown>>; nextCursor: string; _meta: unknown }
    }
    expect(parsed.result.resources).toEqual([
      { uri: 'file:///project/a.txt', name: 'A', vendorField: 1 },
    ])
    expect(parsed.result.nextCursor).toBe('c2')
    expect(parsed.result._meta).toEqual({ keep: true })
  })

  test('entries without a readable subject are dropped and counted (allowlist fails closed)', () => {
    const raw = resourcesResponse([{ uri: 'file:///project/a.txt' }, { name: 'no-uri' }, 'garbage'])

    const filtered = filterMethodListResult(raw, 'resources', isProjectUri)

    expect(filtered?.kept).toBe(1)
    expect(filtered?.removed).toEqual([])
    expect(filtered?.droppedUnreadable).toBe(2)
  })

  test('prompts are filtered by name', () => {
    const isGreet = listItemPredicate(grantsOf({ prompts: ['greet*'] }), 'prompts')
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      result: { prompts: [{ name: 'greeting' }, { name: 'secret-prompt' }] },
    })

    const filtered = filterMethodListResult(raw, 'prompts', isGreet)

    expect(filtered?.removed).toEqual(['secret-prompt'])
    const parsed = JSON.parse(filtered?.serialized ?? '') as {
      result: { prompts: Array<{ name: string }> }
    }
    expect(parsed.result.prompts.map((prompt) => prompt.name)).toEqual(['greeting'])
  })

  test('a response that is not a recognizable list yields null (caller forwards as-is)', () => {
    expect(filterMethodListResult('not json', 'resources', isProjectUri)).toBeNull()
    expect(
      filterMethodListResult(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), 'resources', isProjectUri),
    ).toBeNull()
    expect(
      filterMethodListResult(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resources: 'nope' } }),
        'resources',
        isProjectUri,
      ),
    ).toBeNull()
  })

  test('an all-granted list reports nothing removed', () => {
    const raw = resourcesResponse([{ uri: 'file:///project/a' }, { uri: 'file:///project/b' }])

    const filtered = filterMethodListResult(raw, 'resources', isProjectUri)

    expect(filtered?.removed).toEqual([])
    expect(filtered?.droppedUnreadable).toBe(0)
    expect(filtered?.kept).toBe(2)
  })

  test('the filtered-rule prefix is exported for the router journal record', () => {
    expect(AGENT_METHOD_LIST_FILTERED_RULE_PREFIX).toContain('agent')
  })
})
