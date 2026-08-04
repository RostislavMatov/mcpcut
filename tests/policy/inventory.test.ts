import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-inventory-test-'))
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

interface StoredQuarantinedRecord {
  readonly schemaHash: string
  readonly firstSeenAt: string
  readonly state: 'new' | 'changed'
  readonly descriptor: { readonly name: string; readonly description?: string }
}

interface StoredInventoryFile {
  readonly version: 1
  readonly servers: Record<
    string,
    {
      readonly approved: Record<string, unknown>
      readonly quarantined: Record<string, StoredQuarantinedRecord>
    }
  >
}

async function readStoreFile(path: string): Promise<StoredInventoryFile> {
  return JSON.parse(await readFile(path, 'utf8')) as StoredInventoryFile
}

describe('observeToolsList: first observation', () => {
  test('classifies every tool as new and quarantines it', async () => {
    const inventory = createInventory('srv', { storePath })

    const result = await inventory.observeToolsList([tool()])

    expect(result).toEqual({ known: [], new: ['read_file'], changed: [] })
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

    expect(result).toEqual({ known: ['a'], new: ['c'], changed: ['b'] })
  })
})

describe('approve', () => {
  test('moves a quarantined tool to known on next observe and stateOf', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    expect(await inventory.approve('read_file')).toBe(true)

    const result = await inventory.observeToolsList([tool()])
    expect(result).toEqual({ known: ['read_file'], new: [], changed: [] })
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

    expect(result).toEqual({ known: [], new: [], changed: ['read_file'] })
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

  test('returns unknown for a tool absent from the last observed tools/list', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool()])

    await inventory.observeToolsList([])

    expect(inventory.stateOf('read_file')).toBe('unknown')
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
