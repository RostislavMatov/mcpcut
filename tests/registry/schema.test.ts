import { describe, expect, test } from 'vitest'
import {
  looksLikeSecretLiteral,
  parseRegistry,
  parseServerRecord,
} from '../../src/registry/schema.js'

/** Formats a zod error into `path: message`-ish text for substring assertions. */
function errorText(result: { ok: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }): string {
  if (result.ok || result.error === undefined) return ''
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
}

const VALID_STDIO = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'vault:github-pat' },
}

const VALID_HTTP = {
  name: 'remote-api',
  transport: 'http',
  url: 'https://example.com/mcp',
}

describe('parseServerRecord: stdio', () => {
  test('accepts a minimal stdio record (name, transport, command)', () => {
    const result = parseServerRecord({ name: 'github', transport: 'stdio', command: 'npx' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.name).toBe('github')
      expect(result.record.transport).toBe('stdio')
    }
  })

  test('accepts args and vault-referenced env values', () => {
    const result = parseServerRecord(VALID_STDIO)

    expect(result.ok).toBe(true)
    if (result.ok && result.record.transport === 'stdio') {
      expect(result.record.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
      expect(result.record.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'vault:github-pat' })
    }
  })

  test('rejects a stdio record without command', () => {
    const result = parseServerRecord({ name: 'github', transport: 'stdio' })

    expect(result.ok).toBe(false)
  })

  test('rejects http-only keys (url) on a stdio record', () => {
    const result = parseServerRecord({ ...VALID_STDIO, url: 'https://example.com' })

    expect(result.ok).toBe(false)
    expect(errorText(result)).toContain('url')
  })

  test('rejects unknown keys (strictObject)', () => {
    const result = parseServerRecord({ name: 'github', transport: 'stdio', command: 'npx', comand: 'typo' })

    expect(result.ok).toBe(false)
    expect(errorText(result)).toContain('comand')
  })

  test('rejects a non-string env value', () => {
    const result = parseServerRecord({ name: 'github', transport: 'stdio', command: 'npx', env: { PORT: 8080 } })

    expect(result.ok).toBe(false)
  })

  test('rejects an env variable name that is not a valid identifier', () => {
    const result = parseServerRecord({ name: 'github', transport: 'stdio', command: 'npx', env: { 'BAD NAME': 'x' } })

    expect(result.ok).toBe(false)
  })
})

describe('parseServerRecord: server name', () => {
  test.each(['a', 'github', 'my-server-1', 'x'.repeat(64)])('accepts valid name %s', (name) => {
    const result = parseServerRecord({ name, transport: 'stdio', command: 'x' })

    expect(result.ok).toBe(true)
  })

  test.each(['', 'GitHub', '-leading', 'has_underscore', 'x'.repeat(65), 'dot.name'])(
    'rejects invalid name %s',
    (name) => {
      const result = parseServerRecord({ name, transport: 'stdio', command: 'x' })

      expect(result.ok).toBe(false)
    },
  )

  test('rejects a name with the reserved "auto:" prefix (collides with the M2 fallback identity)', () => {
    const result = parseServerRecord({ name: 'auto:abc123', transport: 'stdio', command: 'x' })

    expect(result.ok).toBe(false)
    expect(errorText(result)).toContain('auto:')
  })
})

describe('parseServerRecord: http', () => {
  test('accepts a minimal http record and defaults protocol to "auto"', () => {
    const result = parseServerRecord(VALID_HTTP)

    expect(result.ok).toBe(true)
    if (result.ok && result.record.transport === 'http') {
      expect(result.record.url).toBe('https://example.com/mcp')
      expect(result.record.protocol).toBe('auto')
    }
  })

  test.each(['sessionful', 'stateless', 'auto'])('accepts explicit protocol %s', (protocol) => {
    const result = parseServerRecord({ ...VALID_HTTP, protocol })

    expect(result.ok).toBe(true)
    if (result.ok && result.record.transport === 'http') {
      expect(result.record.protocol).toBe(protocol)
    }
  })

  test('rejects an unknown protocol value', () => {
    const result = parseServerRecord({ ...VALID_HTTP, protocol: 'bogus' })

    expect(result.ok).toBe(false)
  })

  test('accepts plain http:// urls', () => {
    const result = parseServerRecord({ ...VALID_HTTP, url: 'http://127.0.0.1:8090/mcp' })

    expect(result.ok).toBe(true)
  })

  test.each(['ftp://example.com', 'not a url', 'file:///etc/passwd', ''])('rejects url %s', (url) => {
    const result = parseServerRecord({ ...VALID_HTTP, url })

    expect(result.ok).toBe(false)
  })

  test('accepts vault-referenced headers', () => {
    const result = parseServerRecord({ ...VALID_HTTP, headers: { Authorization: 'vault:api-key' } })

    expect(result.ok).toBe(true)
  })

  test('rejects stdio-only keys (command) on an http record', () => {
    const result = parseServerRecord({ ...VALID_HTTP, command: 'npx' })

    expect(result.ok).toBe(false)
  })

  test('rejects an unknown transport', () => {
    const result = parseServerRecord({ name: 'x', transport: 'websocket', url: 'https://example.com' })

    expect(result.ok).toBe(false)
  })
})

describe('looksLikeSecretLiteral', () => {
  test.each([
    ['GITHUB_TOKEN', 'hello'],
    ['Authorization', 'abc'],
    ['MY_API_KEY', 'plain-value'],
    ['SOME_VAR', 'Bearer abc123def'],
    ['SOME_VAR', `ghp_${'a'.repeat(36)}`],
    ['SOME_VAR', `sk-${'a'.repeat(24)}`],
  ])('flags %s=%s as a secret literal', (key, value) => {
    expect(looksLikeSecretLiteral(key, value)).toBe(true)
  })

  test.each([
    ['NODE_ENV', 'production'],
    ['MY_PATH', '/usr/local/bin'],
    ['LOG_LEVEL', 'debug'],
  ])('does not flag %s=%s', (key, value) => {
    expect(looksLikeSecretLiteral(key, value)).toBe(false)
  })
})

describe('parseRegistry', () => {
  test('accepts a valid registry file', () => {
    const result = parseRegistry({ version: 1, servers: { github: { ...VALID_STDIO } } })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.registry.servers)).toEqual(['github'])
    }
  })

  test('accepts an empty servers map', () => {
    const result = parseRegistry({ version: 1, servers: {} })

    expect(result.ok).toBe(true)
  })

  test('rejects an unsupported version', () => {
    const result = parseRegistry({ version: 2, servers: {} })

    expect(result.ok).toBe(false)
  })

  test('rejects a map key that does not match the record name', () => {
    const result = parseRegistry({ version: 1, servers: { alias: { ...VALID_STDIO, name: 'github' } } })

    expect(result.ok).toBe(false)
    expect(errorText(result)).toContain('alias')
  })

  test('rejects non-object input', () => {
    expect(parseRegistry('nope').ok).toBe(false)
    expect(parseRegistry(null).ok).toBe(false)
    expect(parseRegistry(42).ok).toBe(false)
  })
})
