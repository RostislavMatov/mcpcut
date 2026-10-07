import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { describeDbUrl, parseDbUrl, readDbUrl } from '../../../src/files/db/db-url.js'
import { FILES_PG_URL_SECRET } from '../../../src/files/db/constants.js'
import { createVaultStore } from '../../../src/vault/store.js'

const TRICKY_PASSWORD = 'p%40ss:w@rd%3A'
const TRICKY_URL = `postgres://mcpcut:${TRICKY_PASSWORD}@db.example.com:6543/files?sslmode=require&password=${TRICKY_PASSWORD}`

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-db-url-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('readDbUrl', () => {
  test('vault not initialized is a vault-error with the vault init step', async () => {
    const result = await readDbUrl({ journalDir, cli: 'mcpcut' })
    expect(result).toEqual({ status: 'vault-error', reason: 'not-initialized', message: expect.stringContaining('`mcpcut vault init`') })
  })

  test('no secret means off', async () => {
    await createVaultStore({ journalDir }).init()
    expect(await readDbUrl({ journalDir })).toEqual({ status: 'off' })
  })

  test('the secret turns it on', async () => {
    const store = createVaultStore({ journalDir })
    await store.init()
    await store.setSecret(FILES_PG_URL_SECRET, TRICKY_URL)
    expect(await readDbUrl({ journalDir })).toEqual({ status: 'on', url: TRICKY_URL })
  })

  test('a corrupt vault is a vault-error', async () => {
    const store = createVaultStore({ journalDir })
    await store.init()
    await store.setSecret('x', 'y')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(journalDir, 'vault.enc'), 'garbage')
    const result = await readDbUrl({ journalDir })
    expect(result.status).toBe('vault-error')
  })
})

describe('parseDbUrl', () => {
  test.each(['postgres://u:p@h:5432/d', 'postgresql://u@h/d'])('accepts %s', (url) => {
    expect(parseDbUrl(url).ok).toBe(true)
  })

  test.each(['http://h/d', 'mysql://u:p@h/d', 'not a url', 'postgres:///d', ''])('rejects %s with the replace step', (url) => {
    const parsed = parseDbUrl(url, 'mcpcut')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.message).toContain('the vault secret files-pg-url is not a postgres:// URL')
      expect(parsed.message).toContain("| mcpcut vault set files-pg-url")
    }
  })
})

describe('describeDbUrl', () => {
  test('keeps user, host, port and database only', () => {
    expect(describeDbUrl(TRICKY_URL)).toBe('postgres://mcpcut@db.example.com:6543/files')
  })

  test('never contains the password or the query', () => {
    const text = describeDbUrl(TRICKY_URL)
    for (const leak of [TRICKY_PASSWORD, 'w@rd', 'sslmode', 'p%40ss', 'p@ss']) expect(text).not.toContain(leak)
  })

  test('defaults the port and survives a missing user', () => {
    expect(describeDbUrl('postgres://h/d')).toBe('postgres://h:5432/d')
  })

  test('an unparsable value is described without echoing it', () => {
    expect(describeDbUrl('secret-garbage')).toBe('(not a postgres:// URL)')
  })
})
