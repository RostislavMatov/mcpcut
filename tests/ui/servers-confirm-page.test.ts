import { describe, expect, test } from 'vitest'
import type { PolicyView } from '../../src/policy/edit/policy-view.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy } from '../../src/policy/schema.js'
import { TENANT_SETTINGS } from '../../src/tenant/settings.js'
import { createServersHandlers, type ServersHandlersDeps } from '../../src/ui/handlers/servers.js'
import type { UiRequestContext } from '../../src/ui/routes.js'

/**
 * `GET /servers` feeds the client rule's agent choices (agents with a grant,
 * personal or through a group, never a revoked one) and the "On this machine"
 * section (inventory servers that are not registered; not on a tenant install).
 */

const OWNER = { adminName: 'olga', role: 'owner' as const, csrfToken: 'csrf' }

const GRANT = { tools: '*' }
const AGENTS = [
  { name: 'laptop', grants: { github: GRANT } },
  { name: 'via-group', grants: {} },
  { name: 'revoked', grants: { github: GRANT }, revokedAt: '2026-09-01T00:00:00.000Z' },
  { name: 'other', grants: { slack: GRANT } },
]
const GROUPS = [{ name: 'team', members: ['via-group'], grants: { github: GRANT } }]

const INVENTORY: InventoryStoreData = {
  version: 1,
  servers: Object.fromEntries(
    ['github', 'my-local', 'auto:ab12cd'].map((name) => [
      name,
      { approved: { run: { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' } }, quarantined: {} },
    ]),
  ),
}

const POLICY = (() => {
  const parsed = parsePolicy({ version: 1 })
  if (!parsed.ok) throw new Error('fixture')
  return parsed.policy
})()
const POLICY_VIEW: PolicyView = {
  status: 'loaded',
  policy: POLICY,
  hash: policyHashOf(POLICY),
  sourcePath: '/state/policy.json',
  readers: { kind: 'every-entry-point' },
}

async function pageWith(overrides: Partial<ServersHandlersDeps> = {}): Promise<string> {
  const deps = {
    registry: { listServers: async () => [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }] },
    agents: { listAgents: async () => AGENTS },
    groups: { listGroups: async () => GROUPS },
    vault: { listSecrets: async () => ({ status: 'listed', secrets: [] }) },
    readInventory: async () => INVENTORY,
    readPolicyView: async () => POLICY_VIEW,
    ...overrides,
  } as unknown as ServersHandlersDeps
  const ctx: UiRequestContext = {
    method: 'GET',
    path: '/servers',
    params: {},
    query: new URLSearchParams(),
    session: OWNER,
    body: Buffer.alloc(0),
    headers: {},
  }
  const result = await createServersHandlers(deps).serversPage(ctx)
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return String(result.body)
}

function githubPanel(documentHtml: string): string {
  const start = documentHtml.indexOf('id="tools-github"')
  return documentHtml.slice(start, documentHtml.indexOf('</details>', start))
}

describe('the client rule agent choices', () => {
  test('lists agents with a grant (personal or via a group), skipping revoked and other-server ones', async () => {
    const panel = githubPanel(await pageWith())
    expect(panel).toContain('name="agent" value="laptop"')
    expect(panel).toContain('name="agent" value="via-group"')
    expect(panel).not.toContain('value="revoked"')
    expect(panel).not.toContain('value="other"')
  })

  test('with no grant anywhere the next step names a real agent', async () => {
    const panel = githubPanel(await pageWith({ groups: { listGroups: async () => [] }, agents: { listAgents: async () => [AGENTS[3]] } } as never))
    expect(panel).toContain('<code>mcpcut agent grant other github</code>')
  })
})

describe('On this machine (wrap)', () => {
  test('lists inventory servers that are not registered', async () => {
    const document = await pageWith()
    expect(document).toContain('On this machine (wrap)')
    expect(document).toContain('id="tools-my-local"')
    expect(document).toContain('id="tools-auto:ab12cd"')
    expect(document.match(/id="tools-github"/g)).toHaveLength(1)
  })

  test('absent without an inventory port, with nothing unregistered, and on a tenant install', async () => {
    expect(await pageWith({ readInventory: undefined })).not.toContain('On this machine')
    const onlyRegistered = { version: 1, servers: { github: INVENTORY.servers['github'] } }
    expect(await pageWith({ readInventory: async () => onlyRegistered } as never)).not.toContain('On this machine')
    expect(await pageWith({ tenant: { ...TENANT_SETTINGS, isTenant: true } })).not.toContain('On this machine')
  })
})
