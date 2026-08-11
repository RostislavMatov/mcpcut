import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import {
  AdminExistsError,
  AdminNotFoundError,
  createAdminStore,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
  type AdminStore,
} from '../../src/admin/store.js'
import { StoreCorruptError } from '../../src/policy/store.js'

let journalDir: string
let store: AdminStore

const FIXED_NOW = new Date('2026-08-11T12:00:00.000Z')
const LATER = new Date('2026-08-11T13:00:00.000Z')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-admin-store-'))
  store = createAdminStore({ journalDir, clock: () => FIXED_NOW })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('createAdmin', () => {
  test('returns a one-time token; record persists only the hash and role', async () => {
    const { admin, token } = await store.createAdmin('alice', 'owner')

    expect(admin.name).toBe('alice')
    expect(admin.role).toBe('owner')
    expect(admin.createdAt).toBe(FIXED_NOW.toISOString())
    expect(admin.revokedAt).toBeUndefined()
    expect(admin.rotatedAt).toBeUndefined()
    expect(token.startsWith('mcpa_')).toBe(true)
    expect(admin.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(admin.tokenHash).not.toContain(token)
  })

  test('admin token prefix differs from the agent prefix', async () => {
    const { token } = await store.createAdmin('alice', 'owner')
    expect(token.startsWith('mcpj_')).toBe(false)
    expect(token.startsWith('mcpa_')).toBe(true)
  })

  test('persists to <journalDir>/admins.json with 0600 permissions', async () => {
    await store.createAdmin('alice', 'owner')
    const fileStat = await stat(join(journalDir, ADMINS_FILE_NAME))
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('rejects a duplicate live name', async () => {
    await store.createAdmin('alice', 'owner')
    await expect(store.createAdmin('alice', 'viewer')).rejects.toBeInstanceOf(AdminExistsError)
  })

  test('rejects an invalid name and an invalid role', async () => {
    await expect(store.createAdmin('Alice', 'owner')).rejects.toBeInstanceOf(InvalidAdminNameError)
    await expect(
      store.createAdmin('bob', 'root' as unknown as 'owner'),
    ).rejects.toBeInstanceOf(InvalidAdminRoleError)
  })
})

describe('findAdminByToken', () => {
  test('resolves a valid token to its active admin', async () => {
    const { token } = await store.createAdmin('alice', 'operator')
    const admin = await store.findAdminByToken(token)
    expect(admin?.name).toBe('alice')
    expect(admin?.role).toBe('operator')
  })

  test('a wrong token and a non-existent token both resolve to undefined', async () => {
    await store.createAdmin('alice', 'owner')
    expect(await store.findAdminByToken('mcpa_nope')).toBeUndefined()
    expect(await store.findAdminByToken('')).toBeUndefined()
  })

  test('a revoked admin resolves to undefined (indistinguishable from unknown)', async () => {
    const later = createAdminStore({ journalDir, clock: () => LATER })
    const { token } = await store.createAdmin('alice', 'owner')
    await store.createAdmin('backup', 'owner')
    await later.removeAdmin('alice')
    expect(await store.findAdminByToken(token)).toBeUndefined()
  })
})

describe('rotateAdmin', () => {
  test('mints a fresh token, sets rotatedAt, and invalidates the old token', async () => {
    const later = createAdminStore({ journalDir, clock: () => LATER })
    const { token: oldToken } = await store.createAdmin('alice', 'owner')

    const { admin, token: newToken } = await later.rotateAdmin('alice')

    expect(newToken).not.toBe(oldToken)
    expect(admin.rotatedAt).toBe(LATER.toISOString())
    expect(await store.findAdminByToken(oldToken)).toBeUndefined()
    expect((await store.findAdminByToken(newToken))?.name).toBe('alice')
  })

  test('rejects an unknown admin', async () => {
    await expect(store.rotateAdmin('ghost')).rejects.toBeInstanceOf(AdminNotFoundError)
  })
})

describe('setRole', () => {
  test('changes the role of an admin', async () => {
    await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'viewer')
    const updated = await store.setRole('bob', 'operator')
    expect(updated.role).toBe('operator')
  })

  test('refuses to demote the last active owner', async () => {
    await store.createAdmin('alice', 'owner')
    await expect(store.setRole('alice', 'viewer')).rejects.toBeInstanceOf(LastOwnerError)
  })

  test('allows demoting an owner when another active owner remains', async () => {
    await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'owner')
    const updated = await store.setRole('alice', 'viewer')
    expect(updated.role).toBe('viewer')
  })
})

describe('removeAdmin', () => {
  test('soft-removes an admin and hides it from every lookup', async () => {
    const later = createAdminStore({ journalDir, clock: () => LATER })
    await store.createAdmin('alice', 'owner')
    const { token } = await store.createAdmin('bob', 'operator')

    const removed = await later.removeAdmin('bob')

    expect(removed.revokedAt).toBe(LATER.toISOString())
    expect(await store.getActiveAdmin('bob')).toBeUndefined()
    expect(await store.findAdminByToken(token)).toBeUndefined()
    expect((await store.listAdmins()).map((a) => a.name)).toEqual(['alice'])
  })

  test('refuses to remove the last active owner', async () => {
    await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'viewer')
    await expect(store.removeAdmin('alice')).rejects.toBeInstanceOf(LastOwnerError)
  })

  test('rejects an unknown admin', async () => {
    await expect(store.removeAdmin('ghost')).rejects.toBeInstanceOf(AdminNotFoundError)
  })

  test('is idempotent: a second remove of an already-revoked admin keeps the ORIGINAL date', async () => {
    const later = createAdminStore({ journalDir, clock: () => LATER })
    const evenLater = createAdminStore({ journalDir, clock: () => new Date('2026-08-11T14:00:00.000Z') })
    await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'operator')

    const first = await later.removeAdmin('bob')
    const second = await evenLater.removeAdmin('bob')

    expect(first.revokedAt).toBe(LATER.toISOString())
    expect(second.revokedAt).toBe(LATER.toISOString())
    expect(await store.getActiveAdmin('bob')).toBeUndefined()
  })
})

describe('listAdmins', () => {
  test('returns active admins sorted by name', async () => {
    await store.createAdmin('carol', 'viewer')
    await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'operator')
    expect((await store.listAdmins()).map((a) => a.name)).toEqual(['alice', 'bob', 'carol'])
  })
})

describe('corruption', () => {
  test('a hand-edited invalid file fails loudly, never degrades to empty', async () => {
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{"version":1,"admins":{"x":{}}}', 'utf8')
    await expect(store.listAdmins()).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
