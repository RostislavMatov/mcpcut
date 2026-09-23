import { describe, expect, test, vi } from 'vitest'
import type { AdminStore } from '../../src/admin/store.js'
import type { AgentsStore } from '../../src/agents/store.js'
import type { EventHub } from '../../src/ui/events.js'
import type { RegistryStore } from '../../src/registry/store.js'
import type { VaultStore } from '../../src/vault/store.js'

/**
 * The composition root wires `servers`, `agents` and `registry` ports as
 * `Pick<>` types at COMPILE time only (M4 polish review). This test proves
 * the runtime object handed to `createServersHandlers` is actually narrowed:
 * a vault/registry with extra methods (e.g. `readSecretValues`) must not
 * carry them through to the handler, own or inherited.
 */

interface CapturedServersDeps {
  readonly vault: unknown
  readonly registry: unknown
  readonly agents: unknown
}

const capturedServersDeps: CapturedServersDeps[] = []

vi.mock('../../src/ui/handlers/servers.js', () => ({
  createServersHandlers: (deps: CapturedServersDeps) => {
    capturedServersDeps.push(deps)
    return {}
  },
}))

const capturedAgentsDeps: Array<{ readonly serveAddress: unknown }> = []

vi.mock('../../src/ui/handlers/agents.js', () => ({
  createAgentsHandlers: (deps: { readonly serveAddress: unknown }) => {
    capturedAgentsDeps.push(deps)
    return {}
  },
}))

const { composeUi } = await import('../../src/cli/ui-wiring.js')

/** True when `key` is reachable on `target`, own or through its prototype chain. */
function hasProperty(target: unknown, key: string): boolean {
  return typeof target === 'object' && target !== null && key in target
}

describe('composeUi: capability narrowing is enforced at runtime, not just compile time', () => {
  test('the vault handed to createServersHandlers has no readSecretValues', () => {
    capturedServersDeps.length = 0
    const fullVault: VaultStore = {
      init: async () => ({ created: false }) as never,
      setSecret: async () => ({}) as never,
      listSecrets: async () => ({ secrets: [] }) as never,
      removeSecret: async () => ({}) as never,
      readSecretValues: async () => {
        throw new Error('readSecretValues must never be reachable from the servers handler')
      },
      rekey: async () => ({}) as never,
    }

    composeUi(buildDeps({ vault: fullVault }))

    const passed = capturedServersDeps[0]
    expect(passed).toBeDefined()
    expect(hasProperty(passed?.vault, 'readSecretValues')).toBe(false)
    expect(hasProperty(passed?.vault, 'listSecrets')).toBe(true)
  })

  test('the registry handed to createServersHandlers has no getServer', () => {
    capturedServersDeps.length = 0
    const fullRegistry: RegistryStore = {
      addServer: async () => ({}) as never,
      removeServer: async () => ({}) as never,
      getServer: async () => {
        throw new Error('getServer must never be reachable from the servers handler')
      },
      listServers: async () => [],
    }

    composeUi(buildDeps({ registry: fullRegistry }))

    const passed = capturedServersDeps[0]
    expect(hasProperty(passed?.registry, 'getServer')).toBe(false)
    expect(hasProperty(passed?.registry, 'listServers')).toBe(true)
    expect(hasProperty(passed?.registry, 'addServer')).toBe(true)
    expect(hasProperty(passed?.registry, 'removeServer')).toBe(true)
  })

  test('the agents port handed to createServersHandlers has no createAgent/revokeAgent', () => {
    capturedServersDeps.length = 0
    const fullAgents: AgentsStore = {
      createAgent: async () => {
        throw new Error('createAgent must never be reachable from the servers handler')
      },
      revokeAgent: async () => {
        throw new Error('revokeAgent must never be reachable from the servers handler')
      },
      grantServer: async () => ({}) as never,
      ungrantServer: async () => ({}) as never,
      getAgent: async () => undefined,
      listAgents: async () => [],
      findAgentByToken: async () => undefined,
    }

    composeUi(buildDeps({ agents: fullAgents }))

    const passed = capturedServersDeps[0]
    expect(hasProperty(passed?.agents, 'createAgent')).toBe(false)
    expect(hasProperty(passed?.agents, 'revokeAgent')).toBe(false)
    expect(hasProperty(passed?.agents, 'listAgents')).toBe(true)
  })
})

describe('composeUi: the serve address reaches the agent pages (ADR-0015, phase 4)', () => {
  test('the address handed to composeUi is the one createAgentsHandlers renders client configs with', () => {
    capturedAgentsDeps.length = 0

    composeUi(buildDeps({}))

    expect(capturedAgentsDeps[0]?.serveAddress).toEqual(WIRING_SERVE_ADDRESS)
  })
})

const WIRING_SERVE_ADDRESS = { url: 'https://plane.example:8090', source: 'config' } as const

interface BuildDepsOverrides {
  readonly vault?: VaultStore
  readonly registry?: RegistryStore
  readonly agents?: AgentsStore
}

function buildDeps(overrides: BuildDepsOverrides): Parameters<typeof composeUi>[0] {
  const adminStore = {} as unknown as AdminStore
  const agents = overrides.agents ?? ({ listAgents: async () => [] } as unknown as AgentsStore)
  const registry =
    overrides.registry ?? ({ listServers: async () => [] } as unknown as RegistryStore)
  const vault = overrides.vault ?? ({ listSecrets: async () => ({ secrets: [] }) } as unknown as VaultStore)
  const hub = { hasCapacity: () => true } as unknown as EventHub

  return {
    journalDir: '/tmp/mcpcut-ui-wiring-test',
    approvalsBaseDir: '/tmp/mcpcut-ui-wiring-test/approvals',
    inventoryStorePath: '/tmp/mcpcut-ui-wiring-test/inventory.json',
    adminStore,
    agents,
    registry,
    vault,
    hub,
    stderr: { write: () => undefined },
    serveAddress: WIRING_SERVE_ADDRESS,
  }
}
