import { describe, expect, test } from 'vitest'
import {
  JOURNAL_DIR,
  JOURNAL_DIR_RESOLUTION,
  JOURNAL_DIR_MODE,
  JOURNAL_FILE_MODE,
  MAX_INVALID_PAYLOAD_CHARS,
  MAX_PENDING_REQUESTS,
  REDACTED_PLACEHOLDER,
  REDACT_KEY_PATTERNS,
  REDACT_KEY_TOKENS,
  REDACT_PARTIAL_VALUE_PATTERNS,
  REDACT_VALUE_PATTERNS,
  SESSION_ID_PATTERN,
} from '../src/config.js'

describe('config', () => {
  test('journal dir points into the user home directory', () => {
    expect(JOURNAL_DIR).toContain('.mcp-journal')
  })

  test('with no install config the data directory comes from the historical default', () => {
    expect(JOURNAL_DIR_RESOLUTION.source).toBe('default')
    expect(JOURNAL_DIR_RESOLUTION.dataDir).toBe(JOURNAL_DIR)
    expect(JOURNAL_DIR_RESOLUTION.problem).toBeUndefined()
  })

  test('redaction key list covers authorization and token keys', () => {
    expect(REDACT_KEY_PATTERNS).toContain('authorization')
    expect(REDACT_KEY_PATTERNS).toContain('token')
  })

  test('redaction placeholder is a non-empty marker', () => {
    expect(REDACTED_PLACEHOLDER.length).toBeGreaterThan(0)
  })

  test('bare "key" is deliberately absent from the substring key patterns', () => {
    expect(REDACT_KEY_PATTERNS).not.toContain('key')
  })

  test('short ambiguous names live in the token list, not the substring list', () => {
    expect(REDACT_KEY_TOKENS).toContain('pin')
    expect(REDACT_KEY_PATTERNS).not.toContain('pin')
  })

  test('every value pattern is global so all occurrences are replaced', () => {
    expect(REDACT_VALUE_PATTERNS.every((pattern) => pattern.global)).toBe(true)
    expect(REDACT_PARTIAL_VALUE_PATTERNS.every((rule) => rule.pattern.global)).toBe(true)
  })

  test('no value pattern uses a nested quantifier (ReDoS guard)', () => {
    const nestedQuantifier = /\([^)]*[+*]\)[+*]/
    const sources = [
      ...REDACT_VALUE_PATTERNS.map((pattern) => pattern.source),
      ...REDACT_PARTIAL_VALUE_PATTERNS.map((rule) => rule.pattern.source),
    ]

    expect(sources.filter((source) => nestedQuantifier.test(source))).toEqual([])
  })

  test('journal files and directories are owner-only', () => {
    expect(JOURNAL_FILE_MODE).toBe(0o600)
    expect(JOURNAL_DIR_MODE).toBe(0o700)
  })

  test('bounded limits are set', () => {
    expect(MAX_INVALID_PAYLOAD_CHARS).toBeGreaterThan(0)
    expect(MAX_PENDING_REQUESTS).toBeGreaterThan(0)
  })

  test('the session id pattern rejects path separators and traversal', () => {
    expect(SESSION_ID_PATTERN.test('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
    expect(SESSION_ID_PATTERN.test('../etc/passwd')).toBe(false)
    expect(SESSION_ID_PATTERN.test('a/b')).toBe(false)
    expect(SESSION_ID_PATTERN.test('..')).toBe(false)
  })
})
