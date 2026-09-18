import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StoreCorruptError } from '../../src/policy/store.js'
import { MAX_ENV_ENTRIES_PER_SERVER, REGISTRY_FILE_NAME } from '../../src/registry/constants.js'
import { parseRegistry, parseServerRecord } from '../../src/registry/schema.js'
import { createRegistryStore } from '../../src/registry/store.js'

/**
 * Hardening tests for the registry: prototype-pollution keys, secret
 * literals sneaking past the vault, malformed vault references, and a
 * corrupt registry file that must fail loudly instead of reading as empty.
 */

const STDIO_BASE = { name: 'github', transport: 'stdio', command: 'npx' }
const HTTP_BASE = { name: 'remote-api', transport: 'http', url: 'https://example.com/mcp' }

describe('reserved object keys', () => {
  test('__proto__ as an env key is rejected loudly (not silently dropped)', () => {
    const raw = JSON.parse('{"name":"github","transport":"stdio","command":"npx","env":{"__proto__":"x"}}')

    const result = parseServerRecord(raw)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(JSON.stringify(result.error.issues)).toContain('__proto__')
    }
  })

  test('__proto__ as a header key is rejected', () => {
    const raw = JSON.parse('{"name":"api","transport":"http","url":"https://x.example","headers":{"__proto__":"x"}}')

    expect(parseServerRecord(raw).ok).toBe(false)
  })

  test('constructor and prototype as env keys are rejected', () => {
    expect(parseServerRecord({ ...STDIO_BASE, env: { constructor: 'x' } }).ok).toBe(false)
    expect(parseServerRecord({ ...STDIO_BASE, env: { prototype: 'x' } }).ok).toBe(false)
  })

  test('__proto__ as a server key in the registry file is rejected', () => {
    const raw = JSON.parse('{"version":1,"servers":{"__proto__":{"name":"github","transport":"stdio","command":"npx"}}}')

    expect(parseRegistry(raw).ok).toBe(false)
  })
})

describe('secret literals are refused (vault is the only path)', () => {
  test('sensitive env key with a plain literal value is rejected with a vault hint', () => {
    const result = parseServerRecord({ ...STDIO_BASE, env: { GITHUB_TOKEN: 'not-even-secret-shaped' } })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const text = JSON.stringify(result.error.issues)
      expect(text).toContain('vault set')
      expect(text).toContain('vault:')
    }
  })

  test('benign env key with a secret-shaped value (GitHub PAT) is rejected', () => {
    const result = parseServerRecord({ ...STDIO_BASE, env: { SOME_VALUE: `ghp_${'a'.repeat(36)}` } })

    expect(result.ok).toBe(false)
  })

  test('benign env key with a Bearer-shaped value is rejected', () => {
    const result = parseServerRecord({ ...STDIO_BASE, env: { SOME_VALUE: 'Bearer abc123def456' } })

    expect(result.ok).toBe(false)
  })

  test('Authorization header with a literal value is rejected; vault reference is accepted', () => {
    expect(parseServerRecord({ ...HTTP_BASE, headers: { Authorization: 'my-literal' } }).ok).toBe(false)
    expect(parseServerRecord({ ...HTTP_BASE, headers: { Authorization: 'vault:api-key' } }).ok).toBe(true)
  })

  test('sensitive key + vault reference is accepted (references are not secrets)', () => {
    const result = parseServerRecord({ ...STDIO_BASE, env: { GITHUB_TOKEN: 'vault:github-pat' } })

    expect(result.ok).toBe(true)
  })
})

describe('vault reference syntax', () => {
  test.each(['vault:', 'vault:UPPER', 'vault:-leading', 'vault:has_underscore', `vault:${'x'.repeat(65)}`])(
    'malformed vault reference %s is rejected',
    (value) => {
      const result = parseServerRecord({ ...STDIO_BASE, env: { GITHUB_TOKEN: value } })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(JSON.stringify(result.error.issues)).toContain('vault')
      }
    },
  )
})

describe('size limits', () => {
  test('env map above the entry cap is rejected', () => {
    const env = Object.fromEntries(
      Array.from({ length: MAX_ENV_ENTRIES_PER_SERVER + 1 }, (_, i) => [`VAR_${i}`, 'v']),
    )

    expect(parseServerRecord({ ...STDIO_BASE, env }).ok).toBe(false)
  })
})

describe('corrupt registry file', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-registry-hardening-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  test('unparseable registry.json fails loudly with StoreCorruptError, never reads as empty', async () => {
    await writeFile(join(journalDir, REGISTRY_FILE_NAME), '{ not json', 'utf8')

    await expect(createRegistryStore(journalDir).listServers()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('valid JSON with an invalid registry shape also fails with StoreCorruptError', async () => {
    await writeFile(join(journalDir, REGISTRY_FILE_NAME), JSON.stringify({ version: 99 }), 'utf8')

    await expect(createRegistryStore(journalDir).getServer('github')).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('getServer("__proto__") returns undefined instead of Object.prototype', async () => {
    const store = createRegistryStore(journalDir)

    expect(await store.getServer('__proto__')).toBeUndefined()
    expect(await store.removeServer('__proto__')).toEqual({ status: 'not-found' })
  })
})
