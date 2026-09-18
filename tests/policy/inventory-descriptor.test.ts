import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { approveTool, createInventory, rejectTool } from '../../src/policy/inventory.js'
import { openInventoryStore } from '../../src/policy/inventory-store.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

/**
 * A session that never asks for `tools/list` has no descriptor of its own to
 * classify a call from, and whether to ask is the AGENT's choice. The
 * inventory already stores the descriptor every earlier observation saw, so it
 * has to hand it over -- synchronously, because it is read on the decision
 * path exactly like `stateOf` (user-journey smoke 2026-09-18, H1).
 */

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-inventory-descriptor-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const SCHEMA = { type: 'object', properties: { path: { type: 'string' } } }

function writeFile(annotations: ToolDescriptor['annotations']): ToolDescriptor {
  return { name: 'write_file', description: 'Writes a file', inputSchema: SCHEMA, annotations } as ToolDescriptor
}

/** A second process: nothing in memory, only what the store holds. */
async function freshSession(): Promise<ReturnType<typeof createInventory>> {
  const inventory = createInventory('srv', { storePath })
  await inventory.load()
  return inventory
}

describe('descriptorOf', () => {
  test('is undefined for a tool no observation has ever seen', async () => {
    const inventory = await freshSession()

    expect(inventory.descriptorOf('write_file')).toBeUndefined()
  })

  test('hands a fresh session the quarantined descriptor, annotations included', async () => {
    await createInventory('srv', { storePath }).observeToolsList([writeFile({ destructiveHint: true })])

    const inventory = await freshSession()

    expect(inventory.stateOf('write_file')).toBe('new')
    expect(inventory.descriptorOf('write_file')?.annotations?.destructiveHint).toBe(true)
  })

  test('hands a fresh session the approved descriptor once the tool is released', async () => {
    await createInventory('srv', { storePath }).observeToolsList([writeFile({ destructiveHint: true })])
    await approveTool('srv', 'write_file', storePath)

    const inventory = await freshSession()

    expect(inventory.stateOf('write_file')).toBe('known')
    expect(inventory.descriptorOf('write_file')?.annotations?.destructiveHint).toBe(true)
  })

  test('prefers the latest observed (quarantined) descriptor over the approved one', async () => {
    const first = createInventory('srv', { storePath })
    await first.observeToolsList([writeFile({ destructiveHint: false })])
    await approveTool('srv', 'write_file', storePath)
    await first.load()
    await first.observeToolsList([{ ...writeFile({ destructiveHint: true }), description: 'Now overwrites' }])

    const inventory = await freshSession()

    // The same descriptor a `tools/list` in this session would have cached.
    expect(inventory.stateOf('write_file')).toBe('changed')
    expect(inventory.descriptorOf('write_file')?.annotations?.destructiveHint).toBe(true)
  })

  test('is undefined for an approval that predates descriptor storage, while the state stays known', async () => {
    await openInventoryStore(storePath).update((current) => ({
      ...current,
      servers: { srv: { approved: { write_file: { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' } }, quarantined: {} } },
    }))

    const inventory = await freshSession()

    expect(inventory.stateOf('write_file')).toBe('known')
    expect(inventory.descriptorOf('write_file')).toBeUndefined()
  })

  test('keeps the class hints of a descriptor padded past the storage cap', async () => {
    // The server controls the descriptor's size. Dropping the annotations
    // wholesale to fit the cap would hand a padded `destructive` tool back to
    // name-only classification -- exactly for the sessions that never list.
    const padded = {
      ...writeFile({ destructiveHint: true, readOnlyHint: false }),
      annotations: { destructiveHint: true, readOnlyHint: false, title: 'x'.repeat(20_000) },
    } as ToolDescriptor
    await createInventory('srv', { storePath }).observeToolsList([padded])

    const stored = (await freshSession()).descriptorOf('write_file')

    expect(stored?.annotations).toEqual({ destructiveHint: true, readOnlyHint: false })
  })

  test('forgets a rejected tool', async () => {
    await createInventory('srv', { storePath }).observeToolsList([writeFile({ destructiveHint: true })])
    await rejectTool('srv', 'write_file', storePath)

    const inventory = await freshSession()

    expect(inventory.descriptorOf('write_file')).toBeUndefined()
  })

  test('does not leak another server’s descriptor', async () => {
    await createInventory('other', { storePath }).observeToolsList([writeFile({ destructiveHint: true })])

    const inventory = await freshSession()

    expect(inventory.descriptorOf('write_file')).toBeUndefined()
  })
})
