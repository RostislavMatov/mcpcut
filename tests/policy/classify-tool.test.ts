import { describe, expect, test } from 'vitest'
import { classifyTool, type ClassifiableTool } from '../../src/policy/classify-tool.js'
import type { ToolClass } from '../../src/policy/schema.js'

function tool(name: string, annotations?: ClassifiableTool['annotations']): ClassifiableTool {
  return annotations === undefined ? { name } : { name, annotations }
}

describe('classifyTool: base precedence (no overrides)', () => {
  test('unannotated tool defaults to write', () => {
    expect(classifyTool(tool('search_index'))).toBe('write')
  })

  test('readOnlyHint true classifies as read', () => {
    expect(classifyTool(tool('search_index', { readOnlyHint: true }))).toBe('read')
  })

  test('destructiveHint true classifies as destructive', () => {
    expect(classifyTool(tool('search_index', { destructiveHint: true }))).toBe('destructive')
  })

  test('both hints true classifies as destructive (destructive wins over read)', () => {
    expect(
      classifyTool(tool('search_index', { readOnlyHint: true, destructiveHint: true })),
    ).toBe('destructive')
  })

  test('readOnlyHint false and destructiveHint false behaves as unannotated (write)', () => {
    expect(
      classifyTool(tool('search_index', { readOnlyHint: false, destructiveHint: false })),
    ).toBe('write')
  })
})

describe('classifyTool: readOnlyHint cannot downgrade a destructive-named tool', () => {
  test('delete_everything with readOnlyHint true is still destructive', () => {
    expect(classifyTool(tool('delete_everything', { readOnlyHint: true }))).toBe('destructive')
  })
})

describe('classifyTool: name heuristics escalate to destructive', () => {
  test.each([
    ['drop_table', 'drop'],
    ['force_push', 'force_'],
    ['reset', 'reset'],
    ['purgeCache', 'purge (camelCase)'],
    ['delete_user', 'delete'],
    ['deleteUser', 'delete (camelCase)'],
    ['revoke_access', 'revoke'],
    ['destroy_instance', 'destroy'],
    ['truncate_table', 'truncate'],
    ['remove_item', 'remove'],
  ])('%s classifies as destructive via heuristic (%s)', (name) => {
    expect(classifyTool(tool(name))).toBe('destructive')
  })
})

describe('classifyTool: heuristic matches whole tokens only, not substrings', () => {
  test.each([
    ['undelete_item', 'delete'],
    ['dropdown_menu', 'drop'],
    ['preset_load', 'reset'],
  ])('%s does NOT match the "%s" heuristic as a substring', (name) => {
    expect(classifyTool(tool(name))).toBe('write')
  })

  test('a bare "reset" tool still matches (control case for the preset_load test)', () => {
    expect(classifyTool(tool('reset'))).toBe('destructive')
  })
})

describe('classifyTool: config overrides win over everything', () => {
  test('exact-name override beats a destructive-name heuristic', () => {
    const overrides: Record<string, ToolClass> = { delete_x: 'read' }
    expect(classifyTool(tool('delete_x'), overrides)).toBe('read')
  })

  test('exact-name override beats destructiveHint annotation', () => {
    const overrides: Record<string, ToolClass> = { risky_tool: 'write' }
    expect(classifyTool(tool('risky_tool', { destructiveHint: true }), overrides)).toBe('write')
  })

  test('trailing-glob override applies to matching tool names', () => {
    const overrides: Record<string, ToolClass> = { 'admin_*': 'destructive' }
    expect(classifyTool(tool('admin_reload'), overrides)).toBe('destructive')
  })

  test('longer glob prefix wins over a shorter matching glob', () => {
    const overrides: Record<string, ToolClass> = {
      'admin_*': 'destructive',
      'admin_read_*': 'read',
    }
    expect(classifyTool(tool('admin_read_status'), overrides)).toBe('read')
  })

  test('exact match wins over any glob match, regardless of definition order', () => {
    const overrides: Record<string, ToolClass> = {
      'admin_*': 'destructive',
      admin_status: 'read',
    }
    expect(classifyTool(tool('admin_status'), overrides)).toBe('read')
  })

  test('override entry that does not match the tool name is ignored', () => {
    const overrides: Record<string, ToolClass> = { other_tool: 'read' }
    expect(classifyTool(tool('delete_everything'), overrides)).toBe('destructive')
  })

  test('glob override that does not match the tool name prefix is ignored', () => {
    const overrides: Record<string, ToolClass> = { 'admin_*': 'read' }
    expect(classifyTool(tool('delete_everything'), overrides)).toBe('destructive')
  })

  test('empty overrides map behaves as if no overrides were passed', () => {
    expect(classifyTool(tool('delete_everything'), {})).toBe('destructive')
  })

  test('undefined overrides behaves as if omitted entirely', () => {
    expect(classifyTool(tool('search_index'), undefined)).toBe('write')
  })
})
