import { describe, expect, test } from 'vitest'
import { describeOrchestratorError, OrchestratorUnavailableError } from '../../hub/src/orchestrator.js'

/**
 * `describeOrchestratorError` — the one way an orchestrator failure reaches
 * a log line. The `Orchestrator` contract asks implementations to keep
 * tokens out of their error messages; this is the structural guarantee for
 * the day one does not.
 */

const SECRETS = [
  'mcpo_abcdefghijklmnop',
  'mcpa_ZyXw-VuTs_1234567890',
  'mcps_0123456789abcdef',
  'ghp_abcdefghijklmnopqrstuvwx',
  'gho_ABCDEFGH12345678',
  'ghs_zzzzzzzzzzzz',
  'ghu_1234567890ab',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  'a'.repeat(16) + 'B'.repeat(16) + '-_',
  '0123456789abcdef0123456789abcdef',
] as const

describe('describeOrchestratorError', () => {
  test.each(SECRETS)('redacts %s from the message', (secret) => {
    const described = describeOrchestratorError(new Error(`install failed, token=${secret}; retry`))

    expect(described).not.toContain(secret)
    expect(described).toContain('[redacted]')
    expect(described).toContain('Error: install failed, token=')
    expect(described).toContain('; retry')
  })

  test('redacts a token in the error name as well', () => {
    const error = new Error('boom')
    error.name = 'Leak mcpo_abcdefghijklmnop'

    expect(describeOrchestratorError(error)).not.toContain('mcpo_abcdefghijklmnop')
  })

  test('keeps an ordinary message readable', () => {
    const described = describeOrchestratorError(new OrchestratorUnavailableError('create an install'))

    expect(described).toBe(
      'OrchestratorUnavailableError: orchestrator unavailable: cannot create an install (hosted installs are not open yet)',
    )
  })

  test('keeps short identifiers and ordinary words', () => {
    expect(describeOrchestratorError(new Error('subdomain alice-2 on node mcpo_short timed out after 40000 ms'))).toBe(
      'Error: subdomain alice-2 on node mcpo_short timed out after 40000 ms',
    )
  })

  test('a non-Error value says only that', () => {
    expect(describeOrchestratorError('mcpo_abcdefghijklmnop')).toBe('non-Error value thrown')
  })
})
