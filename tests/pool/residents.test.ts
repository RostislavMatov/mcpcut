import { describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { desiredResidentPairs, residentKeyOf } from '../../src/pool/residents.js'
import type { ServerRecord } from '../../src/registry/schema.js'

/**
 * Which (agent, stdio server) pairs the plane keeps running (RS2): every
 * unrevoked agent's effective grant on a registered stdio server, in a
 * deterministic order, the first `cap` of them resident.
 */

function agent(name: string, servers: readonly string[], extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name,
    tokenHash: 'x',
    createdAt: `2026-09-0${name.length % 9}T00:00:00.000Z`,
    grants: Object.fromEntries(servers.map((server) => [server, { tools: '*' }])),
    ...extra,
  } as AgentRecord
}

function stdio(name: string): ServerRecord {
  return { name, transport: 'stdio', command: 'node', args: [] } as unknown as ServerRecord
}

function http(name: string): ServerRecord {
  return { name, transport: 'http', url: 'https://example.test/mcp', protocol: 'auto' } as unknown as ServerRecord
}

function pairsOf(list: readonly { agentName: string; serverName: string }[]): string[] {
  return list.map((pair) => `${pair.agentName}/${pair.serverName}`)
}

describe('desiredResidentPairs', () => {
  test('one pair per granted stdio server of each agent', () => {
    const desired = desiredResidentPairs([agent('bot', ['memory', 'fs'])], [stdio('memory'), stdio('fs')], 32)

    expect(pairsOf(desired.resident)).toEqual(['bot/fs', 'bot/memory'])
    expect(desired.overCap).toEqual([])
  })

  test('a revoked agent holds no resident', () => {
    const desired = desiredResidentPairs(
      [agent('bot', ['memory'], { revokedAt: '2026-09-10T00:00:00.000Z' })],
      [stdio('memory')],
      32,
    )

    expect(desired.resident).toEqual([])
  })

  test('an HTTP server is never resident', () => {
    const desired = desiredResidentPairs([agent('bot', ['remote'])], [http('remote')], 32)

    expect(desired.resident).toEqual([])
  })

  test('a grant on a server that is not registered is ignored', () => {
    const desired = desiredResidentPairs([agent('bot', ['gone'])], [stdio('memory')], 32)

    expect(desired.resident).toEqual([])
  })

  test('a grant materialized from a group counts like a personal one', () => {
    // The lister hands records with group grants already expanded (G2).
    const desired = desiredResidentPairs([agent('bot', ['memory'])], [stdio('memory')], 32)

    expect(pairsOf(desired.resident)).toEqual(['bot/memory'])
  })

  test('the order is by agent, then server — whatever order the inputs came in', () => {
    const agents = [agent('zed', ['b', 'a']), agent('amy', ['b'])]
    const servers = [stdio('b'), stdio('a')]

    const forward = desiredResidentPairs(agents, servers, 32)
    const backward = desiredResidentPairs([...agents].reverse(), [...servers].reverse(), 32)

    expect(pairsOf(forward.resident)).toEqual(['amy/b', 'zed/a', 'zed/b'])
    expect(pairsOf(backward.resident)).toEqual(pairsOf(forward.resident))
  })

  test('the cap splits the pairs into resident and over-cap', () => {
    const agents = [agent('a', ['s1', 's2', 's3']), agent('b', ['s1', 's2', 's3']), agent('c', ['s1', 's2', 's3'])]
    const servers = [stdio('s1'), stdio('s2'), stdio('s3')]

    const desired = desiredResidentPairs(agents, servers, 4)

    expect(pairsOf(desired.resident)).toEqual(['a/s1', 'a/s2', 'a/s3', 'b/s1'])
    expect(pairsOf(desired.overCap)).toEqual(['b/s2', 'b/s3', 'c/s1', 'c/s2', 'c/s3'])
  })

  test('each pair carries the agent’s createdAt', () => {
    const record = agent('bot', ['memory'])

    const desired = desiredResidentPairs([record], [stdio('memory')], 32)

    expect(desired.resident[0]?.agentCreatedAt).toBe(record.createdAt)
  })
})

describe('residentKeyOf', () => {
  test('takes the agent’s createdAt: a recreated agent is a different key', () => {
    const before = residentKeyOf({ agentName: 'bot', agentCreatedAt: '2026-09-01T00:00:00.000Z', serverName: 'm' })
    const after = residentKeyOf({ agentName: 'bot', agentCreatedAt: '2026-09-02T00:00:00.000Z', serverName: 'm' })

    expect(before).not.toBe(after)
  })

  test('no two different pairs share a key through the separator', () => {
    const one = residentKeyOf({ agentName: 'a-b', agentCreatedAt: 't', serverName: 'c' })
    const two = residentKeyOf({ agentName: 'a', agentCreatedAt: 't', serverName: 'b-c' })

    expect(one).not.toBe(two)
  })
})
