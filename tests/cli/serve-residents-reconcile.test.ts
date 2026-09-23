import { afterEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { startResidentReconcile, type ResidentReconcile } from '../../src/cli/serve-residents-reconcile.js'
import type { DesiredResidents } from '../../src/pool/residents.js'
import type { ServerRecord, StdioServerRecord } from '../../src/registry/schema.js'

/**
 * The reconcile loop (RS4): stores in, the desired residents out to the
 * supervisor — and a failed read changes nothing.
 */

const loops: ResidentReconcile[] = []
afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop()
})

function agent(name: string, servers: readonly string[], extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name,
    tokenHash: 'x',
    createdAt: '2026-09-01T00:00:00.000Z',
    grants: Object.fromEntries(servers.map((server) => [server, { tools: '*' }])),
    ...extra,
  } as AgentRecord
}

function stdio(name: string, args: readonly string[] = []): ServerRecord {
  return { name, transport: 'stdio', command: 'node', args: [...args] } as unknown as ServerRecord
}

interface Harness {
  agents: readonly AgentRecord[]
  servers: readonly ServerRecord[]
  failRead: boolean
  readonly applied: Array<{ desired: DesiredResidents; records: ReadonlyMap<string, StdioServerRecord> }>
  readonly stderr: string[]
  readonly loop: ResidentReconcile
}

function createHarness(
  cap = 32,
  initial: { agents?: readonly AgentRecord[]; servers?: readonly ServerRecord[] } = {},
): Harness {
  const harness = {
    agents: initial.agents ?? ([] as readonly AgentRecord[]),
    servers: initial.servers ?? ([] as readonly ServerRecord[]),
    failRead: false,
    applied: [] as Harness['applied'],
    stderr: [] as string[],
  }
  const loop = startResidentReconcile({
    agents: {
      listAgents: () => (harness.failRead ? Promise.reject(new Error('locked')) : Promise.resolve(harness.agents)),
    },
    registry: { listServers: () => Promise.resolve(harness.servers) },
    supervisor: { applyDesired: (desired, records) => harness.applied.push({ desired, records }) },
    intervalMs: 60_000,
    cap,
    stderr: { write: (line: string) => harness.stderr.push(line) },
  })
  loops.push(loop)
  return Object.assign(harness, { loop })
}

function residentsOf(harness: Harness): string[] {
  const last = harness.applied.at(-1)
  return (last?.desired.resident ?? []).map((pair) => `${pair.agentName}/${pair.serverName}`)
}

describe('startResidentReconcile', () => {
  test('the first pass runs at once, and a new grant makes a resident', async () => {
    const harness = createHarness(32, { agents: [agent('bot', ['memory'])], servers: [stdio('memory')] })

    await harness.loop.tick()

    expect(residentsOf(harness)).toEqual(['bot/memory'])
    expect([...(harness.applied.at(-1)?.records.keys() ?? [])]).toEqual(['memory'])
  })

  test('a withdrawn grant, and a revoked agent, leave the desired set', async () => {
    const harness = createHarness()
    harness.agents = [agent('bot', ['memory']), agent('old', ['memory'])]
    harness.servers = [stdio('memory')]
    await harness.loop.tick()

    harness.agents = [agent('bot', []), agent('old', ['memory'], { revokedAt: '2026-09-10T00:00:00.000Z' })]
    await harness.loop.tick()

    expect(residentsOf(harness)).toEqual([])
  })

  test('an edited record reaches the supervisor as the new record', async () => {
    const harness = createHarness()
    harness.agents = [agent('bot', ['memory'])]
    harness.servers = [stdio('memory', ['v1'])]
    await harness.loop.tick()

    harness.servers = [stdio('memory', ['v2'])]
    await harness.loop.tick()

    expect(harness.applied.at(-1)?.records.get('memory')?.args).toEqual(['v2'])
  })

  test('a failed read touches nothing, and says so once per pass', async () => {
    const harness = createHarness()
    harness.agents = [agent('bot', ['memory'])]
    harness.servers = [stdio('memory')]
    await harness.loop.tick()
    const appliedBefore = harness.applied.length

    harness.failRead = true
    await harness.loop.tick()

    expect(harness.applied).toHaveLength(appliedBefore)
    expect(harness.stderr.join('')).toContain('could not read agents or registry; nothing changed')
  })

  test('pairs over the cap are reported once per change', async () => {
    const harness = createHarness(1)
    harness.agents = [agent('bot', ['a', 'b', 'c'])]
    harness.servers = [stdio('a'), stdio('b'), stdio('c')]

    await harness.loop.tick()
    await harness.loop.tick()

    const lines = harness.stderr.filter((line) => line.includes('over the cap'))
    expect(lines).toEqual([
      '[serve] residents: 2 granted stdio server(s) over the cap of 1; they start when an agent asks\n',
    ])
  })
})
