import { describe, expect, test } from 'vitest'
import {
  JOURNAL_DIR,
  REDACTED_PLACEHOLDER,
  REDACT_KEY_PATTERNS,
} from '../src/config.js'

describe('config', () => {
  test('journal dir points into the user home directory', () => {
    expect(JOURNAL_DIR).toContain('.mcp-journal')
  })

  test('redaction key list covers authorization and token keys', () => {
    expect(REDACT_KEY_PATTERNS).toContain('authorization')
    expect(REDACT_KEY_PATTERNS).toContain('token')
  })

  test('redaction placeholder is a non-empty marker', () => {
    expect(REDACTED_PLACEHOLDER.length).toBeGreaterThan(0)
  })
})
