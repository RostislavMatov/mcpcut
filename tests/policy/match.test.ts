import { describe, expect, test } from 'vitest'
import { matchToolRule } from '../../src/policy/match.js'

describe('matchToolRule: no rules', () => {
  test('undefined rules map returns null', () => {
    expect(matchToolRule(undefined, 'delete_user')).toBeNull()
  })

  test('empty rules map returns null', () => {
    expect(matchToolRule({}, 'delete_user')).toBeNull()
  })
})

describe('matchToolRule: exact match', () => {
  test('exact tool name match returns its value and the literal pattern', () => {
    const rules = { delete_user: 'deny' }
    expect(matchToolRule(rules, 'delete_user')).toEqual({ value: 'deny', pattern: 'delete_user' })
  })

  test('exact match wins over a matching glob, regardless of definition order', () => {
    const rules = { 'github_*': 'allow', github_delete: 'deny' }
    expect(matchToolRule(rules, 'github_delete')).toEqual({ value: 'deny', pattern: 'github_delete' })
  })

  test('exact match wins even when the glob entry is defined first', () => {
    const rules = { github_delete: 'deny', 'github_*': 'allow' }
    expect(matchToolRule(rules, 'github_delete')).toEqual({ value: 'deny', pattern: 'github_delete' })
  })
})

describe('matchToolRule: glob match', () => {
  test('single glob prefix matches a tool name with that prefix', () => {
    const rules = { 'github_*': 'allow' }
    expect(matchToolRule(rules, 'github_create_issue')).toEqual({
      value: 'allow',
      pattern: 'github_*',
    })
  })

  test('longest matching glob prefix wins over a shorter matching glob', () => {
    const rules = { 'git*': 'deny', 'github_*': 'allow' }
    expect(matchToolRule(rules, 'github_create_issue')).toEqual({
      value: 'allow',
      pattern: 'github_*',
    })
  })

  test('longest matching glob prefix wins regardless of definition order', () => {
    const rules = { 'github_*': 'allow', 'git*': 'deny' }
    expect(matchToolRule(rules, 'github_create_issue')).toEqual({
      value: 'allow',
      pattern: 'github_*',
    })
  })

  test('a glob that does not match the tool name prefix is ignored', () => {
    const rules = { 'admin_*': 'deny' }
    expect(matchToolRule(rules, 'github_create_issue')).toBeNull()
  })

  test('glob matches empty-suffix case: pattern equals prefix plus star, tool name equals prefix', () => {
    const rules = { 'github_*': 'allow' }
    expect(matchToolRule(rules, 'github_')).toEqual({ value: 'allow', pattern: 'github_*' })
  })
})

describe('matchToolRule: no match', () => {
  test('tool name matching neither an exact key nor any glob returns null', () => {
    const rules = { delete_user: 'deny', 'github_*': 'allow' }
    expect(matchToolRule(rules, 'search_index')).toBeNull()
  })
})

describe('matchToolRule: garbage/edge-case patterns (schema validates upstream, but behave sanely)', () => {
  test('a bare "*" pattern matches any tool name', () => {
    const rules = { '*': 'deny' }
    expect(matchToolRule(rules, 'anything')).toEqual({ value: 'deny', pattern: '*' })
  })

  test('an empty-string key never matches a non-empty tool name via glob logic', () => {
    const rules = { '': 'deny' }
    expect(matchToolRule(rules, 'anything')).toBeNull()
  })

  test('an empty-string key exact-matches an empty tool name', () => {
    const rules = { '': 'deny' }
    expect(matchToolRule(rules, '')).toEqual({ value: 'deny', pattern: '' })
  })

  test('a mid-name wildcard key is treated as a literal (only trailing "*" is glob syntax) and never matches', () => {
    const rules = { 'a*b': 'deny' }
    expect(matchToolRule(rules, 'aXb')).toBeNull()
  })

  test('a mid-name wildcard key still exact-matches its own literal text', () => {
    const rules = { 'a*b': 'deny' }
    expect(matchToolRule(rules, 'a*b')).toEqual({ value: 'deny', pattern: 'a*b' })
  })
})
