import { describe, expect, test } from 'vitest'
import { classify, type ClassifiedMessage } from '../../src/protocol/classify.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import { filterToolsListResult } from '../../src/proxy/tools-filter.js'

/** Builds a classified `tools/list` success response from raw tool entries plus extra `result` fields. */
function toolsListResponse(resultExtra: Record<string, unknown>, tools: unknown[]): ClassifiedMessage {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { tools, ...resultExtra },
  })
  return classify(line)
}

function keepAllowlisted(allowed: readonly string[]): (tool: ToolDescriptor) => boolean {
  return (tool) => allowed.includes(tool.name)
}

function parsedResult(bytes: Buffer): { tools: unknown[]; [key: string]: unknown } {
  const parsed = JSON.parse(bytes.toString('utf8')) as { result: { tools: unknown[]; [key: string]: unknown } }
  return parsed.result
}

describe('filterToolsListResult', () => {
  test('removes denied tools and keeps the rest in original order', () => {
    const msg = toolsListResponse({}, [{ name: 'read_file' }, { name: 'delete_file' }, { name: 'list_dir' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['read_file', 'list_dir']))

    expect(result).not.toBeNull()
    const tools = parsedResult(result!.bytes).tools as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'list_dir'])
    expect(result!.removed).toEqual(['delete_file'])
    expect(result!.kept).toBe(2)
  })

  test('preserves unknown vendor extension fields on kept tool entries (fidelity)', () => {
    const msg = toolsListResponse({}, [
      { name: 'read_file', 'x-vendor-risk': 'low', annotations: { readOnlyHint: true } },
    ])

    const result = filterToolsListResult(msg, () => true)

    expect(result).not.toBeNull()
    const tools = parsedResult(result!.bytes).tools as Record<string, unknown>[]
    expect(tools[0]).toMatchObject({
      name: 'read_file',
      'x-vendor-risk': 'low',
      annotations: { readOnlyHint: true },
    })
  })

  test('preserves nextCursor untouched', () => {
    const msg = toolsListResponse({ nextCursor: 'page-2' }, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['a']))

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes)['nextCursor']).toBe('page-2')
  })

  test('preserves _meta untouched', () => {
    const msg = toolsListResponse({ _meta: { requestId: 'abc' } }, [{ name: 'a' }])

    const result = filterToolsListResult(msg, () => true)

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes)['_meta']).toEqual({ requestId: 'abc' })
  })

  test('all tools removed yields a valid empty array, not null', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, () => false)

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes).tools).toEqual([])
    expect(result!.kept).toBe(0)
    expect(result!.removed).toEqual(['a', 'b'])
  })

  test('returns null when result.tools is not an array', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { notTools: [] } })
    const msg = classify(line)

    expect(filterToolsListResult(msg, () => true)).toBeNull()
  })

  test('returns null for unparseable raw content', () => {
    const msg = classify('not json at all {{{')

    expect(filterToolsListResult(msg, () => true)).toBeNull()
  })

  test('returns null when there is no result object at all (e.g. a request)', () => {
    const msg = classify(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))

    expect(filterToolsListResult(msg, () => true)).toBeNull()
  })

  test('reports the names of removed tools', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }, { name: 'c' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['b']))

    expect(result).not.toBeNull()
    expect(result!.removed).toEqual(['a', 'c'])
  })

  test('output is single-line and terminated with a newline, even with hostile content', () => {
    const msg = toolsListResponse({}, [{ name: 'a', description: 'multi\nline description' }])

    const result = filterToolsListResult(msg, () => true)

    expect(result).not.toBeNull()
    const text = result!.bytes.toString('utf8')
    expect(text.split('\n')).toHaveLength(2)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('filterToolsListResult: agent allowlist (intersection with policy)', () => {
  function grantedOnly(granted: readonly string[]): (tool: string) => boolean {
    return (tool) => granted.includes(tool)
  }

  test('granted by agent but hidden by policy -> hidden', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['b']), grantedOnly(['a', 'b']))

    expect(result).not.toBeNull()
    const tools = parsedResult(result!.bytes).tools as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['b'])
    expect(result!.removed).toEqual(['a'])
  })

  test('visible by policy but not granted to the agent -> hidden', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, () => true, grantedOnly(['b']))

    expect(result).not.toBeNull()
    const tools = parsedResult(result!.bytes).tools as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['b'])
    expect(result!.removed).toEqual(['a'])
  })

  test('granted AND visible -> visible, order preserved', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }, { name: 'c' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['a', 'c']), grantedOnly(['c', 'a']))

    expect(result).not.toBeNull()
    const tools = parsedResult(result!.bytes).tools as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['a', 'c'])
    expect(result!.removed).toEqual(['b'])
  })

  test('empty intersection yields a valid empty tools array, not null', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, keepAllowlisted(['a']), grantedOnly(['b']))

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes).tools).toEqual([])
    expect(result!.kept).toBe(0)
    expect(result!.removed).toEqual(['a', 'b'])
  })

  test('agent predicate is never called for entries that are not named tool objects', () => {
    const seen: string[] = []
    const spy = (tool: string): boolean => {
      seen.push(tool)
      return true
    }
    const msg = toolsListResponse({}, ['garbage-string', { noName: true }, { name: 42 }, { name: 'real' }])

    const result = filterToolsListResult(msg, () => true, spy)

    expect(result).not.toBeNull()
    expect(seen).toEqual(['real'])
  })

  test('an unrecognizable entry is DROPPED once an agent predicate is present', () => {
    const msg = toolsListResponse({}, ['garbage-string', { noName: true }, { name: 42 }, { name: 'real' }])

    const result = filterToolsListResult(msg, () => true, () => true)

    expect(result).not.toBeNull()
    // An entry with no usable name cannot be intersected with a grant, and an
    // allowlist that lets through what it could not check is not an allowlist.
    expect(parsedResult(result!.bytes).tools).toEqual([{ name: 'real' }])
    expect(result!.kept).toBe(1)
  })

  test('without an agent predicate the same entries still fail open (M2)', () => {
    const msg = toolsListResponse({}, ['garbage-string', { noName: true }, { name: 42 }, { name: 'real' }])

    const result = filterToolsListResult(msg, () => true)

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes).tools).toHaveLength(4)
  })

  test('nextCursor survives agent filtering untouched', () => {
    const msg = toolsListResponse({ nextCursor: 'page-2' }, [{ name: 'a' }, { name: 'b' }])

    const result = filterToolsListResult(msg, () => true, grantedOnly(['a']))

    expect(result).not.toBeNull()
    expect(parsedResult(result!.bytes)['nextCursor']).toBe('page-2')
  })

  test('omitting the agent predicate is exactly the M2 behavior', () => {
    const msg = toolsListResponse({}, [{ name: 'a' }, { name: 'b' }])

    const withOmitted = filterToolsListResult(msg, keepAllowlisted(['a']))
    const withAllGranted = filterToolsListResult(msg, keepAllowlisted(['a']), () => true)

    expect(withOmitted).toEqual(withAllGranted)
    expect(withOmitted!.removed).toEqual(['b'])
  })
})
