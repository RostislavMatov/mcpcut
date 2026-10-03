import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './server-helpers.js'

interface ListedTool {
  name: string
  description: string
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }
}

describe('files server protocol', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => {
    await h.sandbox.cleanup()
  })

  it('answers initialize with the version the client asked for', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcpcut-files', version: expect.any(String) } },
    })
  })

  it('falls back to the latest supported version for an unknown one', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect((response?.['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
  })

  it('answers initialize without params', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((response?.['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
  })

  it('returns null for notifications, known or not', async () => {
    expect(await h.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await h.rpc({ jsonrpc: '2.0', method: 'notifications/whatever' })).toBeNull()
  })

  it('answers ping with an empty result', async () => {
    expect(await h.rpc({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'p', result: {} })
  })

  it('answers an unknown method with -32601 and keeps the id', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
    expect(response).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: expect.stringContaining('resources/list') } })
  })

  it.each([null, 'text', 42, [], {}, { jsonrpc: '2.0', id: 1 }])('answers a malformed request %j with -32600', async (bad) => {
    const response = await h.rpc(bad)
    expect((response?.['error'] as { code: number }).code).toBe(-32600)
  })

  it('answers tools/call without a tool name with -32602', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })
    expect((response?.['error'] as { code: number }).code).toBe(-32602)
  })

  it('lists the nine tools with schemas and honest annotations', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (response?.['result'] as { tools: ListedTool[] }).tools
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_roots', 'list_directory', 'get_file_info', 'read_file', 'write_file', 'create_directory', 'edit_file', 'move_file', 'delete_file',
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema).not.toHaveProperty('$schema')
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(byName['write_file']?.inputSchema.required).toEqual(['path', 'content'])
    expect(Object.keys(byName['edit_file']?.inputSchema.properties ?? {})).toEqual(['path', 'edits', 'expectedSha256'])
    expect(Object.keys(byName['move_file']?.inputSchema.properties ?? {})).toEqual(['source', 'destination'])
    for (const name of ['list_roots', 'list_directory', 'get_file_info', 'read_file']) {
      expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }
    for (const name of ['write_file', 'create_directory', 'edit_file', 'move_file']) {
      expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    }
    expect(byName['delete_file']?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName['read_file']?.annotations.idempotentHint).toBe(true)
    expect(byName['create_directory']?.annotations.idempotentHint).toBe(false)
  })
})
