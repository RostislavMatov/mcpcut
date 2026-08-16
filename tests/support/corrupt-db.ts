import { readFile, writeFile } from 'node:fs/promises'
import { openSqlite } from '../../src/store/sqlite.js'

/**
 * Builds a database file whose bytes are damaged the way the startup
 * preflight exists to catch: enough rows that page 2 carries data, then that
 * page overwritten while page 1 (header + schema) stays valid. The file
 * therefore still OPENS — only `PRAGMA integrity_check` reports the damage.
 *
 * Mirrors `overwriteAtPageBoundary` in `tests/store/sqlite.test.ts`; shared
 * here because four command suites need the same fixture.
 */

/**
 * The other damage shape: a file whose header never became a database at all
 * (a crash or a full disk between `open()` and SQLite's first write leaves
 * exactly this). It does NOT open — the PRAGMA set in `openSqlite` fails with
 * SQLITE_NOTADB — so it exercises the preflight's open-time classification
 * rather than `PRAGMA integrity_check`.
 */
export async function writeUnopenableDatabase(dbPath: string): Promise<void> {
  await writeFile(dbPath, Buffer.from('SQLi'))
}

/** Enough 200-byte rows to push the table b-tree well past the second page. */
const FILLER_ROW_COUNT = 400

export async function writeCorruptDatabase(dbPath: string): Promise<void> {
  const handle = await openSqlite(dbPath, { synchronous: 'normal' })
  handle.db.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  handle.transaction((db) => {
    const insert = db.prepare('INSERT INTO filler (name) VALUES (?)')
    for (let index = 0; index < FILLER_ROW_COUNT; index += 1) {
      insert.run(`row-${index}-${'x'.repeat(200)}`)
    }
  })
  const pageSizeRow = handle.db.prepare('PRAGMA page_size').get() as Record<string, unknown>
  const pageSize = Number(Object.values(pageSizeRow)[0])
  // Closing checkpoints the WAL into the main file, so the bytes overwritten
  // below are the pages a later reader actually sees.
  handle.close()

  const original = await readFile(dbPath)
  await writeFile(
    dbPath,
    Buffer.concat([
      original.subarray(0, pageSize),
      Buffer.alloc(pageSize, 0xff),
      original.subarray(pageSize * 2),
    ]),
  )
}
