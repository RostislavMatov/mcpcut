import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ensurePostgresEnv } from '../../../src/files/db/postgres-env.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-pg-env-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ensurePostgresEnv', () => {
  test('creates the file once and reuses its password afterwards', async () => {
    const first = await ensurePostgresEnv(join(dir, 'modules'))
    const second = await ensurePostgresEnv(join(dir, 'modules'))
    expect(first).toMatchObject({ ok: true, created: true })
    expect(second).toMatchObject({ ok: true, created: false })
    expect(second.ok && first.ok && second.password).toBe(first.ok && first.password)
  })

  test('two simultaneous first runs agree on one password', async () => {
    const [a, b] = await Promise.all([ensurePostgresEnv(join(dir, 'm')), ensurePostgresEnv(join(dir, 'm'))])
    expect(a.ok && b.ok && a.password === b.password).toBe(true)
    const text = await readFile(join(dir, 'm', 'postgres.env'), 'utf8')
    expect(text.match(/POSTGRES_PASSWORD=/g)).toHaveLength(1)
  })

  test.each(['', 'POSTGRES_PASSWORD=short\n', 'POSTGRES_PASSWORD=has spaces and !! symbols\n'])('malformed content %j is refused', async (content) => {
    await writeFile(join(dir, 'postgres.env'), content)
    expect(await ensurePostgresEnv(dir)).toEqual({ ok: false, path: join(dir, 'postgres.env') })
  })
})
