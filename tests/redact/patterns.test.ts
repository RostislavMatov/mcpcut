import { describe, expect, test } from 'vitest'
import { redact } from '../../src/redact/redact.js'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'

/**
 * Covers the aggressive string scrubbing added after the redaction review:
 * vendor token shapes, JWTs, URL credentials, header/env assignments and
 * key-aware scrubbing of raw (unparsed) text, plus embedded-JSON recursion.
 */

/** Redacts a bare string the way a raw/stderr line is redacted. */
function scrub(text: string): string {
  return redact(text) as string
}

describe('value-pattern scrubbing of raw strings', () => {
  test.each([
    ['OpenAI-style key', 'key is sk-live-abcdefghijklmnop1234', 'sk-live-abcdefghijklmnop1234'],
    ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub OAuth token', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', 'gho_abcdefghijklmnopqrst'],
    ['Slack token', 'xoxb-123456789012-abcdefABCDEF', 'xoxb-123456789012-abcdefABCDEF'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['Google API key', `AIza${'a'.repeat(35)}`, `AIza${'a'.repeat(35)}`],
    ['GitLab PAT', 'glpat-abcdefghijklmnopqrstu', 'glpat-abcdefghijklmnopqrstu'],
  ])('redacts a %s in free text', (_label, text, secret) => {
    const result = scrub(`prefix ${text} suffix`)

    expect(result).not.toContain(secret)
    expect(result).toContain(REDACTED_PLACEHOLDER)
  })

  test('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

    const result = scrub(`Authorization was ${jwt}`)

    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(result).toContain(REDACTED_PLACEHOLDER)
  })

  test('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1\n-----END RSA PRIVATE KEY-----'

    const result = scrub(`loaded key:\n${pem}\ndone`)

    expect(result).not.toContain('MIIEowIBAAKCAQEA1')
    expect(result).toContain(REDACTED_PLACEHOLDER)
    expect(result).toContain('done')
  })

  test('redacts a PKCS8 PEM private key block with no algorithm qualifier (Ed25519 keygen shape)', () => {
    // `generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })`
    // (journal/signing.ts) labels the block plain "PRIVATE KEY" -- PKCS8
    // encodes the algorithm inside the DER body, not in the PEM header, unlike
    // the legacy PKCS1 "RSA PRIVATE KEY" / SEC1 "EC PRIVATE KEY" shapes above.
    // A pattern that requires a qualifier word before "PRIVATE KEY" silently
    // lets this exact, real shape through.
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHh1U0GDKsUfNhVFt/z6figuxT7Ao8qwP6kPzk+bXkHG\n-----END PRIVATE KEY-----'

    const result = scrub(`signing.key:\n${pem}\ndone`)

    expect(result).not.toContain('MC4CAQAwBQYDK2VwBCIEIHh1U0GDKsUfNhVFt/z6figuxT7Ao8qwP6kPzk+bXkHG')
    expect(result).toContain(REDACTED_PLACEHOLDER)
    expect(result).toContain('done')
  })

  test('redacts only the userinfo segment of a URL, preserving scheme and host', () => {
    const result = scrub('dsn is postgres://admin:hunter2@db.internal:5432/app')

    expect(result).not.toContain('hunter2')
    expect(result).not.toContain('admin:')
    expect(result).toContain('postgres://')
    expect(result).toContain('@db.internal:5432/app')
  })

  test('redacts only the value of a query-string credential', () => {
    const result = scrub('GET https://api.example.com/v1/things?api_key=abc123XYZ&limit=10')

    expect(result).not.toContain('abc123XYZ')
    expect(result).toContain('api_key=')
    expect(result).toContain('limit=10')
  })

  test.each(['access_token', 'token', 'secret', 'password'])(
    'redacts the value of a %s query parameter',
    (param) => {
      const result = scrub(`https://example.com/cb?${param}=zzTOPSECRETzz&next=/home`)

      expect(result).not.toContain('zzTOPSECRETzz')
      expect(result).toContain('next=/home')
    },
  )

  test('redacts a header/env style assignment (X-API-Key: value)', () => {
    const result = scrub('X-API-Key: abc-123-def-456')

    expect(result).not.toContain('abc-123-def-456')
    expect(result).toContain(REDACTED_PLACEHOLDER)
  })

  test('redacts an env-style assignment in a stderr-shaped line', () => {
    const result = scrub('env: OPENAI_API_KEY=super-sekret-value starting up')

    expect(result).not.toContain('super-sekret-value')
    expect(result).toContain('starting up')
  })

  test('leaves ordinary text untouched', () => {
    const text = 'fake-server: starting on port 8080 with 3 tools'

    expect(scrub(text)).toBe(text)
  })

  test('does not redact a bare word that merely resembles a vendor prefix', () => {
    const text = 'sk-short and AKIA and eyJnope'

    expect(scrub(text)).toBe(text)
  })
})

