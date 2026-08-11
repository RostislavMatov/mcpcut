import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  MAX_QUARANTINED_TOOLS_PER_SERVER,
  MAX_STORED_DESCRIPTOR_CHARS,
  MAX_STORED_SCHEMA_CHARS,
} from '../../src/policy/constants.js'
import { createInventory } from '../../src/policy/inventory.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'

/**
 * M4 Task 5: the inventory stores a full (redacted, capped) descriptor WITH
 * `inputSchema` for both the approved and the quarantined side (reversing the
 * M10 "always drop the schema" decision), so the quarantine card can render a
 * structural diff. Retention is explicit: at most TWO descriptors per tool --
 * the approved one and the currently observed one -- with no version history.
 */

let tempDir: string
let storePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-inventory-retention-'))
  storePath = join(tempDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return { name: 'read_file', description: 'Reads a file from disk', ...overrides }
}

interface StoredDescriptorShape {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

interface StoredQuarantinedRecord {
  readonly schemaHash: string
  readonly firstSeenAt: string
  readonly state: 'new' | 'changed'
  readonly descriptor: StoredDescriptorShape
  readonly schemaTruncated?: boolean
  readonly surfaceDelta?: 'widened' | 'narrowed' | 'changed' | 'neutral'
}

interface StoredApprovedRecord {
  readonly schemaHash: string
  readonly approvedAt: string
  readonly descriptor?: StoredDescriptorShape
  readonly schemaTruncated?: boolean
}

interface StoredInventoryFile {
  readonly version: 1
  readonly servers: Record<
    string,
    {
      readonly approved: Record<string, StoredApprovedRecord>
      readonly quarantined: Record<string, StoredQuarantinedRecord>
    }
  >
}

async function readStoreFile(path: string): Promise<StoredInventoryFile> {
  return JSON.parse(await readFile(path, 'utf8')) as StoredInventoryFile
}

describe('stored inputSchema (M4: kept for the structural diff, reversing M10 drop)', () => {
  test('quarantined descriptor keeps a redacted copy of inputSchema', async () => {
    const inventory = createInventory('srv', { storePath })
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const inputSchema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Uses key ${secret} internally` },
      },
      required: ['path'],
    }

    await inventory.observeToolsList([tool({ inputSchema })])

    const file = await readStoreFile(storePath)
    const record = file.servers['srv']?.quarantined['read_file']
    const stored = record?.descriptor.inputSchema as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    expect(stored).toBeDefined()
    expect(stored.type).toBe('object')
    expect(Object.keys(stored.properties)).toEqual(['path'])
    expect(stored.required).toEqual(['path'])
    expect(record?.schemaTruncated).toBeUndefined()
    // Redaction remains the only path to persistence: the secret must not survive.
    expect(JSON.stringify(file)).not.toContain(secret)
  })

  test('oversized inputSchema is stored as a top-level summary with schemaTruncated', async () => {
    const inventory = createInventory('srv', { storePath })
    const inputSchema = {
      type: 'object',
      properties: {
        alpha: { type: 'string', description: 'z'.repeat(MAX_STORED_SCHEMA_CHARS) },
        beta: { type: 'number' },
      },
      required: ['alpha'],
    }

    await inventory.observeToolsList([tool({ inputSchema })])

    const file = await readStoreFile(storePath)
    const record = file.servers['srv']?.quarantined['read_file']
    expect(record?.schemaTruncated).toBe(true)
    const summary = record?.descriptor.inputSchema as {
      schemaSummary: true
      topLevelProperties: string[]
      required: string[]
    }
    expect(summary.schemaSummary).toBe(true)
    expect(summary.topLevelProperties).toEqual(['alpha', 'beta'])
    expect(summary.required).toEqual(['alpha'])
    expect(JSON.stringify(record?.descriptor).length).toBeLessThanOrEqual(MAX_STORED_DESCRIPTOR_CHARS)
  })

  test('rug-pull detection via the hash is unchanged when schemas are stored', async () => {
    const inventory = createInventory('srv', { storePath })
    await inventory.observeToolsList([tool({ inputSchema: { type: 'object', v: 1 } })])
    await inventory.approve('read_file')

    const result = await inventory.observeToolsList([
      tool({ inputSchema: { type: 'object', v: 2 } }),
    ])

    expect(result.changed).toEqual(['read_file'])
  })
})

describe('surfaceDelta: persisted on a changed quarantined record (M4 signal, no class change)', () => {
  test('an added optional property persists surfaceDelta: widened on the changed record', async () => {
    const inventory = createInventory('srv', { storePath })
    const schemaV1 = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const schemaV2 = {
      type: 'object',
      properties: { path: { type: 'string' }, force: { type: 'boolean' } },
      required: ['path'],
    }
    await inventory.observeToolsList([tool({ inputSchema: schemaV1 })])
    await inventory.approve('read_file')

    await inventory.observeToolsList([tool({ inputSchema: schemaV2 })])

    const record = (await readStoreFile(storePath)).servers['srv']?.quarantined['read_file']
    expect(record?.state).toBe('changed')
    expect(record?.surfaceDelta).toBe('widened')
  })

  test('a brand-new tool has no surfaceDelta (nothing to diff against)', async () => {
    const inventory = createInventory('srv', { storePath })

    await inventory.observeToolsList([tool({ inputSchema: { type: 'object' } })])

    const record = (await readStoreFile(storePath)).servers['srv']?.quarantined['read_file']
    expect(record?.state).toBe('new')
    expect(record?.surfaceDelta).toBeUndefined()
  })

  test('a description-only edit persists surfaceDelta: neutral', async () => {
    const inventory = createInventory('srv', { storePath })
    const inputSchema = { type: 'object', properties: { path: { type: 'string' } } }
    await inventory.observeToolsList([tool({ inputSchema })])
    await inventory.approve('read_file')

    await inventory.observeToolsList([
      tool({ description: 'Reads a file from disk, reworded', inputSchema }),
    ])

    const record = (await readStoreFile(storePath)).servers['srv']?.quarantined['read_file']
    expect(record?.state).toBe('changed')
    expect(record?.surfaceDelta).toBe('neutral')
  })
})

describe('descriptor retention: at most two stored descriptors per tool', () => {
  test('approve carries the observed descriptor (with schema) into the approved record', async () => {
    const inventory = createInventory('srv', { storePath })
    const inputSchema = { type: 'object', properties: { path: { type: 'string' } } }
    await inventory.observeToolsList([tool({ inputSchema })])

    expect(await inventory.approve('read_file')).toBe(true)

    const file = await readStoreFile(storePath)
    const approved = file.servers['srv']?.approved['read_file']
    expect(approved?.descriptor?.name).toBe('read_file')
    expect(approved?.descriptor?.inputSchema).toEqual(inputSchema)
    expect(file.servers['srv']?.quarantined['read_file']).toBeUndefined()
  })

  test('version churn keeps exactly one approved and one quarantined descriptor, no history', async () => {
    const inventory = createInventory('srv', { storePath })
    const schemaV = (marker: string) => ({
      type: 'object',
      properties: { [marker]: { type: 'string' } },
    })

    await inventory.observeToolsList([tool({ inputSchema: schemaV('v1_marker') })])
    await inventory.approve('read_file')
    await inventory.observeToolsList([tool({ inputSchema: schemaV('v2_marker') })])
    await inventory.observeToolsList([tool({ inputSchema: schemaV('v3_marker') })])
    await inventory.approve('read_file')
    await inventory.observeToolsList([tool({ inputSchema: schemaV('v4_marker') })])

    const file = await readStoreFile(storePath)
    const server = file.servers['srv']
    expect(Object.keys(server?.approved ?? {})).toEqual(['read_file'])
    expect(Object.keys(server?.quarantined ?? {})).toEqual(['read_file'])
    // The approved slot holds the last approved version, the quarantined slot
    // the currently observed one -- and nothing else is retained.
    expect(server?.approved['read_file']?.descriptor?.inputSchema).toEqual(schemaV('v3_marker'))
    expect(server?.quarantined['read_file']?.descriptor.inputSchema).toEqual(schemaV('v4_marker'))
    const raw = JSON.stringify(file)
    expect(raw).not.toContain('v1_marker')
    expect(raw).not.toContain('v2_marker')
  })

  test('store size at the quarantine cap (2000 tools) stays within the two-descriptor bound', async () => {
    const inventory = createInventory('srv', { storePath })
    const filler = 'f'.repeat(600)
    const tools: ToolDescriptor[] = Array.from(
      { length: MAX_QUARANTINED_TOOLS_PER_SERVER },
      (_, i) => ({
        name: `tool_${i}`,
        inputSchema:
          i % 10 === 0
            ? // Every tenth schema is oversized: it must be summarized, not stored whole.
              {
                type: 'object',
                properties: { big: { description: 'x'.repeat(MAX_STORED_SCHEMA_CHARS + 100) } },
              }
            : { type: 'object', properties: { arg: { type: 'string', description: filler } } },
      }),
    )

    const result = await inventory.observeToolsList(tools)

    expect(result.failed).toBe(false)
    const file = await readStoreFile(storePath)
    const quarantined = file.servers['srv']?.quarantined ?? {}
    expect(Object.keys(quarantined)).toHaveLength(MAX_QUARANTINED_TOOLS_PER_SERVER)
    // Every stored descriptor honors the per-descriptor cap...
    for (const record of Object.values(quarantined)) {
      expect(JSON.stringify(record.descriptor).length).toBeLessThanOrEqual(MAX_STORED_DESCRIPTOR_CHARS)
    }
    // ...so the whole store stays inside the explicit retention bound:
    // 2 descriptor slots x tools x servers, each slot capped, plus record overhead.
    const RECORD_OVERHEAD_CHARS = 512
    const bound =
      2 * MAX_QUARANTINED_TOOLS_PER_SERVER * (MAX_STORED_DESCRIPTOR_CHARS + RECORD_OVERHEAD_CHARS)
    expect(JSON.stringify(file).length).toBeLessThanOrEqual(bound)
  })
})
