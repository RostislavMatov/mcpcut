import { describe, expect, test } from 'vitest'
import { normalizeResourceUri } from '../../src/agents/resource-match.js'
import { agentScope } from '../../src/agents/scope.js'
import type { AgentGrant, AgentRecord } from '../../src/agents/schema.js'

/**
 * Security review HIGH (M4 wave 1): resource grants were matched LEXICALLY
 * (startsWith on the raw string), so `..` segments, percent-encoding and
 * scheme-case tricks slipped past a `file:///project/*` grant. These tests pin
 * the normalized, segment-boundary matcher: URIs are canonicalized (scheme +
 * authority case, dot-segment collapse, one percent-decode per path segment)
 * before matching, anything that cannot be normalized is DENIED (fail closed),
 * and a trailing-`*` prefix only matches on a path-segment boundary.
 */

const HASH = 'f'.repeat(64)

function scopeWith(resources: AgentGrant['resources']): (uri: string) => boolean {
  const record: AgentRecord = {
    name: 'research-bot',
    tokenHash: HASH,
    createdAt: '2026-08-05T10:00:00.000Z',
    grants: { testsrv: { tools: [], ...(resources !== undefined ? { resources } : {}) } as AgentGrant },
  }
  return agentScope(record, 'testsrv').methodGrants.isResourceGranted
}

describe('normalizeResourceUri', () => {
  test.each<[input: string, expected: string | null]>([
    // canonical forms survive untouched
    ['file:///project/readme.md', 'file:///project/readme.md'],
    // dot segments collapse
    ['file:///a/b/../c', 'file:///a/c'],
    ['file:///project/./x', 'file:///project/x'],
    // scheme and host are case-canonicalized; the path case is preserved
    ['File:///Project/X', 'file:///Project/X'],
    ['https://Example.COM/Path', 'https://example.com/Path'],
    // default ports drop
    ['https://example.com:443/x', 'https://example.com/x'],
    // percent-encoded dot segments collapse like literal ones
    ['file:///project/%2e%2e/secret', 'file:///secret'],
    ['file:///project/%2E%2E/secret', 'file:///secret'],
    // a decoded segment that would introduce traversal is unparseable → null
    ['file:///project/..%2Fsecret', null],
    ['file:///project/%2e%2e%2fsecret', null],
    ['file:///project%2f..%2f..%2fetc/passwd', null],
    // malformed percent-encoding is unparseable → null
    ['file:///project/%zz', null],
    // an opaque path cannot be checked for traversal → any dot segment denies
    ['urn:a/../b', null],
    // not a URI at all
    ['', null],
    ['no-scheme-at-all', null],
  ])('%j → %j', (input, expected) => {
    expect(normalizeResourceUri(input)).toBe(expected)
  })
})

describe('resource grant matching is normalized and fail-closed', () => {
  const isGranted = scopeWith(['file:///project/*'])

  test.each<[uri: string, granted: boolean]>([
    // the straightforward cases still work
    ['file:///project/readme.md', true],
    ['file:///project/sub/deep.txt', true],
    ['file:///etc/passwd', false],
    // traversal out of the granted subtree is caught after normalization
    ['file:///project/../../etc/passwd', false],
    ['file:///project/../project2/x', false],
    // ...and traversal that STAYS inside the subtree still matches
    ['file:///project/a/../b.txt', true],
    // percent-encoded dot segments are no escape either
    ['file:///project/%2e%2e/secret', false],
    ['file:///project/%2E%2E/secret', false],
    // encoded slashes cannot smuggle traversal (unparseable → deny)
    ['file:///project/..%2F..%2Fetc/passwd', false],
    ['file:///project/%2e%2e%2fsecret', false],
    // scheme/host case tricks are canonicalized, not bypassed
    ['FILE:///project/readme.md', true],
    ['File:///Project/readme.md', false],
    // file://localhost/ is the same authority as file:///
    ['file://localhost/project/readme.md', true],
    // malformed percent-encoding: fail closed even under a covering prefix
    ['file:///project/%zz', false],
    // the bare prefix itself (with or without the trailing slash) is covered
    ['file:///project', true],
    ['file:///project/', true],
  ])('grant file:///project/* , uri %j → %s', (uri, granted) => {
    expect(isGranted(uri)).toBe(granted)
  })

  test('a prefix without a trailing slash still matches only on a segment boundary', () => {
    const matcher = scopeWith(['file:///project*'])

    expect(matcher('file:///project/readme.md')).toBe(true)
    expect(matcher('file:///project')).toBe(true)
    expect(matcher('file:///project-evil/readme.md')).toBe(false)
    expect(matcher('file:///projects/readme.md')).toBe(false)
  })

  test('an exact grant matches its own normalized form', () => {
    const matcher = scopeWith(['file:///project/a.txt'])

    expect(matcher('file:///project/a.txt')).toBe(true)
    expect(matcher('file:///project/b/../a.txt')).toBe(true)
    expect(matcher('file:///project/a.txt.bak')).toBe(false)
  })

  test('an unparseable grant pattern grants nothing instead of matching lexically', () => {
    const matcher = scopeWith(['not-a-uri*'])

    expect(matcher('not-a-uri-resource')).toBe(false)
  })

  test("the '*' grant is total by declaration and skips URI parsing", () => {
    const matcher = scopeWith('*')

    expect(matcher('anything://at/all')).toBe(true)
    expect(matcher('not-even-a-uri')).toBe(true)
  })

  test('absent and empty grants still deny everything (M3 default untouched)', () => {
    expect(scopeWith(undefined)('file:///project/x')).toBe(false)
    expect(scopeWith([])('file:///project/x')).toBe(false)
  })
})
