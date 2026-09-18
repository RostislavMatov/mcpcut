import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  VAULT_ENC_FILE_NAME,
  VAULT_KEY_FILE_NAME,
  VAULT_KEY_LENGTH_BYTES,
} from '../../src/vault/constants.js'
import { createVaultStore, type VaultStore } from '../../src/vault/store.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-vault-store-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function makeStore(now?: () => number): VaultStore {
  return createVaultStore({ journalDir, ...(now !== undefined ? { now } : {}) })
}

async function initialized(now?: () => number): Promise<VaultStore> {
  const store = makeStore(now)
  const result = await store.init()
  expect(result.status).toBe('initialized')
  return store
}

describe('init', () => {
  test('creates vault.key (base64 of 32 bytes) with mode 0600', async () => {
    await initialized()

    const keyPath = join(journalDir, VAULT_KEY_FILE_NAME)
    const raw = await readFile(keyPath, 'utf8')
    expect(Buffer.from(raw.trim(), 'base64').length).toBe(VAULT_KEY_LENGTH_BYTES)
    const mode = (await stat(keyPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('second init fails with already-initialized and leaves the key untouched', async () => {
    const store = await initialized()
    const keyPath = join(journalDir, VAULT_KEY_FILE_NAME)
    const before = await readFile(keyPath, 'utf8')

    const second = await store.init()

    expect(second.status).toBe('already-initialized')
    expect(await readFile(keyPath, 'utf8')).toBe(before)
  })
})

describe('uninitialized vault', () => {
  test.each(['setSecret', 'listSecrets', 'removeSecret', 'readSecretValues', 'rekey'] as const)(
    '%s without vault.key → not-initialized',
    async (method) => {
      const store = makeStore()

      const result =
        method === 'setSecret'
          ? await store.setSecret('a', 'v')
          : method === 'listSecrets'
            ? await store.listSecrets()
            : method === 'removeSecret'
              ? await store.removeSecret('a')
              : method === 'readSecretValues'
                ? await store.readSecretValues(['a'])
                : await store.rekey()

      expect(result.status).toBe('not-initialized')
    },
  )
})

describe('setSecret / readSecretValues / listSecrets', () => {
  test('set then read returns the value', async () => {
    const store = await initialized()

    const set = await store.setSecret('github-pat', 'tok-123')
    const read = await store.readSecretValues(['github-pat'])

    expect(set.status).toBe('set')
    expect(read).toEqual({ status: 'read', values: { 'github-pat': 'tok-123' } })
  })

  test('missing vault.enc with an existing key is a valid empty vault', async () => {
    const store = await initialized()

    const listed = await store.listSecrets()

    expect(listed).toEqual({ status: 'listed', secrets: [] })
  })

  test('vault.enc is written with mode 0600', async () => {
    const store = await initialized()
    await store.setSecret('a', 'v')

    const mode = (await stat(join(journalDir, VAULT_ENC_FILE_NAME))).mode & 0o777

    expect(mode).toBe(0o600)
  })

  test.each(['', 'UPPER', '-leading', 'has_underscore', 'a'.repeat(65), 'has space'])(
    'invalid secret name %j → invalid-name',
    async (name) => {
      const store = await initialized()

      const result = await store.setSecret(name, 'v')

      expect(result.status).toBe('invalid-name')
    },
  )

  test('listSecrets returns names and dates, sorted, and never carries values', async () => {
    let clock = 1_000
    const store = await initialized(() => clock)
    await store.setSecret('bravo', 'v1')
    clock = 2_000
    await store.setSecret('alpha', 'v2')

    const listed = await store.listSecrets()

    expect(listed.status).toBe('listed')
    if (listed.status !== 'listed') return
    expect(listed.secrets.map((s) => s.name)).toEqual(['alpha', 'bravo'])
    expect(JSON.stringify(listed.secrets)).not.toContain('v1')
    expect(JSON.stringify(listed.secrets)).not.toContain('v2')
  })

  test('overwriting a secret preserves createdAt and advances updatedAt', async () => {
    let clock = 1_000
    const store = await initialized(() => clock)
    await store.setSecret('a', 'first')
    clock = 5_000
    await store.setSecret('a', 'second')

    const listed = await store.listSecrets()
    const read = await store.readSecretValues(['a'])

    expect(listed.status).toBe('listed')
    if (listed.status !== 'listed') return
    expect(listed.secrets[0]?.createdAt).toBe(new Date(1_000).toISOString())
    expect(listed.secrets[0]?.updatedAt).toBe(new Date(5_000).toISOString())
    expect(read).toEqual({ status: 'read', values: { a: 'second' } })
  })

  test('readSecretValues returns only the names that exist', async () => {
    const store = await initialized()
    await store.setSecret('present', 'v')

    const read = await store.readSecretValues(['present', 'absent'])

    expect(read).toEqual({ status: 'read', values: { present: 'v' } })
  })

  test('concurrent sets of different names both persist (no lost update)', async () => {
    const store = await initialized()

    await Promise.all([store.setSecret('one', '1'), store.setSecret('two', '2')])

    const read = await store.readSecretValues(['one', 'two'])
    expect(read).toEqual({ status: 'read', values: { one: '1', two: '2' } })
  })
})

describe('removeSecret', () => {
  test('removes an existing secret', async () => {
    const store = await initialized()
    await store.setSecret('a', 'v')

    const removed = await store.removeSecret('a')
    const listed = await store.listSecrets()

    expect(removed.status).toBe('removed')
    expect(listed).toEqual({ status: 'listed', secrets: [] })
  })

  test('removing an absent secret → not-found', async () => {
    const store = await initialized()

    const removed = await store.removeSecret('missing')

    expect(removed.status).toBe('not-found')
  })

  test('invalid name → invalid-name', async () => {
    const store = await initialized()

    const removed = await store.removeSecret('BAD NAME')

    expect(removed.status).toBe('invalid-name')
  })
})

describe('rekey', () => {
  test('replaces the key and keeps every secret readable', async () => {
    const store = await initialized()
    await store.setSecret('a', 'value-a')
    await store.setSecret('b', 'value-b')
    const keyPath = join(journalDir, VAULT_KEY_FILE_NAME)
    const oldKey = await readFile(keyPath, 'utf8')

    const rekeyed = await store.rekey()

    expect(rekeyed.status).toBe('rekeyed')
    expect(await readFile(keyPath, 'utf8')).not.toBe(oldKey)
    const read = await store.readSecretValues(['a', 'b'])
    expect(read).toEqual({ status: 'read', values: { a: 'value-a', b: 'value-b' } })
  })

  test('rekey of an empty vault (no vault.enc yet) still rotates the key', async () => {
    const store = await initialized()
    const keyPath = join(journalDir, VAULT_KEY_FILE_NAME)
    const oldKey = await readFile(keyPath, 'utf8')

    const rekeyed = await store.rekey()

    expect(rekeyed.status).toBe('rekeyed')
    expect(await readFile(keyPath, 'utf8')).not.toBe(oldKey)
    expect(await store.listSecrets()).toEqual({ status: 'listed', secrets: [] })
  })
})

describe('cross-process lock', () => {
  const lockPath = (): string => join(journalDir, `${VAULT_ENC_FILE_NAME}.lock`)

  test('a stale lock (crashed holder) is stolen and the operation completes', async () => {
    const store = await initialized()
    // A lockfile whose own record says it was created long ago.
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: 999999, createdAtMs: Date.now() - 60_000 }),
      'utf8',
    )

    const set = await store.setSecret('a', 'v')

    expect(set.status).toBe('set')
  })

  test('a foreign lockfile with unparseable content falls back to mtime staleness', async () => {
    const store = await initialized()
    await writeFile(lockPath(), 'not json at all', 'utf8')
    const past = new Date(Date.now() - 60_000)
    await utimes(lockPath(), past, past)

    const set = await store.setSecret('a', 'v')

    expect(set.status).toBe('set')
  })
})

describe('corrupt stores are loud, never silently empty', () => {
  test('a vault.key that is not 32 bytes of base64 → corrupt', async () => {
    const store = makeStore()
    await store.init()
    await writeFile(join(journalDir, VAULT_KEY_FILE_NAME), 'not-a-key\n', 'utf8')

    const listed = await store.listSecrets()

    expect(listed.status).toBe('corrupt')
  })

  test('a vault.enc that is not JSON → corrupt with a message', async () => {
    const store = await initialized()
    await store.setSecret('a', 'v')
    await writeFile(join(journalDir, VAULT_ENC_FILE_NAME), '{ nope', 'utf8')

    const listed = await store.listSecrets()

    expect(listed.status).toBe('corrupt')
    if (listed.status !== 'corrupt') return
    expect(listed.message.length).toBeGreaterThan(0)
  })
})
