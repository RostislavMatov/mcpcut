import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { listedTools } from '../../src/files/tools.js'
import { INVENTORY_FILE_NAME, approveCatalog, createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import { openInventoryStore } from '../../src/policy/inventory-store.js'
import { StoreCorruptError } from '../../src/policy/store.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import { DuplicateServerError, createRegistryStore } from '../../src/registry/store.js'

/**
 * Tool approvals are keyed by server name, so a registration owns the
 * approvals under its name: removing a server forgets them, and a server added
 * under a name starts in quarantine whatever an earlier one left behind. Found
 * on 2026-10-09: a server registered as `files` after the built-in one was
 * removed inherited the built-in tools' approvals.
 */

let journalDir: string
let storePath: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-registry-inventory-'))
  storePath = join(journalDir, INVENTORY_FILE_NAME)
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const PROBE: ServerRecord = { name: 'probe', transport: 'stdio', command: 'node', args: ['probe.mjs'] }
const OTHER: ServerRecord = { name: 'other', transport: 'stdio', command: 'node', args: ['other.mjs'] }
const ECHO: ToolDescriptor = { name: 'echo', description: 'Echoes', inputSchema: { type: 'object' } }
const BUILTIN_FILES: ServerRecord = { name: 'files', transport: 'builtin', kind: 'files' }
const FOREIGN_FILES: ServerRecord = { name: 'files', transport: 'stdio', command: 'node', args: ['look-alike.mjs'] }

async function observe(serverName: string, tools: readonly ToolDescriptor[]) {
  const inventory = createInventory(serverName, { storePath })
  await inventory.load()
  return inventory.observeToolsList(tools)
}

async function serverEntryOf(serverName: string) {
  return (await openInventoryStore(storePath).read()).servers[serverName]
}

describe('the registry owns the tool approvals under a server name', () => {
  test('removing a server forgets its approved and its quarantined tools', async () => {
    const registry = createRegistryStore(journalDir)
    await registry.addServer(PROBE)
    await approveCatalog('probe', [ECHO], storePath)
    await observe('probe', [{ name: 'later', description: 'new tool' }])

    expect((await registry.removeServer('probe')).status).toBe('removed')

    expect(await serverEntryOf('probe')).toBeUndefined()
    expect(await listAllQuarantined(storePath)).toEqual([])
  })

  test("removing one server leaves another server's approvals alone", async () => {
    const registry = createRegistryStore(journalDir)
    await registry.addServer(PROBE)
    await registry.addServer(OTHER)
    await approveCatalog('other', [ECHO], storePath)

    await registry.removeServer('probe')

    expect((await observe('other', [ECHO])).known).toEqual(['echo'])
  })

  test('a server added under a name starts in quarantine, whatever an earlier registration left behind', async () => {
    await approveCatalog('probe', [ECHO], storePath)

    await createRegistryStore(journalDir).addServer(PROBE)

    expect((await observe('probe', [ECHO])).new).toEqual(['echo'])
  })

  test('a refused duplicate add leaves the registered server its approvals', async () => {
    const registry = createRegistryStore(journalDir)
    await registry.addServer(PROBE)
    await approveCatalog('probe', [ECHO], storePath)

    await expect(registry.addServer(PROBE)).rejects.toThrow(DuplicateServerError)

    expect((await observe('probe', [ECHO])).known).toEqual(['echo'])
  })

  test('removing a name the registry does not hold changes no approvals', async () => {
    await approveCatalog('probe', [ECHO], storePath)

    expect((await createRegistryStore(journalDir).removeServer('probe')).status).toBe('not-found')

    expect(Object.keys((await serverEntryOf('probe'))?.approved ?? {})).toEqual(['echo'])
  })

  test('editing a registered server keeps its approvals', async () => {
    const registry = createRegistryStore(journalDir)
    await registry.addServer(PROBE)
    await approveCatalog('probe', [ECHO], storePath)

    await registry.updateServer({ ...PROBE, env: { DEBUG: '1' } })

    expect((await observe('probe', [ECHO])).known).toEqual(['echo'])
  })

  test('a look-alike registered as files after the built-in was removed meets every tool in quarantine', async () => {
    const registry = createRegistryStore(journalDir)
    const builtin = JSON.parse(JSON.stringify(listedTools({ isSearchListed: true }))) as ToolDescriptor[]
    await registry.addServer(BUILTIN_FILES)
    await approveCatalog('files', builtin, storePath)

    await registry.removeServer('files')
    await registry.addServer(FOREIGN_FILES)

    const observed = await observe('files', builtin)
    expect(observed.known).toEqual([])
    expect(observed.new).toEqual(builtin.map((tool) => tool.name))
  })

  test('a corrupt inventory refuses add and remove with the registry unchanged', async () => {
    const registry = createRegistryStore(journalDir)
    await registry.addServer(PROBE)
    const elsewhere = join(journalDir, 'broken', INVENTORY_FILE_NAME)
    await mkdir(join(journalDir, 'broken'))
    await writeFile(elsewhere, '{ not json', 'utf8')
    const broken = createRegistryStore(journalDir, { inventoryStorePath: elsewhere })

    await expect(broken.removeServer('probe')).rejects.toThrow(StoreCorruptError)
    await expect(broken.addServer(OTHER)).rejects.toThrow(StoreCorruptError)

    expect((await registry.listServers()).map((server) => server.name)).toEqual(['probe'])
  })

  test('honours an inventory kept outside the journal directory', async () => {
    const elsewhere = join(journalDir, 'elsewhere', INVENTORY_FILE_NAME)
    const registry = createRegistryStore(journalDir, { inventoryStorePath: elsewhere })
    await registry.addServer(PROBE)
    await approveCatalog('probe', [ECHO], elsewhere)

    await registry.removeServer('probe')

    expect((await openInventoryStore(elsewhere).read()).servers['probe']).toBeUndefined()
  })
})
