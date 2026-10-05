import { randomBytes } from 'node:crypto'
import { describe } from 'vitest'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import type { PgPool } from '../../../src/files/db/pg-types.js'

/** Helpers for tests that need a real Postgres (`MCPCUT_TEST_PG_URL`); without it they skip. */

export const PG_URL: string = process.env['MCPCUT_TEST_PG_URL'] ?? ''

export const describePg = describe.skipIf(PG_URL === '')

export interface TestSchema {
  readonly schema: string
  readonly cleanup: () => Promise<void>
}

/** A random schema name and a cleanup that drops it `CASCADE`. The schema is created by the code under test. */
export function withTestSchema(): TestSchema {
  const schema = `t_${randomBytes(6).toString('hex')}`
  return {
    schema,
    cleanup: async () => {
      const { Pool } = await loadPg(process.cwd())
      const pool: PgPool = new Pool({ connectionString: PG_URL, max: 1 })
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      } finally {
        await pool.end()
      }
    },
  }
}

/** The test URL with another password, for the wrong-password test. */
export function urlWithPassword(password: string): string {
  const url = new URL(PG_URL)
  url.password = password
  return url.toString()
}
