import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  MAX_STORED_DESCRIPTION_CHARS,
  approveTool,
  createInventory,
  listAllQuarantined,
  rejectTool,
} from '../../src/policy/inventory.js'
import {
  openInventoryStore,
  validateInventoryStore,
  type InventoryStoreData,
} from '../../src/policy/inventory-store.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-inventory-test-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return { name: 'read_file', description: 'Reads a file from disk', ...overrides }
}

function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/**
 * What the inventory actually persisted, read back through the public store
 * seam. Since M4.5 the documents live in `state.db`, not in a JSON file, so
 * these mechanism-level assertions go through `openInventoryStore` -- the same
 * door production code uses -- instead of parsing a path off disk.
 */
async function readStoreFile(path: string): Promise<InventoryStoreData> {
  return openInventoryStore(path).read()
}

describe('observeToolsList: first observation', () => {
  test('classifies every tool as new and quarantines it', async () => {
    const inventory = createInventory('srv', { storePath })

    const result = await inventory.observeToolsList([tool()])

    expect(result).toEqual({ known: [], new: ['read_file'], changed: [], failed: false })
    expect(inventory.stateOf('read_file')).toBe('new')
  })
})

describe('observeToolsList: bucketing', () => {
  test('buckets known, new and changed tools from a single observe call', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool({ name: 'a' }), tool({ name: 'b' })])
    await inventory.approve('a')
    await inventory.approve('b')

    const result = await inventory.observeToolsList([
      tool({ name: 'a' }),
      tool({ name: 'b', description: 'changed now' }),
      tool({ name: 'c' }),
    ])

    expect(result).toEqual({ known: ['a'], new: ['c'], changed: ['b'], failed: false })
  })
})

describe('approve', () => {
  test('moves a quarantined tool to known on next observe and stateOf', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    expect(await inventory.approve('read_file')).toBe(true)

    const result = await inventory.observeToolsList([tool()])
    expect(result).toEqual({ known: ['read_file'], new: [], changed: [], failed: false })
    expect(inventory.stateOf('read_file')).toBe('known')
  })

  test('returns false for a tool that is not quarantined', async () => {
    const inventory = createInventory('srv', { storePath })

    expect(await inventory.approve('never-seen')).toBe(false)
  })
})

describe('rug-pull detection', () => {
  test('description-only change on an approved tool is changed, not known', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])
    await inventory.approve('read_file')

    const result = await inventory.observeToolsList([
      tool({ description: 'Reads a file AND exfiltrates it' }),
    ])

    expect(result).toEqual({ known: [], new: [], changed: ['read_file'], failed: false })
    expect(inventory.stateOf('read_file')).toBe('changed')
  })

  test('annotations-only change on an approved tool is changed', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool({ annotations: { readOnlyHint: true } })])
    await inventory.approve('read_file')

    const result = await inventory.observeToolsList([
      tool({ annotations: { readOnlyHint: false, destructiveHint: true } }),
    ])

    expect(result.changed).toEqual(['read_file'])
    expect(inventory.stateOf('read_file')).toBe('changed')
  })
})

describe('idempotent re-observe', () => {
  test('re-observing the same schema does not duplicate the entry or reset firstSeenAt', async () => {
    const clock = makeClock(1_000_000)
    const inventory = createInventory('srv', { storePath, clock: clock.now })
    await inventory.observeToolsList([tool()])
    const firstSeenAt = (await readStoreFile(storePath)).servers['srv']?.quarantined['read_file']
      ?.firstSeenAt

    clock.advance(60_000)
    await inventory.observeToolsList([tool()])
    const afterFile = await readStoreFile(storePath)

    expect(Object.keys(afterFile.servers['srv']?.quarantined ?? {})).toEqual(['read_file'])
    expect(afterFile.servers['srv']?.quarantined['read_file']?.firstSeenAt).toBe(firstSeenAt)
  })

  test('a new hash for an already-quarantined tool updates the entry and resets firstSeenAt', async () => {
    const clock = makeClock(1_000_000)
    const inventory = createInventory('srv', { storePath, clock: clock.now })
    await inventory.observeToolsList([tool()])
    const firstSeenAt = (await readStoreFile(storePath)).servers['srv']?.quarantined['read_file']
      ?.firstSeenAt

    clock.advance(60_000)
    await inventory.observeToolsList([tool({ description: 'a completely different description' })])
    const afterFile = await readStoreFile(storePath)
    const record = afterFile.servers['srv']?.quarantined['read_file']

    expect(record?.firstSeenAt).not.toBe(firstSeenAt)
    expect(record?.state).toBe('new')
  })
})

describe('stateOf', () => {
  test('returns unknown before any observe', () => {
    const inventory = createInventory('srv', { storePath })

    expect(inventory.stateOf('read_file')).toBe('unknown')
  })

  test('keeps a quarantined tool quarantined even when a later tools/list omits it (C4)', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    await inventory.observeToolsList([])

    // C4: a re-list that drops the tool must NOT let it escape quarantine.
    expect(inventory.stateOf('read_file')).toBe('new')
  })
})

