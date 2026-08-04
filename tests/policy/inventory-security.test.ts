import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_QUARANTINED_TOOLS_PER_SERVER, MAX_STORED_DESCRIPTOR_CHARS } from '../../src/policy/constants.js'
import { createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-inv-sec-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Builds an object nested `depth` levels deep, to trip the canonical-json depth guard. */
function deepObject(depth: number): unknown {
  let node: unknown = { leaf: true }
  for (let i = 0; i < depth; i += 1) node = { nested: node }
  return node
}

async function readStore(path: string): Promise<{
  version: number
  servers: Record<string, { quarantined: Record<string, { descriptor: ToolDescriptor }> }>
}> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('C3: one poisoned descriptor never disables quarantine for the batch', () => {
  test('a 70-deep inputSchema decoy is quarantined (unhashable), alongside its siblings', async () => {
    const inventory = createInventory('srv', { storePath })

    const result = await inventory.observeToolsList([
      { name: 'safe_tool', description: 'ok' },
      { name: 'decoy', inputSchema: deepObject(70) },
      { name: 'other_tool', description: 'also ok' },
    ])

    expect(result.failed).toBe(false)
    expect(result.new.sort()).toEqual(['decoy', 'other_tool', 'safe_tool'])
    expect(inventory.stateOf('decoy')).toBe('new')
    expect(inventory.stateOf('safe_tool')).toBe('new')
  })

  test('observeToolsList never throws even if every descriptor is unhashable', async () => {
    const inventory = createInventory('srv', { storePath })
    await expect(
      inventory.observeToolsList([{ name: 'a', inputSchema: deepObject(80) }]),
    ).resolves.toMatchObject({ failed: false })
  })

  test('the unhashable decoy persists with a synthetic hash and a placeholder descriptor', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([{ name: 'decoy', inputSchema: deepObject(80) }])

    const stored = (await readStore(storePath)).servers['srv']?.quarantined['decoy']
    expect(stored).toBeDefined()
    expect((stored as unknown as { schemaHash: string }).schemaHash.startsWith('unhashable:')).toBe(true)
    expect(stored?.descriptor.inputSchema).toBeUndefined()
  })
})

describe('C4: quarantine cannot be escaped by re-listing / survives pagination', () => {
  test('a tool from page 1 stays enforced after page 2 (both pages remain quarantined)', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([{ name: 'page1_tool' }])
    await inventory.observeToolsList([{ name: 'page2_tool' }])

    expect(inventory.stateOf('page1_tool')).toBe('new')
    expect(inventory.stateOf('page2_tool')).toBe('new')
  })

  test('omitting a quarantined tool from a later list does not clear its state', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([{ name: 'sneaky' }])
    await inventory.observeToolsList([{ name: 'decoy_only' }])

    expect(inventory.stateOf('sneaky')).toBe('new')
  })
})

describe('C4/H5: load() hydrates snapshot and reports catalog state', () => {
  test('load() makes stateOf authoritative before any observe', async () => {
    const seed = createInventory('srv', { storePath })
    await seed.observeToolsList([{ name: 'approved_tool' }, { name: 'pending_tool' }])
    await seed.approve('approved_tool')

    const fresh = createInventory('srv', { storePath })
    expect(fresh.hasObservedCatalog()).toBe(false)
    await fresh.load()

    expect(fresh.stateOf('approved_tool')).toBe('known')
    expect(fresh.stateOf('pending_tool')).toBe('new')
    expect(fresh.isCatalogTrusted()).toBe(true)
  })

  test('load() is idempotent', async () => {
    const seed = createInventory('srv', { storePath })
    await seed.observeToolsList([{ name: 'pending_tool' }])

    const fresh = createInventory('srv', { storePath })
    await fresh.load()
    await fresh.load()

    expect(fresh.stateOf('pending_tool')).toBe('new')
  })

  test('a corrupt store leaves the catalog untrusted (never throws)', async () => {
    await writeFile(storePath, '{ this is not json', 'utf8')
    const inventory = createInventory('srv', { storePath })

    await expect(inventory.load()).resolves.toBeUndefined()
    expect(inventory.isCatalogTrusted()).toBe(false)
  })

  test('a failed observe (corrupt store) sets failed and untrusts the catalog', async () => {
    await writeFile(storePath, 'not json at all', 'utf8')
    const inventory = createInventory('srv', { storePath })

    const result = await inventory.observeToolsList([{ name: 'x' }])

    expect(result.failed).toBe(true)
    expect(inventory.isCatalogTrusted()).toBe(false)
    expect(inventory.hasObservedCatalog()).toBe(true)
  })

  test('a clean observe after a failure resets trust to true', async () => {
    const inventory = createInventory('srv', { storePath })
    // First force a corrupt read...
    await writeFile(storePath, 'garbage', 'utf8')
    await inventory.observeToolsList([{ name: 'x' }])
    expect(inventory.isCatalogTrusted()).toBe(false)

    // ...then repair the store and observe cleanly.
    await rm(storePath, { force: true })
    const result = await inventory.observeToolsList([{ name: 'x' }])

    expect(result.failed).toBe(false)
    expect(inventory.isCatalogTrusted()).toBe(true)
  })
})

