import { describe, expect, test } from 'vitest'
import type { FilesDb } from '../../../src/files/db/connection.js'
import type { PgQueryable } from '../../../src/files/db/pg-types.js'
import { FilesSearchPgvectorError, ensureSearchSchema } from '../../../src/files/search/search-schema.js'

/** A server with no pgvector: the extension is neither installed nor creatable. */
function dbWithoutPgvector(): FilesDb {
  const query = async (text: string) => {
    if (text.startsWith('CREATE EXTENSION')) throw new Error('could not open extension control file')
    return { rows: [], rowCount: 0 }
  }
  const client: PgQueryable = { query: query as PgQueryable['query'] }
  return {
    schema: 'mcpcut',
    schemaVersion: 1,
    query: query as FilesDb['query'],
    transaction: async (fn) => fn(client),
    withClient: async (fn) => fn(client),
    close: async () => undefined,
  }
}

describe('ensureSearchSchema without pgvector', () => {
  test('says how to get one, naming the init command', async () => {
    const failure = await ensureSearchSchema(dbWithoutPgvector(), { cli: 'mcpcut' }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(FilesSearchPgvectorError)
    expect((failure as Error).message).toBe(
      'this Postgres has no pgvector extension: use the container `mcpcut files db init` prints, or install pgvector and run the command again (could not open extension control file)',
    )
  })
})