describe('key-aware scrubbing inside raw (unparsed) text', () => {
  test('redacts a quoted secret value in a truncated JSON fragment', () => {
    const fragment = '{"jsonrpc":"2.0","params":{"password":"hunter2","name":"bob"'

    const result = scrub(fragment)

    expect(result).not.toContain('hunter2')
    expect(result).toContain('"name":"bob"')
    expect(result).toContain(REDACTED_PLACEHOLDER)
  })

  test('redacts an unquoted numeric secret value in a truncated fragment', () => {
    const result = scrub('{"otp":123456,"count":3')

    expect(result).not.toContain('123456')
    expect(result).toContain('"count":3')
  })

  test('redacts a value whose key matches with spacing around the colon', () => {
    // No closing brace: unparseable, so this exercises the lexical pass.
    const result = scrub('{ "api_key" : "abc-secret-value" , "safe": 1 ')

    expect(result).not.toContain('abc-secret-value')
    expect(result).toContain('"safe": 1')
  })

  test('a nested sensitive pair under a non-sensitive key is still scrubbed', () => {
    const result = scrub('{"params":{"password":"hunter2"},"id":1')

    expect(result).not.toContain('hunter2')
    expect(result).toContain('"id":1')
  })

  test('leaves non-sensitive quoted keys untouched', () => {
    const fragment = '{"method":"tools/call","cursor":"abc"'

    expect(scrub(fragment)).toBe(fragment)
  })
})

describe('embedded JSON string values', () => {
  test('redacts a secret inside a JSON-encoded string value (MCP content[0].text shape)', () => {
    const input = {
      result: { content: [{ type: 'text', text: JSON.stringify({ api_key: 'sk-live-XYZ' }) }] },
    }

    const serialized = JSON.stringify(redact(input))

    expect(serialized).not.toContain('sk-live-XYZ')
    expect(serialized).toContain(REDACTED_PLACEHOLDER)
  })

  test('redacts a secret inside a JSON-encoded array string value', () => {
    const input = { text: JSON.stringify([{ password: 'hunter2' }]) }

    const serialized = JSON.stringify(redact(input))

    expect(serialized).not.toContain('hunter2')
  })

  test('leaves an embedded JSON string byte-identical when it holds no secrets', () => {
    const embedded = '{ "a": 1, "b": [2, 3] }'
    const input = { text: embedded }

    const result = redact(input) as { text: string }

    expect(result.text).toBe(embedded)
  })

  test('falls back to pattern scrubbing when the embedded JSON does not parse', () => {
    const input = { text: '{"api_key":"sk-live-abcdefghijklmnop1234"' }

    const serialized = JSON.stringify(redact(input))

    expect(serialized).not.toContain('sk-live-abcdefghijklmnop1234')
  })

  test('does not recurse past the nesting cap on hostile deeply-encoded input', () => {
    const deep = [0, 1, 2, 3, 4, 5, 6].reduce<string>(
      (acc) => JSON.stringify({ next: acc }),
      JSON.stringify({ safe: 'ok' }),
    )

    expect(() => redact({ text: deep })).not.toThrow()
  })

  test('does not attempt embedded parsing of an oversize string', () => {
    const huge = `{"a":"${'x'.repeat(200_000)}"}`

    const result = redact({ text: huge }) as { text: string }

    expect(result.text).toBe(huge)
  })
})

describe('key patterns', () => {
  test.each([
    'pass',
    'pwd',
    'jwt',
    'bearerToken',
    'signature',
    'otp',
    'user_pin',
    'mfa',
    'salt',
    'seed',
    'mnemonic',
    'certificate',
    'pem',
    'ssh_key',
    'dsn',
    'connection_string',
    'conn_str',
    'github_pat',
    'client_secret',
  ])('redacts the value under a %s key', (key) => {
    const result = redact({ [key]: 'sensitive-value' }) as Record<string, unknown>

    expect(result[key]).toBe(REDACTED_PLACEHOLDER)
  })

  test.each(['path', 'ping', 'keyword', 'hotkey', 'passthrough', 'spinner', 'patch', 'seedling'])(
    'does not redact the benign key %s',
    (key) => {
      const result = redact({ [key]: 'benign-value' }) as Record<string, unknown>

      expect(result[key]).toBe('benign-value')
    },
  )

  test('documented over-redaction: "auth" as a substring also redacts author', () => {
    const result = redact({ author: 'ada' }) as Record<string, unknown>

    expect(result.author).toBe(REDACTED_PLACEHOLDER)
  })
})
