import { describe, expect, test } from 'vitest'
import { maskSecrets } from '../../../src/files/search/mask-secrets.js'

/** The indexer's second pass after the journal's redaction: key/value secrets and bare high-entropy tokens. */

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const HEX_40 = '0123456789abcdef0123456789abcdef01234567'

describe('maskSecrets key/value pairs', () => {
  test.each([
    ['password: "S3cr3tPassw0rd!"', 'password: "[REDACTED]"'],
    ['password: S3cr3tPassw0rd!', 'password: [REDACTED]'],
    [`export AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, 'export AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['SECRET_KEY = "django-insecure-x7!q"', 'SECRET_KEY = "[REDACTED]"'],
    ["db.passwd='hunter2'", "db.passwd='[REDACTED]'"],
    ['{"api-key": "abc def", "name": "x"}', '{"api-key": "[REDACTED]", "name": "x"}'],
    ['  apiKey: abc', '  apiKey: [REDACTED]'],
    ['PRIVATE.KEY=zzz', 'PRIVATE.KEY=[REDACTED]'],
    ['client_credential: x', 'client_credential: [REDACTED]'],
    ['GITHUB_TOKEN=ghp_abc', 'GITHUB_TOKEN=[REDACTED]'],
    ['ACCESS-KEY: k', 'ACCESS-KEY: [REDACTED]'],
  ])('%s', (input, expected) => {
    expect(maskSecrets(input)).toBe(expected)
  })

  test('only the pair is masked: neighbouring lines stay', () => {
    expect(maskSecrets('name: app\npassword: x\nport: 80')).toBe('name: app\npassword: [REDACTED]\nport: 80')
  })

  test('a key with no value does not swallow the next line', () => {
    expect(maskSecrets('password:\nnext line')).toBe('password:\nnext line')
  })

  test.each([
    'the password field is required',
    'Reset your password by email.',
    'tokens are counted per request',
    'a secret garden',
    'ratio = 3',
    'Use an API key from the settings page',
  ])('ordinary prose is left alone: %s', (text) => {
    expect(maskSecrets(text)).toBe(text)
  })
})

describe('maskSecrets standalone tokens', () => {
  test('a bare 40-hex token is masked', () => {
    expect(maskSecrets(`commit-less token ${HEX_40} end`)).toBe('commit-less token [REDACTED] end')
  })

  test('base64 of 40 or more characters with letters and digits is masked', () => {
    expect(maskSecrets(`key ${AWS_SECRET}`)).toBe('key [REDACTED]')
    expect(maskSecrets('jwt-ish abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_- x')).toBe('jwt-ish [REDACTED] x')
  })

  test('short hex, plain long words and digit-only runs stay', () => {
    const text = `deadbeef 0123456789abcdef ${'a'.repeat(50)} ${'7'.repeat(50)} ${'abcdef'.repeat(6)} supercalifragilisticexpialidocious`
    expect(maskSecrets(text)).toBe(text)
  })

  test('a 31-character hex run stays, 32 goes', () => {
    expect(maskSecrets('a1'.repeat(15) + 'b')).toBe('a1'.repeat(15) + 'b')
    expect(maskSecrets('a1'.repeat(16))).toBe('[REDACTED]')
  })
})

describe('maskSecrets runs in linear time', () => {
  const MIB = 1024 * 1024
  const adversarial: Array<[string, string]> = [
    ['password= repeated', 'password='.repeat(MIB / 9)],
    ['password=" repeated', 'password="'.repeat(MIB / 10)],
    ['quoted keys on many lines', 'token: "x"\n'.repeat(MIB / 11)],
    ['keyword runs', 'passwordpasswd'.repeat(MIB / 14)],
    ['one letter', 'a'.repeat(MIB)],
    ['long hex with no boundary', 'ab1'.repeat(MIB / 3)],
    ['long key tail', `secret${'_'.repeat(MIB - 6)}`],
    ['spaces after key', `token${' '.repeat(MIB - 5)}`],
  ]

  test.each(adversarial)('%s: 1 MiB in under a second', (_name, input) => {
    const startedAt = performance.now()
    maskSecrets(input)
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })
})
