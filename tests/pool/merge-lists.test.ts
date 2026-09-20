import { describe, expect, test } from 'vitest'
import {
  MAX_POOL_CATALOG_BYTES,
  MAX_POOL_ENTRIES_PER_SERVER,
  MAX_POOL_ENTRY_BYTES,
} from '../../src/pool/constants.js'
import { mergePoolList, readListPage, type PoolListPart } from '../../src/pool/merge-lists.js'

/** One upstream `tools/list` success line, as a child session would hand it over. */
function listLine(kind: 'tools' | 'prompts', entries: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 7, result: { [kind]: entries, ...extra } })
}

function part(server: string, entries: unknown[]): PoolListPart {
  return { server, entries }
}

/** The merged `result.tools` (or `.prompts`) array, parsed back out. */
function mergedEntries(serialized: string, kind: 'tools' | 'prompts' = 'tools'): Record<string, unknown>[] {
  const parsed = JSON.parse(serialized) as { result: Record<string, Record<string, unknown>[]> }
  return parsed.result[kind]!
}

describe('readListPage', () => {
  test('reads the entries and a string cursor', () => {
    const page = readListPage(listLine('tools', [{ name: 'read' }], { nextCursor: 'p2' }), 'tools')

    expect(page).toEqual({ entries: [{ name: 'read' }], nextCursor: 'p2' })
  })

  test('treats a missing cursor as the last page', () => {
    const page = readListPage(listLine('tools', []), 'tools')

    expect(page).toEqual({ entries: [], nextCursor: null })
  })

  test('treats a non-string cursor as the last page rather than guessing', () => {
    const page = readListPage(listLine('tools', [{ name: 'a' }], { nextCursor: 42 }), 'tools')

    expect(page?.nextCursor).toBeNull()
  })

  test('reads the prompts kind from the prompts field', () => {
    const page = readListPage(listLine('prompts', [{ name: 'review' }]), 'prompts')

    expect(page?.entries).toEqual([{ name: 'review' }])
  })

  test.each([
    ['an error response instead of a result', JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'no' } })],
    ['a result that is not an object', JSON.stringify({ jsonrpc: '2.0', id: 7, result: 'ok' })],
    ['a list field that is not an array', JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: {} } })],
    ['the wrong list kind', listLine('prompts', [{ name: 'a' }])],
    ['unparseable JSON', '{not json'],
    ['a JSON array at the top level', '[1,2]'],
  ])('refuses %s', (_label, raw) => {
    expect(readListPage(raw, 'tools')).toBeNull()
  })
})

