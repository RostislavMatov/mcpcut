import { describe, expect, test } from 'vitest'
import { formatDecisionSummary, formatReadableField, MAX_READABLE_FIELD_CHARS } from '../../src/journal/format.js'
import type { DecisionInfo } from '../../src/journal/record.js'

/**
 * `formatReadableField` is the only thing standing between untrusted journal
 * content (method names, directions, session ids sourced from disk) and a
 * user's terminal in the `show`/`sessions` readable view. Control characters
 * could otherwise move the cursor, clear the screen or hide output.
 */
describe('formatReadableField', () => {
  test('passes plain text through unchanged', () => {
    expect(formatReadableField('tools/call')).toBe('tools/call')
  })

  test('replaces a NUL byte with a placeholder character', () => {
    expect(formatReadableField('a\x00b')).toBe('a?b')
  })

  test('replaces every C0 control character (0x00-0x1f)', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')

    const result = formatReadableField(controls)

    expect(result).toBe('?'.repeat(0x20))
  })

  test('replaces every C1 control character (0x80-0x9f): the 8-bit CSI/OSC twins a terminal honours like ESC', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(0x80 + code)).join('')

    const result = formatReadableField(`a${controls}b`)

    expect(result).toBe(`a${'?'.repeat(0x20)}b`)
    expect(formatReadableField('\x9b2Jhidden')).toBe('?2Jhidden')
  })

  test('replaces DEL (0x7f)', () => {
    expect(formatReadableField('a\x7fb')).toBe('a?b')
  })

  test('replaces an ANSI escape sequence, defusing cursor-movement / color codes', () => {
    const withEscape = '\x1b[31mred\x1b[0m'

    const result = formatReadableField(withEscape)

    expect(result).not.toContain('\x1b')
    expect(result).toBe('?[31mred?[0m')
  })

  test('leaves a value at exactly the max length untouched', () => {
    const value = 'x'.repeat(MAX_READABLE_FIELD_CHARS)

    expect(formatReadableField(value)).toBe(value)
  })

  test('truncates a value over the max length and appends an ellipsis marker', () => {
    const value = 'x'.repeat(MAX_READABLE_FIELD_CHARS + 50)

    const result = formatReadableField(value)

    expect(result.startsWith('x'.repeat(MAX_READABLE_FIELD_CHARS))).toBe(true)
    expect(result.length).toBe(MAX_READABLE_FIELD_CHARS + 1)
    expect(result.endsWith('…')).toBe(true)
  })

  test('sanitizes before truncating, so a long run of control characters cannot survive the cap as noise', () => {
    const value = '\x1b'.repeat(MAX_READABLE_FIELD_CHARS + 50)

    const result = formatReadableField(value)

    expect(result).not.toContain('\x1b')
    expect(result.length).toBe(MAX_READABLE_FIELD_CHARS + 1)
  })

  test('handles an empty string', () => {
    expect(formatReadableField('')).toBe('')
  })
})

/**
 * `formatDecisionSummary` renders a decision record's outcome/tool/rule for
 * the readable view. Those fields are read back from a journal file on disk
 * (untrusted), same as every other readable-view field, so control
 * characters must be neutralized the same way `formatReadableField` does.
 */
describe('formatDecisionSummary', () => {
  test('renders outcome, tool and rule as a labeled summary', () => {
    const result = formatDecisionSummary({
      outcome: 'deny',
      toolName: 'delete_repo',
      rule: 'servers.github.tools.delete_*',
    })

    expect(result).toBe('outcome=deny tool=delete_repo rule=servers.github.tools.delete_*')
  })

  test('neutralizes control characters in each field before rendering', () => {
    const result = formatDecisionSummary({
      outcome: 'allow\x1b[31m',
      toolName: 'tool\x00name',
      rule: 'rule\x7fname',
    })

    expect(result).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(result).toBe('outcome=allow?[31m tool=tool?name rule=rule?name')
  })
})

/**
 * Provenance rendering (M5 wave 1) is deliberately NOT part of the readable
 * view. `policyHash`/`grantsHash` are 64 hex characters each; against this
 * view's 200-character-per-field cap they would be pure noise for a human
 * scanning a log line, and neither is answerable by eye anyway. The machine
 * views already carry them: `--json` and the UI journal pass the decision
 * object through as-is, so they get the fields for free.
 *
 * These tests exist so a future reader finds a recorded decision rather than
 * what looks like an oversight, and so "add the hashes to the summary" is a
 * conscious change with a failing test attached.
 */
describe('formatDecisionSummary: provenance is intentionally not rendered', () => {
  const POLICY_HASH = 'a'.repeat(64)
  const GRANTS_HASH = 'b'.repeat(64)

  const provenanced: DecisionInfo = {
    outcome: 'deny',
    rule: 'servers.github.tools.delete_*',
    serverName: 'github',
    toolName: 'delete_repo',
    toolClass: 'destructive',
    quarantineState: 'known',
    argsHash: 'sha256:abc123',
    policyHash: POLICY_HASH,
    grantsHash: GRANTS_HASH,
  }

  test('the summary omits both hashes entirely', () => {
    const result = formatDecisionSummary(provenanced)

    expect(result).not.toContain(POLICY_HASH)
    expect(result).not.toContain(GRANTS_HASH)
    expect(result).not.toContain('policyHash')
    expect(result).not.toContain('grantsHash')
  })

  test('the summary is byte-identical to the one for the same decision without provenance', () => {
    const withProvenance = formatDecisionSummary(provenanced)
    const withoutProvenance = formatDecisionSummary({
      outcome: provenanced.outcome,
      toolName: provenanced.toolName,
      rule: provenanced.rule,
    })

    expect(withProvenance).toBe(withoutProvenance)
    expect(withProvenance).toBe('outcome=deny tool=delete_repo rule=servers.github.tools.delete_*')
  })
})
