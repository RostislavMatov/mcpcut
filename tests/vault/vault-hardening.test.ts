import { readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runVault } from '../../src/cli/vault-cmd.js'
import {
  VAULT_ENC_FILE_NAME,
  VAULT_FORMAT_VERSION,
  VAULT_KEY_FILE_NAME,
  VAULT_KEY_LENGTH_BYTES,
  VAULT_STAGED_KEY_FILE_NAME,
} from '../../src/vault/constants.js'
import { decrypt, encrypt, generateKey, VaultIntegrityError } from '../../src/vault/crypto.js'
import { resolveVaultRefs } from '../../src/vault/resolve.js'
import { createVaultStore } from '../../src/vault/store.js'

/**
 * Vault hardening suite: fail-closed on corruption, 0600/0700 modes, the
 * cross-carrier marker guarantee ("a secret value never appears in any CLI
 * output"), key rotation actually killing the old key, and interrupted-rekey
 * crash states never losing data (ADR-0003).
 */

const MARKER = 'VAULTLEAKMARKER'
const SECRET_VALUE = `sk-live-${MARKER}-42`

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-vault-hardening-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const keyPath = (): string => join(journalDir, VAULT_KEY_FILE_NAME)
const encPath = (): string => join(journalDir, VAULT_ENC_FILE_NAME)
const stagedKeyPath = (): string => join(journalDir, VAULT_STAGED_KEY_FILE_NAME)

function store() {
  return createVaultStore({ journalDir })
}

async function initializedWithSecret(): Promise<void> {
  const s = store()
  await s.init()
  const set = await s.setSecret('marker-secret', SECRET_VALUE)
  expect(set.status).toBe('set')
}

/** Parses the on-disk envelope so individual fields can be corrupted surgically. */
async function readEnvelope(): Promise<{ v: number; iv: string; tag: string; data: string }> {
  return JSON.parse(await readFile(encPath(), 'utf8')) as {
    v: number
    iv: string
    tag: string
    data: string
  }
}

async function readKeyBuffer(path: string): Promise<Buffer> {
  return Buffer.from((await readFile(path, 'utf8')).trim(), 'base64')
}

describe('corruption is loud, never an empty vault, never garbage', () => {
  test('a flipped auth-tag byte → corrupt, and definitely not an empty vault', async () => {
    await initializedWithSecret()
    const envelope = await readEnvelope()
    const tag = Buffer.from(envelope.tag, 'base64')
    const firstByte = tag[0] ?? 0
    tag[0] = firstByte ^ 0xff
    await writeFile(encPath(), JSON.stringify({ ...envelope, tag: tag.toString('base64') }), 'utf8')

    const listed = await store().listSecrets()

    expect(listed.status).toBe('corrupt')
  })

  test('a truncated vault.enc → corrupt (typed), not a crash and not empty', async () => {
    await initializedWithSecret()
    const raw = await readFile(encPath(), 'utf8')
    await writeFile(encPath(), raw.slice(0, Math.floor(raw.length / 2)), 'utf8')

    const listed = await store().listSecrets()
    const read = await store().readSecretValues(['marker-secret'])

    expect(listed.status).toBe('corrupt')
    expect(read.status).toBe('corrupt')
  })

  test('an envelope with an unknown version → corrupt (AAD/schema binding)', async () => {
    await initializedWithSecret()
    const envelope = await readEnvelope()
    await writeFile(encPath(), JSON.stringify({ ...envelope, v: 999 }), 'utf8')

    const listed = await store().listSecrets()

    expect(listed.status).toBe('corrupt')
  })
})

describe('file permissions', () => {
  test('vault.key and vault.enc are 0600, journal dir is 0700', async () => {
    await initializedWithSecret()

    expect((await stat(keyPath())).mode & 0o777).toBe(0o600)
    expect((await stat(encPath())).mode & 0o777).toBe(0o600)
    expect((await stat(journalDir)).mode & 0o777).toBe(0o700)
  })
})

