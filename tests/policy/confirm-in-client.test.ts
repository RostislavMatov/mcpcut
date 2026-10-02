import { describe, expect, test } from 'vitest'
import { AGENT_NAME_PATTERN } from '../../src/agents/constants.js'
import { CONFIRM_AGENT_NAME_PATTERN, CONFIRM_ANY_AGENT } from '../../src/policy/constants.js'
import { isConfirmInClient } from '../../src/policy/confirm-in-client.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/**
 * `servers.<name>.confirmInClient`: which tools the person at the client must
 * confirm, and for which agents (ADR-0019). A rule of its own, independent of
 * the admin's `tools` outcome.
 */

function policyOf(servers: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, servers })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

describe('isConfirmInClient', () => {
  const policy = policyOf({
    fs: {
      confirmInClient: {
        write_file: ['laptop', 'alice-cursor'],
        'git*': ['*'],
        github_create_issue: ['laptop'],
      },
    },
  })

  test.each([
    ['a listed agent on an exact name', 'write_file', 'laptop', true],
    ['the other listed agent', 'write_file', 'alice-cursor', true],
    ['an agent not on the list', 'write_file', 'ci-bot', false],
    ['no agent (wrap) where only named agents confirm', 'write_file', undefined, false],
    ['any agent under "*"', 'git_commit', 'ci-bot', true],
    ['no agent (wrap) under "*"', 'git_commit', undefined, true],
    ['an unlisted tool', 'delete_file', 'laptop', false],
    ['a name that only starts like a listed one', 'write_file_v2', 'laptop', false],
  ])('%s', (_label, tool, agent, expected) => {
    expect(isConfirmInClient(policy, 'fs', tool, agent)).toBe(expected)
  })

  test('the most specific entry decides, as for tool rules', () => {
    const specific = policyOf({ fs: { confirmInClient: { 'write_*': ['*'], write_file: ['laptop'] } } })
    expect(isConfirmInClient(specific, 'fs', 'write_file', 'ci-bot')).toBe(false)
    expect(isConfirmInClient(specific, 'fs', 'write_file', 'laptop')).toBe(true)
    expect(isConfirmInClient(specific, 'fs', 'write_dir', 'ci-bot')).toBe(true)
  })

  test('another server, or no servers at all', () => {
    expect(isConfirmInClient(policy, 'other', 'write_file', 'laptop')).toBe(false)
    expect(isConfirmInClient(policyOf({}), 'fs', 'write_file', 'laptop')).toBe(false)
  })

  test('a server or tool named like an Object method is just a name', () => {
    expect(isConfirmInClient(policy, 'constructor', 'write_file', 'laptop')).toBe(false)
    expect(isConfirmInClient(policy, '__proto__', 'write_file', 'laptop')).toBe(false)
    expect(isConfirmInClient(policy, 'fs', 'constructor', 'laptop')).toBe(false)
  })
})

describe('the confirmInClient schema', () => {
  const parse = (confirmInClient: unknown): boolean =>
    parsePolicy({ version: 1, servers: { fs: { confirmInClient } } }).ok

  test('takes agent names and "*"', () => {
    expect(parse({ write_file: ['laptop', CONFIRM_ANY_AGENT] })).toBe(true)
  })

  test.each([
    ['a mid-name wildcard, as for tool rules', { 'wr*te': ['*'] }],
    ['an empty agent list (it would confirm nothing)', { write_file: [] }],
    ['an agent name agents cannot have', { write_file: ['Laptop'] }],
    ['a list instead of a map (the old approveInClient shape)', ['write_file']],
    ['a string instead of a list', { write_file: 'laptop' }],
  ])('refuses %s', (_label, value) => {
    expect(parse(value)).toBe(false)
  })

  test('the old approveInClient field is gone', () => {
    expect(parsePolicy({ version: 1, servers: { fs: { approveInClient: ['write_file'] } } }).ok).toBe(false)
  })

  test('approval.askClient is gone: confirmation is a rule per tool, not a switch', () => {
    expect(parsePolicy({ version: 1, approval: { askClient: false } }).ok).toBe(false)
  })

  test('agent names follow the agents store, so a name the policy accepts can exist', () => {
    expect(CONFIRM_AGENT_NAME_PATTERN.source).toBe(AGENT_NAME_PATTERN.source)
  })
})
