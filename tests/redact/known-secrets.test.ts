import { describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import {
  MIN_KNOWN_SECRET_CHARS,
  normalizeKnownSecrets,
  scrubKnownSecrets,
} from '../../src/redact/known-secrets.js'
import { redact, redactString } from '../../src/redact/redact.js'

/**
 * Known-secret redaction: exact-value scrubbing for material the control
 * plane itself handed to an upstream. Patterns cannot recognise a bare
 * high-entropy string, so the journal has to be told the literal values.
 */

const BARE = 'Zk4mQp7RtY2wLxV9nB3sCd6fGh1jKl0a'

describe('normalizeKnownSecrets', () => {
  test('drops values shorter than the minimum, keeping the ones at the threshold', () => {
    const short = 'a'.repeat(MIN_KNOWN_SECRET_CHARS - 1)
    const exact = 'b'.repeat(MIN_KNOWN_SECRET_CHARS)

    expect(normalizeKnownSecrets([short, exact])).toEqual([exact])
  })

  test('deduplicates repeated values', () => {
    expect(normalizeKnownSecrets([BARE, BARE])).toEqual([BARE])
  })

  test('orders longest first so a secret containing another is replaced whole', () => {
    const inner = 'inner-secret-value'
    const outer = `${inner}-and-more`

    expect(normalizeKnownSecrets([inner, outer])).toEqual([outer, inner])
  })

  test('returns a frozen array (no caller can grow the registered set)', () => {
    expect(Object.isFrozen(normalizeKnownSecrets([BARE]))).toBe(true)
  })
})

describe('scrubKnownSecrets', () => {
  test('returns the text untouched when nothing is registered', () => {
    expect(scrubKnownSecrets(`token=${BARE}`, [])).toBe(`token=${BARE}`)
  })

  test('replaces every occurrence of a registered value', () => {
    const text = `${BARE} and again ${BARE}`

    expect(scrubKnownSecrets(text, [BARE])).toBe(`${REDACTED_PLACEHOLDER} and again ${REDACTED_PLACEHOLDER}`)
  })

  test('treats regex metacharacters in a secret literally', () => {
    const secret = 'a.*b(c)[d]+e$'

    expect(scrubKnownSecrets(`x${secret}y`, normalizeKnownSecrets([secret]))).toBe(
      `x${REDACTED_PLACEHOLDER}y`,
    )
    expect(scrubKnownSecrets('aXXXbYcZdZe', normalizeKnownSecrets([secret]))).toBe('aXXXbYcZdZe')
  })

  test('replaces the longest overlapping secret whole when normalized first', () => {
    const inner = 'inner-secret-value'
    const outer = `${inner}-and-more`

    expect(scrubKnownSecrets(outer, normalizeKnownSecrets([inner, outer]))).toBe(REDACTED_PLACEHOLDER)
  })
})

describe('redact/redactString honor known secrets', () => {
  test('a bare value under an innocent key is redacted structurally', () => {
    const result = redact({ note: `the token is ${BARE}` }, [BARE])

    expect(JSON.stringify(result)).not.toContain(BARE)
  })

  test('a bare value in a raw line is redacted', () => {
    expect(redactString(`starting with ${BARE}`, [BARE])).not.toContain(BARE)
  })

  test('without registration the same bare value survives (this is the defect being fixed)', () => {
    expect(redactString(`starting with ${BARE}`)).toContain(BARE)
  })
})