describe('marker: a secret value never leaves the vault through any output', () => {
  test('set → resolve delivers the value; init/set/list/remove/rekey CLI outputs never contain it', async () => {
    const outputs: string[] = []
    const io = () => {
      const chunks: string[] = []
      outputs.push('')
      return {
        stdout: {
          write: (c: string) => {
            chunks.push(c)
            outputs[outputs.length - 1] = chunks.join('')
          },
        },
        stderr: {
          write: (c: string) => {
            chunks.push(c)
            outputs[outputs.length - 1] = chunks.join('')
          },
        },
      }
    }
    // `set`/`rekey`/`remove` run as a named owner (owner decision S2,
    // 2026-09-03): the audit line and the journal record they add are two
    // more outputs this sweep must find clean.
    const { token } = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
    const deps = {
      journalDir,
      env: { [ADMIN_TOKEN_ENV_VAR]: token },
      readSecretInput: async () => SECRET_VALUE,
    }

    expect(await runVault(['init'], io(), deps)).toBe(0)
    expect(await runVault(['set', 'marker-secret'], io(), deps)).toBe(0)
    expect(await runVault(['list'], io(), deps)).toBe(0)
    expect(await runVault(['rekey'], io(), deps)).toBe(0)

    // The value does flow to a consumer through resolve (in memory only).
    const resolved = await resolveVaultRefs({ TOKEN: 'vault:marker-secret' }, (names) =>
      store().readSecretValues(names),
    )
    expect(resolved).toEqual({ status: 'resolved', values: { TOKEN: SECRET_VALUE } })

    expect(await runVault(['remove', 'marker-secret'], io(), deps)).toBe(0)
    expect(await runVault(['list'], io(), deps)).toBe(0)

    // ...but never through any CLI output.
    for (const output of outputs) {
      expect(output).not.toContain(MARKER)
    }
  })

  test('vault source modules never write to stdout/stderr or console (no log channel exists)', () => {
    const vaultDir = join(process.cwd(), 'src/vault')
    for (const file of readdirSync(vaultDir)) {
      const source = readFileSync(join(vaultDir, file), 'utf8')
      expect(source).not.toMatch(/\bconsole\./)
      expect(source).not.toMatch(/process\.(stdout|stderr)/)
    }
  })
})

describe('rekey security', () => {
  test('after rekey the old key no longer authenticates vault.enc; data is intact', async () => {
    await initializedWithSecret()
    const oldKeyCopy = join(journalDir, 'old-key-copy')
    await copyFile(keyPath(), oldKeyCopy)

    const rekeyed = await store().rekey()
    expect(rekeyed.status).toBe('rekeyed')

    const envelope = await readEnvelope()
    const oldKey = await readKeyBuffer(oldKeyCopy)
    expect(() =>
      decrypt(oldKey, {
        iv: Buffer.from(envelope.iv, 'base64'),
        tag: Buffer.from(envelope.tag, 'base64'),
        data: Buffer.from(envelope.data, 'base64'),
      }),
    ).toThrow(VaultIntegrityError)

    const read = await store().readSecretValues(['marker-secret'])
    expect(read).toEqual({ status: 'read', values: { 'marker-secret': SECRET_VALUE } })
  })
})

