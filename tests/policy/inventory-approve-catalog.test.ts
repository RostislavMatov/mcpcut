import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { approveCatalog, createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import { openInventoryStore } from '../../src/policy/inventory-store.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

/**
 * `approveCatalog` confirms a whole catalog at once: what mcpcut ships itself
 * (the built-in file server) needs no quarantine stop on its first call.
 */

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-approve-catalog-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const LIST_ROOTS: ToolDescriptor = { name: 'list_roots', description: 'Lists the folders', inputSchema: { type: 'object' } }
const READ_FILE: ToolDescriptor = { name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
const NOW = '2026-10-09T12:00:00.000Z'

async function stateAfterObserve(serverName: string, tools: readonly ToolDescriptor[]) {
  const inventory = createInventory(serverName, { storePath })
  await inventory.load()
  return inventory.observeToolsList(tools)
}

describe('approveCatalog', () => {
  test('approves every listed tool, so the next observation finds them all known', async () => {
    const approved = await approveCatalog('files', [LIST_ROOTS, READ_FILE], storePath, NOW)

    expect(approved).toEqual(['list_roots', 'read_file'])
    const observed = await stateAfterObserve('files', [LIST_ROOTS, READ_FILE])
    expect(observed.known).toEqual(['list_roots', 'read_file'])
    expect(observed.new).toEqual([])
    expect(observed.changed).toEqual([])
  })

  test('stores the approval time and the descriptor, as a quarantine approval does', async () => {
    await approveCatalog('files', [READ_FILE], storePath, NOW)

    const record = (await openInventoryStore(storePath).read()).servers['files']?.approved['read_file']
    expect(record?.approvedAt).toBe(NOW)
    expect(record?.descriptor?.name).toBe('read_file')
    expect(record?.descriptor?.annotations).toEqual({ readOnlyHint: true })
  })

  test('is idempotent: a second run approves nothing and keeps the first approval time', async () => {
    await approveCatalog('files', [LIST_ROOTS], storePath, NOW)
    const again = await approveCatalog('files', [LIST_ROOTS], storePath, '2026-10-10T00:00:00.000Z')

    expect(again).toEqual([])
    expect((await openInventoryStore(storePath).read()).servers['files']?.approved['list_roots']?.approvedAt).toBe(NOW)
  })

  test('re-approves a tool whose schema changed since its approval', async () => {
    await approveCatalog('files', [LIST_ROOTS], storePath, NOW)
    const changed = { ...LIST_ROOTS, description: 'Lists the folders you may use' }

    expect(await approveCatalog('files', [changed], storePath, NOW)).toEqual(['list_roots'])
    expect((await stateAfterObserve('files', [changed])).known).toEqual(['list_roots'])
  })

  test('clears a quarantined copy of the tool it approves', async () => {
    await stateAfterObserve('files', [LIST_ROOTS])
    expect(await listAllQuarantined(storePath)).toHaveLength(1)

    await approveCatalog('files', [LIST_ROOTS], storePath, NOW)

    expect(await listAllQuarantined(storePath)).toEqual([])
  })

  test('releases a tool approved at its current hash but still held by an older quarantined schema', async () => {
    await approveCatalog('files', [LIST_ROOTS], storePath, NOW)
    await stateAfterObserve('files', [{ ...LIST_ROOTS, description: 'a later version' }])

    expect(await approveCatalog('files', [LIST_ROOTS], storePath, NOW)).toEqual(['list_roots'])

    expect(await listAllQuarantined(storePath)).toEqual([])
    const inventory = createInventory('files', { storePath })
    await inventory.load()
    expect(inventory.stateOf('list_roots')).toBe('known')
  })

  test('leaves the other servers alone', async () => {
    await stateAfterObserve('probe', [LIST_ROOTS])

    await approveCatalog('files', [LIST_ROOTS], storePath, NOW)

    expect((await listAllQuarantined(storePath)).map((entry) => entry.serverName)).toEqual(['probe'])
    expect((await stateAfterObserve('probe', [LIST_ROOTS])).new).toEqual(['list_roots'])
  })
})