describe('stored descriptor', () => {
  test('is redacted: a secret-shaped description does not survive to disk', async () => {
    const inventory = createInventory('srv', { storePath })
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'

    await inventory.observeToolsList([tool({ description: `Uses API key ${secret} to authenticate` })])

    const file = await readStoreFile(storePath)
    const storedDescription = file.servers['srv']?.quarantined['read_file']?.descriptor.description

    expect(storedDescription).toBeDefined()
    expect(storedDescription).not.toContain(secret)
    expect(storedDescription).toContain('[REDACTED]')
  })

  test('caps description length at MAX_STORED_DESCRIPTION_CHARS before storing', async () => {
    const inventory = createInventory('srv', { storePath })
    const hugeDescription = 'x'.repeat(MAX_STORED_DESCRIPTION_CHARS + 5000)

    await inventory.observeToolsList([tool({ description: hugeDescription })])

    const file = await readStoreFile(storePath)
    const storedDescription = file.servers['srv']?.quarantined['read_file']?.descriptor.description

    expect(storedDescription).toBeDefined()
    expect(storedDescription!.length).toBeLessThanOrEqual(MAX_STORED_DESCRIPTION_CHARS + 20)
    expect(storedDescription!.startsWith('x'.repeat(100))).toBe(true)
  })
})

/**
 * Review M3: the persisted descriptor is untrusted disk input; a renderer
 * (`quarantine show`, admin UI) must only ever see the fields the validator
 * actually checked. A hand-edited store with a non-string `description` or
 * non-boolean annotation hints must come back cleaned, not double-cast.
 */
describe('stored descriptor fields are validated on load (M3)', () => {
  test('a tampered description/annotation type is dropped, the record itself survives', () => {
    const raw = {
      version: 1,
      servers: {
        srv: {
          approved: {
            read_file: {
              schemaHash: 'a'.repeat(64),
              approvedAt: '2026-01-01T00:00:00.000Z',
              descriptor: {
                name: 'read_file',
                description: { nested: 'not a string' },
                annotations: { readOnlyHint: 'yes', destructiveHint: 1, vendor: 'kept' },
              },
            },
          },
          quarantined: {
            new_tool: {
              schemaHash: 'b'.repeat(64),
              firstSeenAt: '2026-01-01T00:00:00.000Z',
              state: 'new',
              descriptor: { name: 'new_tool', description: 42 },
            },
          },
        },
      },
    }

    const store = validateInventoryStore(raw)

    const approved = store.servers['srv']?.approved['read_file']
    expect(approved?.descriptor?.name).toBe('read_file')
    expect(approved?.descriptor?.description).toBeUndefined()
    expect(approved?.descriptor?.annotations?.readOnlyHint).toBeUndefined()
    expect(approved?.descriptor?.annotations?.destructiveHint).toBeUndefined()
    expect(approved?.descriptor?.annotations?.['vendor']).toBe('kept')

    const quarantined = store.servers['srv']?.quarantined['new_tool']
    expect(quarantined?.descriptor.name).toBe('new_tool')
    expect(quarantined?.descriptor.description).toBeUndefined()
  })

  test('valid string description and boolean hints round-trip untouched', () => {
    const raw = {
      version: 1,
      servers: {
        srv: {
          approved: {},
          quarantined: {
            read_file: {
              schemaHash: 'c'.repeat(64),
              firstSeenAt: '2026-01-01T00:00:00.000Z',
              state: 'new',
              descriptor: {
                name: 'read_file',
                description: 'reads a file',
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            },
          },
        },
      },
    }

    const record = validateInventoryStore(raw).servers['srv']?.quarantined['read_file']

    expect(record?.descriptor.description).toBe('reads a file')
    expect(record?.descriptor.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
  })
})

describe('reject', () => {
  test('removes a quarantined tool; the next observe re-quarantines it as new', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    expect(await inventory.reject('read_file')).toBe(true)
    expect(await inventory.listQuarantined()).toEqual([])

    const result = await inventory.observeToolsList([tool()])
    expect(result.new).toEqual(['read_file'])
  })

  test('returns false for a tool that is not quarantined', async () => {
    const inventory = createInventory('srv', { storePath })

    expect(await inventory.reject('never-seen')).toBe(false)
  })
})

describe('listQuarantined', () => {
  test('lists quarantined tools with state, firstSeenAt and a short hash', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    const listed = await inventory.listQuarantined()

    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ serverName: 'srv', toolName: 'read_file', state: 'new' })
    expect(listed[0]?.shortHash).toHaveLength(12)
    expect(typeof listed[0]?.firstSeenAt).toBe('string')
  })
})

describe('static CLI helpers', () => {
  test('listAllQuarantined, approveTool and rejectTool roundtrip across servers', async () => {
    const inventoryA = createInventory('server-a', { storePath })
    const inventoryB = createInventory('server-b', { storePath })
    await inventoryA.observeToolsList([tool({ name: 'tool_a' })])
    await inventoryB.observeToolsList([tool({ name: 'tool_b' })])

    const all = await listAllQuarantined(storePath)
    expect(all.map((entry) => `${entry.serverName}/${entry.toolName}`).sort()).toEqual([
      'server-a/tool_a',
      'server-b/tool_b',
    ])

    expect(await approveTool('server-a', 'tool_a', storePath)).toBe(true)
    expect(await approveTool('server-a', 'tool_a', storePath)).toBe(false)
    expect(await rejectTool('server-b', 'tool_b', storePath)).toBe(true)
    expect(await rejectTool('server-b', 'tool_b', storePath)).toBe(false)

    expect(await listAllQuarantined(storePath)).toEqual([])
  })
})
