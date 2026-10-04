import { describe, expect, test } from 'vitest'
import { restoreCommandOf } from '../../src/files/restore-hint.js'

describe('restoreCommandOf', () => {
  test('spells the command with the real root and id', () => {
    expect(restoreCommandOf('/data/work', '01K9Z3Q8M5R7T2V4X6B8D0F1GH')).toBe(
      'mcpcut files trash restore /data/work 01K9Z3Q8M5R7T2V4X6B8D0F1GH',
    )
  })

  test('single-quotes a root with spaces and quotes', () => {
    expect(restoreCommandOf("/data/my work's", '01K9Z3Q8M5R7T2V4X6B8D0F1GH')).toBe(
      "mcpcut files trash restore '/data/my work'\\''s' 01K9Z3Q8M5R7T2V4X6B8D0F1GH",
    )
  })

  test('replaces control characters so the line cannot rewrite a terminal', () => {
    expect(restoreCommandOf('/data/\u001b[2Jx', 'ID')).not.toContain('\u001b')
  })
})
