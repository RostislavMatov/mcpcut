import { describe, expect, test } from 'vitest'
import { formatReadableField, MAX_READABLE_FIELD_CHARS } from '../../src/journal/format.js'

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
