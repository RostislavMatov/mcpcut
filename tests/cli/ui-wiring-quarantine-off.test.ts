import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { composeUi, type UiComposition } from '../../src/cli/ui-wiring.js'
import { POLICY_FILE_NAME } from '../../src/policy/constants.js'
import { CREATED_POLICY_DOCUMENT } from '../../src/policy/edit/created-policy.js'
import { INVENTORY_FILE_NAME, type InventoryStoreData } from '../../src/policy/inventory-store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createEventHub } from '../../src/ui/events.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import { createVaultStore } from '../../src/vault/store.js'

/**
 * Wiring smoke for the dashboard and the Quarantine page under a policy that
 * turns quarantine OFF — the "Create policy" starter and the README's Stop
 * policy (ADR-0009, amendment 2026-10-02). Found in the stranger run of
 * 2026-10-03: after `adopt --apply` and Create policy, the dashboard showed a
 * strong "Quarantined 14" tile and the Quarantine page "14 held" while every
 * call passed. The production handler map from `composeUi` over a REAL temp
 * state dir: a wrapped server `fs` (seen in the inventory, not registered)
 * with one new tool.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }

const INVENTORY: InventoryStoreData = {
  version: 1,
  servers: {
    fs: {
      approved: {},
      quarantined: {
        write_file: {
          schemaHash: 'h1',
          firstSeenAt: '2026-10-03T11:44:00.000Z',
          state: 'new',
          descriptor: { name: 'write_file', inputSchema: { type: 'object' } },
        },
      },
    },
  },
}

let dir = ''
let composed: UiComposition

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-ui-wiring-qoff-'))
  await writeFile(join(dir, INVENTORY_FILE_NAME), JSON.stringify(INVENTORY))
  composed = composeUi({
    journalDir: dir,
    approvalsBaseDir: join(dir, 'approvals'),
    inventoryStorePath: join(dir, INVENTORY_FILE_NAME),
    adminStore: createAdminStore({ journalDir: dir }),
    agents: createAgentsStore({ journalDir: dir }),
    registry: createRegistryStore(dir),
    vault: createVaultStore({ journalDir: dir }),
    hub: createEventHub(),
    stderr: { write: () => true },
    env: {},
    cwd: dir,
  })
})

afterEach(async () => {
  await composed.closeProbes()
  await rm(dir, { recursive: true, force: true })
})

function get(path: string): UiRequestContext {
  return { method: 'GET', path, params: {}, query: new URLSearchParams(), session: OWNER, body: Buffer.alloc(0), headers: {} }
}

function bodyOf(result: UiResult): string {
  return result.kind === 'response' ? String(result.body ?? '') : ''
}

async function writePolicy(document: unknown): Promise<void> {
  await writeFile(join(dir, POLICY_FILE_NAME), JSON.stringify(document))
}

async function dashboard(): Promise<string> {
  return bodyOf(await composed.handlers.approvalsPage(get('/')))
}

async function quarantinePage(): Promise<string> {
  return bodyOf(await composed.handlers.quarantinePage(get('/quarantine')))
}

describe('composeUi: quarantine off in the policy', () => {
  test('the starter policy: the dashboard says off and the page says nothing is held', async () => {
    await writePolicy(CREATED_POLICY_DOCUMENT)

    const home = await dashboard()
    expect(home).toContain('<span class="tile-value num">off</span><span class="tile-unit">rules still apply</span>')
    expect(home).toContain('Seen in the tool inventory, not registered: fs —')
    expect(home).not.toContain('tool(s) quarantined')

    const page = await quarantinePage()
    expect(page).toContain('1 seen · not held')
    expect(page).toContain('Quarantine is off in the policy')
  })

  test('a policy that keeps quarantine on still counts the tool as held', async () => {
    await writePolicy({ version: 1, defaultDecision: 'allow' })

    expect(await dashboard()).toContain('1 tool(s) quarantined')
    expect(await quarantinePage()).toContain('1 held')
  })

  test('no policy file at all: nothing claims quarantine is off', async () => {
    expect(await dashboard()).toContain('1 tool(s) quarantined')
    expect(await quarantinePage()).toContain('1 held')
  })
})
