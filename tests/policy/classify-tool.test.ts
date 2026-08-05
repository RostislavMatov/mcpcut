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

describe('M11: unicode / vocabulary evasion of destructive-name heuristics', () => {
  test('Cyrillic look-alike "dеlete_all" (Cyrillic е) is NOT classified read', () => {
    // NOTE: the second character is Cyrillic е, not ASCII 'e'.
    const cyrillicDelete = 'dеlete_all'
    expect(classifyTool(tool(cyrillicDelete))).not.toBe('read')
  })

  test('Cyrillic look-alike is escalated to destructive via the confusable fold', () => {
    const cyrillicDelete = 'dеlete_all'
    expect(classifyTool(tool(cyrillicDelete))).toBe('destructive')
  })

  test('a non-ASCII name cannot be downgraded to read by readOnlyHint', () => {
    const cyrillicName = 'rеad_аll' // Cyrillic е and а
    expect(classifyTool(tool(cyrillicName, { readOnlyHint: true }))).not.toBe('read')
  })

  test.each([
    'wipe_disk',
    'erase_all',
    'rm_rf',
    'overwrite_file',
    'kill_process',
    'shutdown_host',
    'chmod_recursive',
    'exec_shell',
    'transfer_funds',
    'send_email',
    'terminate_instance',
  ])('expanded heuristic classifies %s as destructive', (name) => {
    expect(classifyTool(tool(name))).toBe('destructive')
  })

  test('a legit ASCII read tool is still classified read with readOnlyHint', () => {
    expect(classifyTool(tool('read_file', { readOnlyHint: true }))).toBe('read')
  })

  test('a fullwidth "delete" (NFKC compatibility form) escalates to destructive', () => {
    const fullwidth = 'ｄｅｌｅｔｅ_all' // ｄｅｌｅｔｅ_all
    expect(classifyTool(tool(fullwidth))).toBe('destructive')
  })

  test('a zero-width space hidden inside "delete" does not evade the heuristic (M11)', () => {
    const zeroWidthDelete = `del${'​'}ete_repo` // U+200B ZERO WIDTH SPACE
    expect(classifyTool(tool(zeroWidthDelete))).toBe('destructive')
  })

  test('a stray Unicode combining mark inside "delete" does not evade the heuristic (M11)', () => {
    // U+0301 COMBINING ACUTE ACCENT placed after "d": Unicode has no
    // precomposed "d with acute" letter, so NFKC normalization leaves the
    // base letter and the mark as two separate code points (unlike, say,
    // "l" + U+0301, which composes to the precomposed "ĺ") -- this is what
    // actually exercises the combining-mark strip rather than accidentally
    // being absorbed into a different, still-non-ASCII precomposed letter.
    const combiningDelete = `d${'́'}elete_all`
    expect(classifyTool(tool(combiningDelete))).toBe('destructive')
  })

  test('zero-width joiner/non-joiner and a BOM inside "delete" all still escalate (M11)', () => {
    expect(classifyTool(tool(`de${'‌'}lete_all`))).toBe('destructive') // ZWNJ
    expect(classifyTool(tool(`de${'‍'}lete_all`))).toBe('destructive') // ZWJ
    expect(classifyTool(tool(`de${'﻿'}lete_all`))).toBe('destructive') // BOM
  })

  // Re-review M2: the strip must cover the whole invisible/format repertoire,
  // not a hand-picked four — every vector below survives NFKC and previously
  // downgraded `delete_all` from destructive to write.
  test.each([
    ['WORD JOINER U+2060', '⁠'],
    ['SOFT HYPHEN U+00AD', '­'],
    ['LEFT-TO-RIGHT MARK U+200E', '‎'],
    ['RIGHT-TO-LEFT MARK U+200F', '‏'],
    ['ARABIC LETTER MARK U+061C', '؜'],
    ['FUNCTION APPLICATION U+2061', '⁡'],
    ['INVISIBLE TIMES U+2062', '⁢'],
    ['MONGOLIAN VOWEL SEPARATOR U+180E', '᠎'],
    ['TAG LATIN SMALL LETTER D U+E0064', '\u{E0064}'],
    ['MUSICAL SYMBOL BEGIN BEAM U+1D173', '\u{1D173}'],
    ['HANGUL CHOSEONG FILLER U+115F', 'ᅟ'],
    ['HANGUL FILLER U+3164', 'ㅤ'],
    ['HALFWIDTH HANGUL FILLER U+FFA0', 'ﾠ'],
  ])('an invisible %s inside "delete" does not evade the heuristic (re-review M2)', (_label, ch) => {
    expect(classifyTool(tool(`del${ch}ete_all`))).toBe('destructive')
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