describe('M10: unbounded inventory growth is capped, fail closed', () => {
  test('a list beyond the per-server cap does not persist every entry and untrusts the catalog', async () => {
    const inventory = createInventory('srv', { storePath })
    const tools = Array.from({ length: MAX_QUARANTINED_TOOLS_PER_SERVER + 100 }, (_, i) => ({
      name: `tool_${i}`,
    }))

    const result = await inventory.observeToolsList(tools)

    expect(result.failed).toBe(false)
    expect(inventory.isCatalogTrusted()).toBe(false)
    const stored = (await readStore(storePath)).servers['srv']?.quarantined ?? {}
    expect(Object.keys(stored).length).toBeLessThanOrEqual(MAX_QUARANTINED_TOOLS_PER_SERVER)
  })

  test('inputSchema is dropped from the stored copy but a schema change is still detected via the hash', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([{ name: 't', inputSchema: { type: 'object', v: 1 } }])
    await inventory.approve('t')

    const changed = await inventory.observeToolsList([
      { name: 't', inputSchema: { type: 'object', v: 2 } },
    ])

    expect(changed.changed).toEqual(['t'])
    const stored = (await readStore(storePath)).servers['srv']?.quarantined['t']
    expect(stored?.descriptor.inputSchema).toBeUndefined()
  })

  test('an oversized descriptor is stored capped (annotations dropped past the byte cap)', async () => {
    const inventory = createInventory('srv', { storePath })
    const huge = 'y'.repeat(MAX_STORED_DESCRIPTOR_CHARS + 4000)

    await inventory.observeToolsList([{ name: 't', annotations: { note: huge } as never }])

    const stored = (await readStore(storePath)).servers['srv']?.quarantined['t']
    expect(JSON.stringify(stored?.descriptor).length).toBeLessThanOrEqual(MAX_STORED_DESCRIPTOR_CHARS)
  })
})

describe('TS-C1: a tool literally named __proto__ does not corrupt the shared store', () => {
  test('__proto__ is quarantined and handled like any other tool', async () => {
    const inventory = createInventory('srv', { storePath })

    const result = await inventory.observeToolsList([{ name: '__proto__' }, { name: 'normal' }])

    expect(result.failed).toBe(false)
    expect(inventory.stateOf('__proto__')).toBe('new')
    expect(inventory.stateOf('normal')).toBe('new')
  })

  test('the store stays readable and other servers keep working after a __proto__ tool', async () => {
    const a = createInventory('server-a', { storePath })
    const b = createInventory('server-b', { storePath })
    await a.observeToolsList([{ name: '__proto__' }, { name: 'constructor' }, { name: 'prototype' }])
    await b.observeToolsList([{ name: 'ok_tool' }])

    const all = await listAllQuarantined(storePath)
    const names = all.map((e) => `${e.serverName}/${e.toolName}`).sort()
    expect(names).toContain('server-a/__proto__')
    expect(names).toContain('server-b/ok_tool')

    // A second observe still works (the store was not corrupted).
    const again = await b.observeToolsList([{ name: 'ok_tool' }, { name: 'second' }])
    expect(again.failed).toBe(false)
  })
})