describe('mergePoolList', () => {
  test('orders servers by name whatever order the parts arrive in', () => {
    const merged = mergePoolList(1, 'tools', [
      part('zeta', [{ name: 'z1' }]),
      part('alpha', [{ name: 'a1' }]),
    ])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual([
      'alpha__a1',
      'zeta__z1',
    ])
  })

  test('keeps a server’s own entries in the order the server sent them', () => {
    const merged = mergePoolList(1, 'tools', [part('fs', [{ name: 'b' }, { name: 'a' }, { name: 'c' }])])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual([
      'fs__b',
      'fs__a',
      'fs__c',
    ])
  })

  test('preserves vendor fields, schema and annotations, changing only the name', () => {
    const entry = {
      name: 'read',
      description: 'reads',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      'x-vendor-risk': 'low',
    }

    const merged = mergePoolList(1, 'tools', [part('fs', [entry])])

    expect(mergedEntries(merged!.serialized)[0]).toEqual({ ...entry, name: 'fs__read' })
  })

  test('counts an entry with no readable name instead of listing it', () => {
    const merged = mergePoolList(1, 'tools', [part('fs', [{ name: 'ok' }, { name: 42 }, 'nope', null])])

    expect(merged!.droppedUnreadable).toEqual({ fs: 3 })
    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual(['fs__ok'])
  })

  test('refuses a whole server that lists one name twice, leaving the others intact', () => {
    const merged = mergePoolList(1, 'tools', [
      part('dup', [{ name: 'read' }, { name: 'write' }, { name: 'read' }]),
      part('fs', [{ name: 'read' }]),
    ])

    expect(merged!.refusedServers).toEqual(['dup'])
    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual(['fs__read'])
  })

  test('refuses a server whose name cannot be encoded at all', () => {
    const merged = mergePoolList(1, 'tools', [part('Bad_Name', [{ name: 'read' }])])

    expect(merged!.refusedServers).toEqual(['Bad_Name'])
    expect(mergedEntries(merged!.serialized)).toEqual([])
  })

  test('hides a name over the hide threshold and reports it', () => {
    const long = 'x'.repeat(61) // `srv__` + 61 = 66 > 64

    const merged = mergePoolList(1, 'tools', [part('srv', [{ name: long }, { name: 'ok' }])])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual(['srv__ok'])
    expect(merged!.hidden).toEqual([{ server: 'srv', name: long }])
    expect(merged!.count).toBe(1)
  })

  test('lists a name over the warn threshold but flags it', () => {
    const warned = 'x'.repeat(43) // `srv__` + 43 = 48 > 47, <= 64

    const merged = mergePoolList(1, 'tools', [part('srv', [{ name: warned }])])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual([`srv__${warned}`])
    expect(merged!.warned).toEqual([{ server: 'srv', name: warned }])
    expect(merged!.hidden).toEqual([])
  })

  test('an empty pool is an empty list, not a failure', () => {
    const merged = mergePoolList(1, 'tools', [])

    expect(JSON.parse(merged!.serialized)).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  test('a pool where everything is hidden is still an empty list', () => {
    const merged = mergePoolList(1, 'tools', [part('srv', [{ name: 'x'.repeat(61) }])])

    expect(mergedEntries(merged!.serialized)).toEqual([])
    expect(merged!.count).toBe(0)
  })

  test('merges prompts under the prompts field', () => {
    const merged = mergePoolList('abc', 'prompts', [part('docs', [{ name: 'review' }])])

    expect(JSON.parse(merged!.serialized)).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      result: { prompts: [{ name: 'docs__review' }] },
    })
  })

  test('carries no nextCursor: the caller has already drained every upstream page', () => {
    const merged = mergePoolList(1, 'tools', [part('fs', [{ name: 'a' }])])

    expect(JSON.parse(merged!.serialized).result).not.toHaveProperty('nextCursor')
  })

  test('drops entries past the per-server cap and counts them', () => {
    const entries = Array.from({ length: MAX_POOL_ENTRIES_PER_SERVER + 5 }, (_, i) => ({
      name: `t${i}`,
    }))

    const merged = mergePoolList(1, 'tools', [part('flood', entries)])

    expect(merged!.count).toBe(MAX_POOL_ENTRIES_PER_SERVER)
    expect(merged!.droppedOversize).toEqual({ flood: 5 })
  })

  test('one flooding server does not cost the others their places', () => {
    const entries = Array.from({ length: MAX_POOL_ENTRIES_PER_SERVER + 1 }, (_, i) => ({
      name: `t${i}`,
    }))

    const merged = mergePoolList(1, 'tools', [part('flood', entries), part('zz', [{ name: 'ok' }])])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toContain('zz__ok')
  })

  test('drops a single entry too large to belong in a catalog at all', () => {
    const huge = { name: 'huge', description: 'x'.repeat(MAX_POOL_ENTRY_BYTES) }

    const merged = mergePoolList(1, 'tools', [part('fs', [huge, { name: 'small' }])])

    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual(['fs__small'])
    expect(merged!.droppedOversize).toEqual({ fs: 1 })
  })

  test('stops once the whole catalog would outgrow its budget', () => {
    // A single upstream must not be able to make the plane build and stringify
    // an unbounded line: Node is single-threaded, so that stalls every other
    // agent's session too.
    const chunk = 'x'.repeat(50_000)
    const entries = Array.from({ length: 400 }, (_, i) => ({ name: `t${i}`, description: chunk }))

    const merged = mergePoolList(1, 'tools', [part('big', entries)])

    expect(merged!.serialized.length).toBeLessThanOrEqual(MAX_POOL_CATALOG_BYTES)
    expect(merged!.droppedOversize['big']).toBeGreaterThan(0)
    expect(merged!.count).toBeGreaterThan(0)
  })

  test('an ordinary catalog is nowhere near the caps and reports no drops', () => {
    const merged = mergePoolList(1, 'tools', [part('fs', [{ name: 'a' }, { name: 'b' }])])

    expect(merged!.droppedOversize).toEqual({})
  })

  test('refuses a server listing the same name in two Unicode spellings', () => {
    // NFC vs NFD render identically; ADR-0015 §6 refuses ambiguity, and
    // "identically named" has to mean what a reader sees, not what the bytes are.
    const merged = mergePoolList(1, 'tools', [
      part('sneaky', [{ name: 'café' }, { name: 'café' }]),
      part('fs', [{ name: 'read' }]),
    ])

    expect(merged!.refusedServers).toEqual(['sneaky'])
    expect(mergedEntries(merged!.serialized).map((e) => e['name'])).toEqual(['fs__read'])
  })

  test('the server half of every listed name stays ASCII and operator-chosen', () => {
    // A hostile server picks its tool names, never its own registry name, so
    // attribution in a merged catalog cannot be spoofed however the tool half
    // is spelled (ADR-0015 §5).
    const merged = mergePoolList(1, 'tools', [
      part('evil', [{ name: '‮elbisivni‬' }, { name: 'zero​width' }]),
    ])

    for (const entry of mergedEntries(merged!.serialized)) {
      expect(String(entry['name']).split('__')[0]).toBe('evil')
    }
  })

  test('never mutates the parts or the entries it was handed', () => {
    const entry = Object.freeze({ name: 'read', annotations: Object.freeze({ readOnlyHint: true }) })
    const parts = Object.freeze([Object.freeze({ server: 'fs', entries: Object.freeze([entry]) })])

    const merged = mergePoolList(1, 'tools', parts as readonly PoolListPart[])

    expect(merged).not.toBeNull()
    expect(entry.name).toBe('read')
    expect(parts[0]!.server).toBe('fs')
  })

  test('does not reorder the caller’s array in place', () => {
    const parts = [part('zeta', [{ name: 'z' }]), part('alpha', [{ name: 'a' }])]

    mergePoolList(1, 'tools', parts)

    expect(parts.map((p) => p.server)).toEqual(['zeta', 'alpha'])
  })
})
