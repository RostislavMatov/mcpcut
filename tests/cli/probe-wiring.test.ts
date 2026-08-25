import { describe, expect, test } from 'vitest'
import { scrubProbeResult } from '../../src/cli/probe-wiring.js'
import { normalizeKnownSecrets } from '../../src/redact/known-secrets.js'

/**
 * Security-review follow-up (M5.5 п.1): the exact-value scrub that
 * `composeProbeChain` applies to every probe result BEFORE it reaches the
 * status store / SSE / journal. Pattern redaction cannot catch an opaque
 * vault value (bare hex/base64 with no `sk-…` shape) — this layer can,
 * because the chain itself resolved the value and knows it byte-for-byte.
 */

// Deliberately shapeless: no prefix, no PEM markers — pattern redaction
// would NOT catch this; only the exact-value scrub can.
const OPAQUE_SECRET = 'c0ffee42d15ea5e0badf00d1337beef9'
const SECRETS = normalizeKnownSecrets([OPAQUE_SECRET])

describe('scrubProbeResult — exact-value scrub of probe messages', () => {
  test('an opaque vault value embedded in an error message never survives', () => {
    const scrubbed = scrubProbeResult(
      { status: 'error', message: `upstream said: token ${OPAQUE_SECRET} rejected` },
      SECRETS,
    )
    expect(scrubbed.status).toBe('error')
    if (scrubbed.status === 'alive') throw new Error('unreachable')
    expect(scrubbed.message).not.toContain(OPAQUE_SECRET)
    expect(scrubbed.message).toContain('token')
  })

  test('unreachable and vault-refused messages are scrubbed the same way', () => {
    for (const status of ['unreachable', 'vault-refused'] as const) {
      const scrubbed = scrubProbeResult({ status, message: OPAQUE_SECRET }, SECRETS)
      if (scrubbed.status === 'alive') throw new Error('unreachable')
      expect(scrubbed.message).not.toContain(OPAQUE_SECRET)
    }
  })

  test('an alive result and an empty scrub list pass through untouched', () => {
    const alive = {
      status: 'alive',
      initializeLatencyMs: 12,
      probedVia: 'initialize',
    } as const
    expect(scrubProbeResult(alive, SECRETS)).toBe(alive)
    const error = { status: 'error', message: 'plain failure' } as const
    expect(scrubProbeResult(error, [])).toBe(error)
  })

  test('normalizeKnownSecrets drops short values so common words are never blanked', () => {
    expect(normalizeKnownSecrets(['dev', '8080', OPAQUE_SECRET])).toEqual([OPAQUE_SECRET])
  })
})
