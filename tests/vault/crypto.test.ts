import { describe, expect, test } from 'vitest'
import {
  VAULT_FORMAT_VERSION,
  VAULT_IV_LENGTH_BYTES,
  VAULT_KEY_LENGTH_BYTES,
} from '../../src/vault/constants.js'
import {
  decrypt,
  encrypt,
  generateKey,
  VaultIntegrityError,
  VaultKeyError,
} from '../../src/vault/crypto.js'

describe('generateKey', () => {
  test('returns a 32-byte key', () => {
    expect(generateKey().length).toBe(VAULT_KEY_LENGTH_BYTES)
  })

  test('two generated keys differ', () => {
    expect(generateKey().equals(generateKey())).toBe(false)
  })
})

describe('encrypt/decrypt roundtrip', () => {
  test('decrypt returns the exact plaintext bytes', () => {
    const key = generateKey()
    const plaintext = Buffer.from('{"github-pat":{"value":"s3cret"}}', 'utf8')

    const payload = encrypt(key, plaintext)
    const decrypted = decrypt(key, payload)

    expect(decrypted.equals(plaintext)).toBe(true)
  })

  test('empty plaintext roundtrips', () => {
    const key = generateKey()

    const payload = encrypt(key, Buffer.alloc(0))

    expect(decrypt(key, payload).length).toBe(0)
  })

  test('iv is 12 bytes and fresh on every encryption of the same plaintext', () => {
    const key = generateKey()
    const plaintext = Buffer.from('same bytes', 'utf8')

    const first = encrypt(key, plaintext)
    const second = encrypt(key, plaintext)

    expect(first.iv.length).toBe(VAULT_IV_LENGTH_BYTES)
    expect(first.iv.equals(second.iv)).toBe(false)
    expect(first.data.equals(second.data)).toBe(false)
  })
})

describe('authentication failures', () => {
  test('flipped tag byte → VaultIntegrityError with a cause, never garbage output', () => {
    const key = generateKey()
    const payload = encrypt(key, Buffer.from('secret', 'utf8'))
    const badTag = Buffer.from(payload.tag)
    const firstByte = badTag[0] ?? 0
    badTag[0] = firstByte ^ 0xff

    const act = (): Buffer => decrypt(key, { ...payload, tag: badTag })

    expect(act).toThrow(VaultIntegrityError)
    try {
      act()
    } catch (error: unknown) {
      expect((error as VaultIntegrityError).cause).toBeDefined()
    }
  })

  test('flipped ciphertext byte → VaultIntegrityError', () => {
    const key = generateKey()
    const payload = encrypt(key, Buffer.from('secret', 'utf8'))
    const badData = Buffer.from(payload.data)
    const firstByte = badData[0] ?? 0
    badData[0] = firstByte ^ 0xff

    expect(() => decrypt(key, { ...payload, data: badData })).toThrow(VaultIntegrityError)
  })

  test('wrong key → VaultIntegrityError', () => {
    const payload = encrypt(generateKey(), Buffer.from('secret', 'utf8'))

    expect(() => decrypt(generateKey(), payload)).toThrow(VaultIntegrityError)
  })

  test('envelope version is bound via AAD: same bytes under another version fail', () => {
    const key = generateKey()
    const payload = encrypt(key, Buffer.from('secret', 'utf8'), VAULT_FORMAT_VERSION)

    expect(() => decrypt(key, payload, VAULT_FORMAT_VERSION + 1)).toThrow(VaultIntegrityError)
  })

  test('iv of the wrong length → VaultIntegrityError, not a crash with garbage', () => {
    const key = generateKey()
    const payload = encrypt(key, Buffer.from('secret', 'utf8'))

    expect(() => decrypt(key, { ...payload, iv: Buffer.alloc(4) })).toThrow(VaultIntegrityError)
  })
})

describe('key validation', () => {
  test('encrypt with a short key → VaultKeyError', () => {
    expect(() => encrypt(Buffer.alloc(16), Buffer.from('x'))).toThrow(VaultKeyError)
  })

  test('decrypt with a short key → VaultKeyError', () => {
    const payload = encrypt(generateKey(), Buffer.from('x'))

    expect(() => decrypt(Buffer.alloc(31), payload)).toThrow(VaultKeyError)
  })
})
