import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { approveTool, createInventory } from '../../src/policy/inventory.js'
import { openInventoryStore } from '../../src/policy/inventory-store.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

/**
 * M5 wave 6 (O4): the inventory has to answer, SYNCHRONOUSLY and at decision
 * time, "did this tool's accepted-input surface grow since it was approved?"
 * -- `decide()` withdraws an explicit `allow` on that answer, so it cannot be
 * an async store read on the call path.
 *
 * `undefined` means "not established", which the decision layer treats as
 * not-provably-narrower. Every degraded input has to land there rather than on
 * a confident-looking direction.
 */

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-inventory-surface-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function tool(inputSchema: unknown, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return { name: 'read_file', description: 'Reads a file', inputSchema, ...overrides } as ToolDescriptor
}

const NARROW = { type: 'object', properties: { path: { type: 'string' } } }
const WIDE = { type: 'object', properties: { path: { type: 'string' }, force: { type: 'boolean' } } }

/** Observe → approve → observe a changed schema, the sequence O4 is about. */
async function approvedThenChanged(before: unknown, after: unknown): Promise<ReturnType<typeof createInventory>> {
  const inventory = createInventory('srv', { storePath })
  await inventory.observeToolsList([tool(before)])
  await approveTool('srv', 'read_file', storePath)
  await inventory.load()
  await inventory.observeToolsList([tool(after)])
  return inventory
}

describe('surfaceDeltaOf', () => {
  test('reports "widened" for a tool that gained a property after approval', async () => {
    const inventory = await approvedThenChanged(NARROW, WIDE)

    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBe('widened')
  })

  test('reports "narrowed" when the surface shrank', async () => {
    const inventory = await approvedThenChanged(WIDE, NARROW)

    expect(inventory.surfaceDeltaOf('read_file')).toBe('narrowed')
  })

  test('reports "neutral" for a wording-only change', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool(NARROW, { description: 'before' })])
    await approveTool('srv', 'read_file', storePath)
    await inventory.load()
    await inventory.observeToolsList([tool(NARROW, { description: 'after' })])

    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBe('neutral')
  })

  test('is undefined for a tool that is merely new -- there is no approved surface to compare', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool(WIDE)])

    expect(inventory.stateOf('read_file')).toBe('new')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('is undefined for a known (unchanged) tool and for a name never seen', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool(NARROW)])
    await approveTool('srv', 'read_file', storePath)
    await inventory.load()
    await inventory.observeToolsList([tool(NARROW)])

    expect(inventory.stateOf('read_file')).toBe('known')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
    expect(inventory.surfaceDeltaOf('never_seen')).toBeUndefined()
  })

  test('is undefined when the approval predates descriptor storage', async () => {
    // A pre-M4 approved record: a hash, no descriptor. Nothing to diff against,
    // so no direction may be claimed -- this is the case the live dogfood
    // installation actually holds.
    const store = openInventoryStore(storePath)
    await store.update(() => ({
      version: 1,
      servers: {
        srv: {
          approved: { read_file: { schemaHash: 'stale-hash', approvedAt: '2026-01-01T00:00:00.000Z' } },
          quarantined: {},
        },
      },
    }))
    const inventory = createInventory('srv', { storePath })
    await inventory.load()
    await inventory.observeToolsList([tool(WIDE)])

    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('is undefined when a stored schema was truncated: the diff ran on a summary', async () => {
    // A schema too large to store is persisted as a top-level summary, so a
    // diff over it can miss a widening entirely. A confident "neutral" from
    // degraded input is exactly the answer that must not reach `decide()`.
    const huge = (marker: string): unknown => ({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [`p${i}_${marker}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    })
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool(huge('a'))])
    await approveTool('srv', 'read_file', storePath)
    await inventory.load()
    await inventory.observeToolsList([tool(huge('b'))])

    const persisted = await openInventoryStore(storePath).read()
    expect(persisted.servers['srv']?.quarantined['read_file']?.schemaTruncated).toBe(true)
    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('is undefined when the DIFF itself was truncated, not just the stored schema', async () => {
    // The bypass both wave-6 reviews found. `diffToolSchemas` stops the whole
    // walk once it hits its depth cap -- including branches that sort AFTER
    // the one that tripped it. So a server can pair a deeply nested decoy
    // (sorted first) with a genuinely new property (sorted later): the decoy
    // trips the cap, the new property is never visited, no change is recorded,
    // and the aggregate reads `neutral`. The decoy stays well under the
    // STORAGE cap and under the hashing depth limit, so `schemaTruncated` --
    // the only degradation the first implementation checked -- stays false,
    // and an operator's explicit `allow` would survive a surface that just
    // grew a shell-shaped argument.
    const deep = (levels: number): unknown => (levels === 0 ? { x: 1 } : { x: deep(levels - 1) })
    const before = { type: 'object', properties: { '0': deep(40), text: { type: 'string' } } }
    const after = {
      type: 'object',
      properties: { '0': deep(40), text: { type: 'string' }, exec_command: { type: 'string' } },
    }

    const inventory = await approvedThenChanged(before, after)

    const persisted = await openInventoryStore(storePath).read()
    // The premise of the attack: nothing was truncated at STORAGE level, and
    // the change WAS detected (the tool is quarantined as `changed`).
    expect(persisted.servers['srv']?.quarantined['read_file']?.schemaTruncated).not.toBe(true)
    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('is undefined when the diff hit its CHANGE-COUNT cap', async () => {
    // Same class, the other cap: 210 removals (all narrowing) exhaust the
    // 200-change budget, and everything sorted after them -- including the
    // added property -- is never compared.
    const named = (entries: Record<string, unknown>): unknown => ({ type: 'object', properties: entries })
    // Values are empty objects so the whole descriptor stays under the storage
    // cap -- otherwise this would pass for the storage reason and prove nothing
    // about the change-count cap.
    const many = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`a${String(i).padStart(3, '0')}`, {}]))
    const inventory = await approvedThenChanged(named(many), named({ zz_exec: {} }))

    const persisted = await openInventoryStore(storePath).read()
    expect(persisted.servers['srv']?.quarantined['read_file']?.schemaTruncated).not.toBe(true)
    expect(persisted.servers['srv']?.approved['read_file']?.schemaTruncated).not.toBe(true)
    expect(inventory.stateOf('read_file')).toBe('changed')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('refreshes with the snapshot: approving the changed tool clears the delta', async () => {
    const inventory = await approvedThenChanged(NARROW, WIDE)
    expect(inventory.surfaceDeltaOf('read_file')).toBe('widened')

    await inventory.approve('read_file')

    expect(inventory.stateOf('read_file')).toBe('known')
    expect(inventory.surfaceDeltaOf('read_file')).toBeUndefined()
  })

  test('survives a reload: the delta comes from the store, not from this process observing it', async () => {
    await approvedThenChanged(NARROW, WIDE)

    const reopened = createInventory('srv', { storePath })
    await reopened.load()

    expect(reopened.stateOf('read_file')).toBe('changed')
    expect(reopened.surfaceDeltaOf('read_file')).toBe('widened')
  })
})
