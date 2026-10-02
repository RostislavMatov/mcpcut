import { describe, expect, test } from 'vitest'
import { isConfirmInClient } from '../../src/policy/confirm-in-client.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { confirmRuleViewOf } from '../../src/ui/pages/servers-confirm-rule.js'

/**
 * The Servers page and the gate must read `confirmInClient` the same way
 * (2026-10-02 reviews): a page that shows a tool as confirmed for an agent
 * the gate lets through would fail open by presentation.
 */

function policyOf(confirmInClient: Record<string, string[]>): Policy {
  const result = parsePolicy({ version: 1, servers: { fs: { confirmInClient } } })
  if (!result.ok) throw new Error('invalid test policy')
  return result.policy
}

/** Whom the page says confirms `tool`: the union of the exact entry and every covering pattern. */
function shownFor(policy: Policy, tool: string, agent: string | undefined): boolean {
  const view = confirmRuleViewOf(policy, 'fs', tool)
  const lists = [...(view.exact !== undefined ? [view.exact] : []), ...view.patterns.map((p) => p.agents)]
  return lists.some((agents) => agents.includes('*') || (agent !== undefined && agents.includes(agent)))
}

const POLICIES: readonly Record<string, string[]>[] = [
  { write_file: ['laptop'] },
  { 'write_*': ['*'], write_file: ['laptop'] },
  { 'git*': ['alice'], 'github_*': ['bob'], github_push: ['carol'] },
  { 'd*': ['ci'], delete_file: ['*'] },
]
const TOOLS = ['write_file', 'write_dir', 'github_push', 'git_commit', 'delete_file', 'read_file', 'constructor']
const AGENTS = [undefined, 'laptop', 'alice', 'bob', 'carol', 'ci', 'stranger']

describe('the Servers page and the gate agree on who confirms', () => {
  test.each(POLICIES.map((p) => [JSON.stringify(p), p] as const))('%s', (_label, confirmInClient) => {
    const policy = policyOf(confirmInClient)
    for (const tool of TOOLS) {
      for (const agent of AGENTS) {
        expect({ tool, agent, shown: shownFor(policy, tool, agent) }).toEqual({ tool, agent, shown: isConfirmInClient(policy, 'fs', tool, agent) })
      }
    }
  })
})
