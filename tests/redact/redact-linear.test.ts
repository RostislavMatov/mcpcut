import { describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER, REDACT_VALUE_PATTERNS } from '../../src/config.js'
import { redactString } from '../../src/redact/redact.js'
import { redactKeyBlocks, redactText } from '../../src/redact/patterns.js'

/**
 * Redaction runs on every payload the journal records and on every file the
 * search index reads, synchronously. Input an upstream server, a client or an
 * agent controls must not make it super-linear: 512 KiB of a crafted run once
 * took minutes and froze the whole process.
 */

const SIZE = 512 * 1024
/** Generous for CI; the quadratic shapes took 5 s to 145 s at this size. */
const BUDGET_MS = 2000

function repeated(unit: string): string {
  return unit.repeat(Math.ceil(SIZE / unit.length))
}

describe('redaction stays linear on crafted input', () => {
  test.each([
    ['a lowercase hyphen run (URL scheme candidates)', 'a-'],
    ['an sk- run', 'sk-'],
    ['a JWT-like run with dots', 'eyJa.'],
    ['a JWT-like run of word boundaries (every `-` starts a candidate)', 'eyJ-'],
    ['JWT-like candidates with one dot each', 'eyJ-a.'],
    ['JWT-like candidates with two dots and a trailing run', 'eyJ-a.b-'],
    ['private key headers with no footer', '-----BEGIN PRIVATE KEY-----'],
    ['private key headers with bodies and no footer', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n'],
    ['scheme and user info without an @', 'a://x:'],
  ])('%s', (_name, unit) => {
    const text = repeated(unit)
    const started = performance.now()
    redactString(text)
    expect(performance.now() - started).toBeLessThan(BUDGET_MS)
  })
})

describe('the linear forms keep what they redact', () => {
  test('credentials after a scheme of up to 32 characters are redacted', () => {
    const scheme = `a${'b'.repeat(31)}`
    expect(redactText(`${scheme}://user:pass@host`)).toBe(`${scheme}://${REDACTED_PLACEHOLDER}@host`)
    expect(redactText('git+ssh://deploy:hunter2@git.example.com/repo')).toBe(`git+ssh://${REDACTED_PLACEHOLDER}@git.example.com/repo`)
  })

  test('a header without a footer followed by a complete block: everything from the first header to the footer goes', () => {
    const text = 'before -----BEGIN PRIVATE KEY-----\nAAAA cut here -----BEGIN RSA PRIVATE KEY-----\nBBBB\n-----END RSA PRIVATE KEY----- after'
    expect(redactText(text)).toBe(`before ${REDACTED_PLACEHOLDER} after`)
  })

  test('two complete blocks are redacted one by one, the text between them stays', () => {
    const block = (body: string) => `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`
    expect(redactText(`${block('AAA')} middle ${block('BBB')}`)).toBe(`${REDACTED_PLACEHOLDER} middle ${REDACTED_PLACEHOLDER}`)
  })

  test('a footer before any header and a header with no footer after it are left alone', () => {
    const text = '-----END PRIVATE KEY----- text -----BEGIN PRIVATE KEY----- tail'
    expect(redactText(text)).toBe(text)
  })

  test('a footer that shares the dashes of its header does not close it', () => {
    const text = '-----BEGIN PRIVATE KEY-----END PRIVATE KEY-----'
    expect(redactText(text)).toBe(text)
  })
})

describe('JWTs stay redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'

  test('a whole token, alone or inside text', () => {
    expect(redactText(jwt)).toBe(REDACTED_PLACEHOLDER)
    expect(redactText(`Authorization token was ${jwt}, then`)).toContain(`${REDACTED_PLACEHOLDER}, then`)
    expect(redactText(`a-${jwt}`)).toBe(`a-${REDACTED_PLACEHOLDER}`)
  })

  test('a token right after a run of lookalike starts loses its payload and signature', () => {
    const text = `${'eyJ-'.repeat(3)}${jwt}`
    expect(redactText(text)).not.toContain('eyJzdWIiOiIxIn0')
    expect(redactText(text)).not.toContain('c2lnbmF0dXJl')
  })
})

describe('the PEM scan replaces exactly what the block regex replaced', () => {
  const blockRegex = REDACT_VALUE_PATTERNS[0] as RegExp
  const byRegex = (text: string): string => text.replace(new RegExp(blockRegex.source, blockRegex.flags), REDACTED_PLACEHOLDER)

  test('a footer lookalike overlapping the real footer does not hide it', () => {
    const text = 'abc-----BEGIN PRIVATE KEY-----END BEGIN PRIVATE KEY-----END PRIVATE KEY----- A'
    expect(redactKeyBlocks(text)).toBe(`abc${REDACTED_PLACEHOLDER} A`)
    expect(redactKeyBlocks(text)).toBe(byRegex(text))
  })

  test('a header whose only footer shares its dashes stays, as with the regex', () => {
    const text = '-----END EC PRIVATE KEY----------BEGIN PRIVATE KEY-----END PRIVATE KEY-----'
    expect(redactKeyBlocks(text)).toBe(byRegex(text))
  })

  test('random strings of markers agree with the regex', () => {
    const tokens = [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '-----END PRIVATE KEY-----',
      '-----END EC PRIVATE KEY-----',
      '-----END BEGIN PRIVATE KEY-----',
      '-----',
      'END ',
      'BEGIN ',
      'PRIVATE KEY',
      '\r\n',
      'MIIE',
      ' ',
    ]
    // mulberry32: a product of two 32-bit numbers in plain JS loses bits past 2^53, and an LCG
    // written that way cycled through 45 distinct strings.
    let seed = 42
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return (t ^ (t >>> 14)) >>> 0
    }
    const texts = new Set<string>()
    for (let round = 0; round < 20_000; round += 1) {
      const text = Array.from({ length: 1 + (next() % 14) }, () => tokens[next() % tokens.length]).join('')
      texts.add(text)
      expect(redactKeyBlocks(text), JSON.stringify(text)).toBe(byRegex(text))
    }
    expect(texts.size).toBeGreaterThan(15_000)
  })
})

