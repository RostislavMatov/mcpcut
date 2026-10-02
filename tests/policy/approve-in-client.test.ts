import { describe, expect, test } from 'vitest'
import { isApprovableInClient } from '../../src/policy/approve-in-client.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/** `servers.<name>.approveInClient`: which held tools the person at the client may approve (ADR-0019). */

function policyOf(servers: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, servers })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

describe('isApprovableInClient', () => {
  const policy = policyOf({ fs: { approveInClient: ['write_file', 'git*', 'github_*'] } })

  test.each([
    ['an exact name', 'write_file', true],
    ['a prefix pattern', 'github_create_issue', true],
    ['the shorter prefix too', 'git_commit', true],
    ['an unlisted tool', 'delete_file', false],
    ['a name that only starts like a listed one', 'write_file_v2', false],
  ])('%s', (_label, tool, expected) => {
    expect(isApprovableInClient(policy, 'fs', tool)).toBe(expected)
  })

  test('another server, or no servers at all', () => {
    expect(isApprovableInClient(policy, 'other', 'write_file')).toBe(false)
    expect(isApprovableInClient(policyOf({}), 'fs', 'write_file')).toBe(false)
  })

  test('a server named like an Object method is just a name', () => {
    expect(isApprovableInClient(policy, 'constructor', 'write_file')).toBe(false)
    expect(isApprovableInClient(policy, '__proto__', 'write_file')).toBe(false)
  })

  test('the schema refuses a mid-name wildcard, as for tool rules', () => {
    expect(parsePolicy({ version: 1, servers: { fs: { approveInClient: ['wr*te'] } } }).ok).toBe(false)
  })
})