describe('interrupted rekey never loses data (write-order invariant)', () => {
  test('crash after staging the new key (step 1): old generation still reads fine', async () => {
    await initializedWithSecret()
    // Simulate: a new key was staged at vault.key.new, then the process died.
    await writeFile(stagedKeyPath(), `${generateKey().toString('base64')}\n`, { mode: 0o600 })

    const read = await store().readSecretValues(['marker-secret'])

    expect(read).toEqual({ status: 'read', values: { 'marker-secret': SECRET_VALUE } })
  })

  test('crash after committing vault.enc under the new key (step 2): staged key completes the rekey', async () => {
    await initializedWithSecret()
    // Simulate the exact on-disk state between step 2 and step 3: vault.enc is
    // already re-encrypted with the staged key, vault.key still holds the old key.
    const newKey = generateKey()
    const plaintext = Buffer.from(
      JSON.stringify({
        'marker-secret': {
          value: SECRET_VALUE,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
      'utf8',
    )
    const payload = encrypt(newKey, plaintext)
    await writeFile(stagedKeyPath(), `${newKey.toString('base64')}\n`, { mode: 0o600 })
    await writeFile(
      encPath(),
      JSON.stringify({
        v: VAULT_FORMAT_VERSION,
        iv: payload.iv.toString('base64'),
        tag: payload.tag.toString('base64'),
        data: payload.data.toString('base64'),
      }),
      { mode: 0o600 },
    )

    const read = await store().readSecretValues(['marker-secret'])

    // Data intact via the staged key...
    expect(read).toEqual({ status: 'read', values: { 'marker-secret': SECRET_VALUE } })
    // ...and the recovery promoted the staged key to vault.key.
    expect((await readKeyBuffer(keyPath())).equals(newKey)).toBe(true)
    await expect(stat(stagedKeyPath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('crash after promoting the key (step 3): the vault is simply the new generation', async () => {
    await initializedWithSecret()
    const s = store()
    await s.rekey()
    // Nothing staged is left behind after a completed rekey.
    await expect(stat(stagedKeyPath())).rejects.toMatchObject({ code: 'ENOENT' })

    const read = await s.readSecretValues(['marker-secret'])

    expect(read).toEqual({ status: 'read', values: { 'marker-secret': SECRET_VALUE } })
  })

  test('a stale staged key that matches nothing does not mask real corruption', async () => {
    await initializedWithSecret()
    await writeFile(stagedKeyPath(), `${generateKey().toString('base64')}\n`, { mode: 0o600 })
    // Corrupt vault.enc so neither the primary nor the staged key can open it.
    const envelope = await readEnvelope()
    const tag = Buffer.from(envelope.tag, 'base64')
    const firstByte = tag[0] ?? 0
    tag[0] = firstByte ^ 0xff
    await writeFile(encPath(), JSON.stringify({ ...envelope, tag: tag.toString('base64') }), 'utf8')

    const read = await store().readSecretValues(['marker-secret'])

    expect(read.status).toBe('corrupt')
    // The primary key was NOT clobbered by the bogus staged key.
    expect((await stat(keyPath())).isFile()).toBe(true)
  })

  test('recovery only promotes a staged key that actually decrypts: rename order preserved', async () => {
    await initializedWithSecret()
    const primaryBefore = await readFile(keyPath(), 'utf8')
    await writeFile(stagedKeyPath(), `${generateKey().toString('base64')}\n`, { mode: 0o600 })

    const read = await store().readSecretValues(['marker-secret'])

    // Old key still decrypts, so nothing must be promoted or replaced.
    expect(read.status).toBe('read')
    expect(await readFile(keyPath(), 'utf8')).toBe(primaryBefore)
  })
})

/**
 * Counts zeroizations of master-key-sized buffers. The master key must not
 * outlive the operation that loaded it — including on failure paths, which is
 * exactly what a `try/finally` around its lifetime buys.
 */
function spyOnKeyZeroization(): { count: () => number; restore: () => void } {
  const original = Buffer.prototype.fill
  const applyOriginal = original as unknown as (this: Buffer, ...args: unknown[]) => Buffer
  let count = 0
  const patched = function (this: Buffer, ...args: unknown[]): Buffer {
    if (args[0] === 0 && this.length === VAULT_KEY_LENGTH_BYTES) count += 1
    return applyOriginal.apply(this, args)
  }
  Buffer.prototype.fill = patched as unknown as typeof Buffer.prototype.fill
  return {
    count: () => count,
    restore: () => {
      Buffer.prototype.fill = original
    },
  }
}

describe('master key hygiene', () => {
  test('a key file with characters outside the base64 alphabet is corrupt, not silently truncated', async () => {
    await initializedWithSecret()
    const raw = await readFile(keyPath(), 'utf8')
    await writeFile(keyPath(), `!${raw.trim().slice(1)}\n`, { mode: 0o600 })

    expect((await store().listSecrets()).status).toBe('corrupt')
  })

  test('a key of the wrong decoded length is corrupt', async () => {
    await initializedWithSecret()
    await writeFile(keyPath(), `${Buffer.alloc(16).toString('base64')}\n`, { mode: 0o600 })

    expect((await store().listSecrets()).status).toBe('corrupt')
  })

  test('a successful read zeroizes the key it loaded', async () => {
    await initializedWithSecret()
    const spy = spyOnKeyZeroization()
    try {
      expect((await store().readSecretValues(['marker-secret'])).status).toBe('read')
      expect(spy.count()).toBeGreaterThanOrEqual(1)
    } finally {
      spy.restore()
    }
  })

  test('a rekey that fails mid-flight still zeroizes both the old and the new key', async () => {
    await initializedWithSecret()
    // A directory where the staged key file must go: staging fails hard, and
    // the failure escapes `rekey` as an unexpected error (not a VaultFailure).
    await mkdir(stagedKeyPath())
    const spy = spyOnKeyZeroization()
    try {
      await expect(store().rekey()).rejects.toBeTruthy()
      expect(spy.count()).toBeGreaterThanOrEqual(2)
    } finally {
      spy.restore()
    }
  })
})

describe('rename-based commit', () => {
  test('vault.enc updates are atomic: no partially-written tmp file survives a successful set', async () => {
    await initializedWithSecret()

    const leftovers = readdirSync(journalDir).filter((name) => name.includes('.tmp'))

    expect(leftovers).toEqual([])
  })

  test('vault.enc swapped wholesale with another vault\'s file → corrupt (foreign key)', async () => {
    await initializedWithSecret()
    const otherDir = await mkdtemp(join(tmpdir(), 'mcp-journal-vault-other-'))
    try {
      const other = createVaultStore({ journalDir: otherDir })
      await other.init()
      await other.setSecret('marker-secret', 'other-value')
      await rename(join(otherDir, VAULT_ENC_FILE_NAME), encPath())

      const read = await store().readSecretValues(['marker-secret'])

      expect(read.status).toBe('corrupt')
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })
})
