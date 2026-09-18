import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runVault, type VaultCmdDeps } from '../../src/cli/vault-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { VAULT_KEY_FILE_NAME } from '../../src/vault/constants.js'
import { createVaultStore } from '../../src/vault/store.js'
import { readJournalChainRows, readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decision S2 (2026-09-03, security audit U2): every vault MUTATION —
 * `vault set|remove|rekey` — needs a personal admin token of role `owner` in
 * `MCP_ADMIN_TOKEN`, exactly like `agent *` and `group *`, and each one leaves
 * both an stderr audit line and an `access-edit` journal record naming the
 * SECRET (never its value) and the admin. `vault init` (bootstrap, before any
 * admin exists) and `vault list` stay token-free.
 *
 * The rationale: replacing a secret replaces the identity a server uses
 * against an external system. A journal that shows the agent's call but not
 * who swapped the token an hour earlier has a hole in attribution.
 *
 * Every case sets `env` explicitly, so a real `MCP_ADMIN_TOKEN` in the
 * developer's shell can never leak into a test.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-vault-token-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Distinctive markers: the seeded value and the one a refused/allowed `set` would write. */
const SEED_VALUE = 'sk-live-VAULTSEEDMARKER-11'
const NEW_VALUE = 'sk-live-VAULTNEWMARKER-77'
const SECRET = 'github-pat'

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

/** A stdin reader that counts its calls: the gate must refuse BEFORE the value is read. */
function countingReader(value: string): { reader: () => Promise<string>; reads: () => number } {
  let count = 0
  return {
    reader: () => {
      count += 1
      return Promise.resolve(value)
    },
    reads: () => count,
  }
}

/** Deps with NO token: the reading subcommands and every refusal case. */
function anonDeps(stdin = NEW_VALUE): VaultCmdDeps {
  return { journalDir, env: {}, readSecretInput: () => Promise.resolve(stdin) }
}

/** Mints an admin through the production store and returns deps carrying its token. */
async function depsForAdmin(name: string, role: AdminRole, stdin = NEW_VALUE): Promise<VaultCmdDeps> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { ...anonDeps(stdin), env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

async function ownerDeps(stdin = NEW_VALUE): Promise<VaultCmdDeps> {
  return depsForAdmin('alice', 'owner', stdin)
}

function vault(): ReturnType<typeof createVaultStore> {
  return createVaultStore({ journalDir })
}

/** An initialized vault already holding one secret — the state every mutation would change. */
async function seedVault(): Promise<void> {
  await vault().init()
  await vault().setSecret(SECRET, SEED_VALUE)
}

/** The stored value of `name`, or `undefined` once removed. Read in memory through the store, never printed. */
async function storedValue(name: string): Promise<string | undefined> {
  const result = await vault().readSecretValues([name])
  if (result.status !== 'read') throw new Error(`vault unreadable: ${result.status}`)
  return result.values[name]
}

async function keyBytes(): Promise<string> {
  return readFile(join(journalDir, VAULT_KEY_FILE_NAME), 'utf8')
}

/** Every `access-edit` payload written under the reserved session, oldest first. */
async function accessRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

/** The three mutations, each against the seeded vault. */
const MUTATIONS = [
  { name: 'set', argv: ['set', SECRET] },
  { name: 'remove', argv: ['remove', SECRET] },
  { name: 'rekey', argv: ['rekey'] },
] as const

/** The seeded state, verbatim: value unchanged, key file unchanged, nothing journalled. */
async function expectVaultUntouched(keyBefore: string): Promise<void> {
  expect(await storedValue(SECRET)).toBe(SEED_VALUE)
  expect(await keyBytes()).toBe(keyBefore)
  expect(await accessRecords()).toHaveLength(0)
}

describe('vault mutations require an owner token (S2)', () => {
  for (const mutation of MUTATIONS) {
    test(`${mutation.name} without a token → exit 1, vault untouched, nothing journalled`, async () => {
      // Arrange
      await seedVault()
      const keyBefore = await keyBytes()
      const io = fakeIo()

      // Act
      const code = await runVault([...mutation.argv], io, anonDeps())

      // Assert
      expect(code).toBe(1)
      expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
      expect(io.err()).toContain('owner')
      expect(io.err()).not.toContain('[audit]')
      await expectVaultUntouched(keyBefore)
    })

    test(`${mutation.name} with an unknown token → exit 1 and nothing changes`, async () => {
      await seedVault()
      const keyBefore = await keyBytes()
      const io = fakeIo()

      const code = await runVault([...mutation.argv], io, {
        ...anonDeps(),
        env: { [ADMIN_TOKEN_ENV_VAR]: 'mcpj_not-a-real-token' },
      })

      expect(code).toBe(1)
      expect(io.err()).toContain('does not match any active admin')
      await expectVaultUntouched(keyBefore)
    })

    for (const role of ['viewer', 'operator'] as const) {
      test(`${mutation.name} as ${role} → exit 1, the refusal names the owner role`, async () => {
        await seedVault()
        const keyBefore = await keyBytes()
        const deps = await depsForAdmin(`${role}-admin`, role)
        const io = fakeIo()

        const code = await runVault([...mutation.argv], io, deps)

        expect(code).toBe(1)
        expect(io.err()).toContain('"owner" is required')
        await expectVaultUntouched(keyBefore)
      })
    }
  }

  test('set refuses BEFORE reading the value from stdin', async () => {
    // Arrange — a refused `set` must not even consume the secret: the value
    // has no business being in this process when nothing will be written.
    await seedVault()
    const stdin = countingReader(NEW_VALUE)
    const io = fakeIo()

    // Act
    const code = await runVault(['set', SECRET], io, { ...anonDeps(), readSecretInput: stdin.reader })

    // Assert
    expect(code).toBe(1)
    expect(stdin.reads()).toBe(0)
    expect(await storedValue(SECRET)).toBe(SEED_VALUE)
  })

  test('vault init needs no token at all (bootstrap runs before any admin exists)', async () => {
    const io = fakeIo()

    const code = await runVault(['init'], io, anonDeps())

    expect(code).toBe(0)
    expect(io.out()).toContain(VAULT_KEY_FILE_NAME)
    expect(await accessRecords()).toHaveLength(0)
  })

  test('vault list needs no token at all', async () => {
    await seedVault()
    const io = fakeIo()

    const code = await runVault(['list'], io, anonDeps())

    expect(code).toBe(0)
    expect(io.out()).toContain(SECRET)
    expect(io.out()).not.toContain(SEED_VALUE)
  })
})

describe('vault mutations are attributed and journalled (S2)', () => {
  test('set: audit line names the secret, one vault.set record, and the VALUE is in neither', async () => {
    // Arrange
    await seedVault()
    const deps = await ownerDeps(NEW_VALUE)
    const io = fakeIo()

    // Act
    const code = await runVault(['set', SECRET], io, deps)

    // Assert — the value went into the vault and nowhere else: not stdout,
    // not the audit line, not the record, not the raw bytes of journal.db.
    expect(code).toBe(0)
    expect(await storedValue(SECRET)).toBe(NEW_VALUE)
    expect(io.err()).toContain(`[audit] vault set by alice (owner): ${SECRET}`)
    expect(io.out()).not.toContain(NEW_VALUE)
    expect(io.err()).not.toContain(NEW_VALUE)
    const records = await accessRecords()
    expect(records).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'vault.set',
        vaultEntry: SECRET,
      },
    ])
    const rows = await readJournalChainRows(journalDir)
    expect(rows).toHaveLength(1)
    for (const row of rows) {
      expect(row.doc).not.toContain(NEW_VALUE)
      expect(row.doc).not.toContain(SEED_VALUE)
    }
  })

  test('remove: audit line and a vault.remove record naming the secret', async () => {
    await seedVault()
    const deps = await ownerDeps()
    const io = fakeIo()

    const code = await runVault(['remove', SECRET], io, deps)

    expect(code).toBe(0)
    expect(await storedValue(SECRET)).toBeUndefined()
    expect(io.err()).toContain(`[audit] vault remove by alice (owner): ${SECRET}`)
    expect(await accessRecords()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'vault.remove',
        vaultEntry: SECRET,
      },
    ])
    expect((await readJournalChainRows(journalDir)).every((row) => !row.doc.includes(SEED_VALUE))).toBe(true)
  })

  test('rekey: audit line and a vault.rekey record with NO vaultEntry field', async () => {
    // Arrange — rekey touches every secret and names none: the record says the
    // master key rotated, and the values survive under the new key.
    await seedVault()
    const keyBefore = await keyBytes()
    const deps = await ownerDeps()
    const io = fakeIo()

    // Act
    const code = await runVault(['rekey'], io, deps)

    // Assert
    expect(code).toBe(0)
    expect(await keyBytes()).not.toBe(keyBefore)
    expect(await storedValue(SECRET)).toBe(SEED_VALUE)
    expect(io.err()).toContain(`[audit] vault rekey by alice (owner): ${VAULT_KEY_FILE_NAME}`)
    const records = await accessRecords()
    expect(records).toEqual([
      { actor: { adminName: 'alice', role: 'owner', via: 'cli' }, action: 'vault.rekey' },
    ])
    expect(Object.hasOwn(records[0] as object, 'vaultEntry')).toBe(false)
  })

  test('a failed change writes NO record: remove of an absent secret', async () => {
    await vault().init()
    const deps = await ownerDeps()
    const io = fakeIo()

    const code = await runVault(['remove', 'missing'], io, deps)

    expect(code).toBe(1)
    expect(io.err()).not.toContain('[audit]')
    expect(await accessRecords()).toHaveLength(0)
  })

  test('a failed change writes NO record: an invalid secret name', async () => {
    await vault().init()
    const deps = await ownerDeps()
    const io = fakeIo()

    const code = await runVault(['set', 'Bad_Name'], io, deps)

    expect(code).toBe(1)
    expect(io.err()).not.toContain('[audit]')
    expect(await accessRecords()).toHaveLength(0)
  })

  test('a failed change writes NO record: an uninitialized vault', async () => {
    const deps = await ownerDeps()
    const io = fakeIo()

    const code = await runVault(['set', SECRET], io, deps)

    expect(code).toBe(1)
    expect(io.err()).toContain('vault init')
    expect(io.err()).not.toContain('[audit]')
    expect(await accessRecords()).toHaveLength(0)
  })

  test('a dropped journal record is said out loud but keeps exit 0', async () => {
    // Arrange — the secret is already in the vault when the journal is asked;
    // a sink that cannot commit must not fake a failed command.
    await seedVault()
    const deps = await ownerDeps(NEW_VALUE)
    const io = fakeIo()

    const code = await runVault(['set', SECRET], io, {
      ...deps,
      deps: {
        sink: {
          retryDelayMs: 0,
          commitBatchImpl: () => {
            throw new Error('journal is down')
          },
        },
      },
    })

    expect(code).toBe(0)
    expect(await storedValue(SECRET)).toBe(NEW_VALUE)
    expect(io.err()).toContain('[journal]')
    expect(io.err()).not.toContain(NEW_VALUE)
  })
})
