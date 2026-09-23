import { describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createPoolChildOpener } from '../../src/cli/serve-pool-child.js'
import type { ServerRecord } from '../../src/registry/schema.js'

/**
 * Where a pool child comes from, before any process is involved: a server the
 * agent's FRESH record no longer grants is refused at once (smoke D1-D5, G):
 * between the child's own watch and the pool's, the pool's next list asked
 * for it — the supervisor refused too, but only after opening a warm entry.
 */

const STDIO = { name: 'svelte', transport: 'stdio', command: 'svelte-mcp' } as unknown as ServerRecord

function agentWith(grants: Record<string, unknown>): AgentRecord {
  return { name: 'bot', tokenHash: 'x', createdAt: '2026-09-23T00:00:00.000Z', grants } as AgentRecord
}

function opener(agent: AgentRecord, acquired: string[]) {
  return createPoolChildOpener({
    ctx: { agentName: 'bot', serverName: '__pool' },
    registry: { getServer: () => Promise.resolve(STDIO) },
    agents: { getAgent: () => Promise.resolve(agent), findAgentByToken: () => Promise.resolve(undefined) },
    openChildSession: () => Promise.reject(new Error('must not open')),
    report: () => undefined,
    onChildCountChange: () => undefined,
    residents: {
      acquire: (pair) => {
        acquired.push(pair.serverName)
        return Promise.resolve({ status: 'refused', reason: 'no-grant' })
      },
    },
    reserveProcessSlot: () => null,
    onSecrets: () => undefined,
  })
}

describe('createPoolChildOpener', () => {
  test('a server the fresh record no longer grants is refused without asking the supervisor', async () => {
    const acquired: string[] = []

    const result = await opener(agentWith({ memory: { tools: '*' } }), acquired)('svelte', { deadline: Date.now() + 1000 })

    expect(result).toEqual({ status: 'refused', reason: 'no-grant' })
    expect(acquired).toEqual([])
  })

  test('a granted stdio server goes to the supervisor', async () => {
    const acquired: string[] = []

    await opener(agentWith({ svelte: { tools: '*' } }), acquired)('svelte', { deadline: Date.now() + 1000 })

    expect(acquired).toEqual(['svelte'])
  })
})
