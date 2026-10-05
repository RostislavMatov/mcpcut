import type { PgQueryable } from '../db/pg-types.js'
import { CATALOG_BATCH_SIZE } from '../db/constants.js'
import type { TextChunk } from './chunk.js'
import type { CatalogFile, IndexRow } from './index-plan.js'

/** SQL of the search tables: loads, deletes and the one-file write. */

const CHUNK_INSERT_BATCH = 100

export async function loadCatalogFiles(db: PgQueryable, roots: readonly string[]): Promise<CatalogFile[]> {
  const found = await db.query<{ root: string; rel_path: string; size: string; sha256: string | null }>(
    "SELECT root, rel_path, size, sha256 FROM catalog WHERE kind = 'file' AND root = ANY($1::text[]) ORDER BY root, rel_path",
    [roots],
  )
  return found.rows.map((row) => ({ root: row.root, relPath: row.rel_path, size: Number(row.size), sha256: row.sha256 }))
}

export async function loadIndexRows(db: PgQueryable): Promise<IndexRow[]> {
  const found = await db.query<{
    root: string
    rel_path: string
    status: 'indexed' | 'skipped'
    reason: string | null
    sha256: string | null
    size: string
    model: string
  }>('SELECT root, rel_path, status, reason, sha256, size, model FROM search_files ORDER BY root, rel_path')
  return found.rows.map((row) => ({
    root: row.root,
    relPath: row.rel_path,
    status: row.status,
    reason: row.reason,
    sha256: row.sha256,
    size: Number(row.size),
    model: row.model,
  }))
}

/** Every row goes: chunks follow by cascade. Returns how many files. */
export async function deleteAllIndexRows(db: PgQueryable): Promise<number> {
  const result = await db.query('DELETE FROM search_files')
  return result.rowCount ?? 0
}

export async function deleteIndexRows(db: PgQueryable, rows: ReadonlyArray<{ readonly root: string; readonly relPath: string }>): Promise<number> {
  let removed = 0
  for (let from = 0; from < rows.length; from += CATALOG_BATCH_SIZE) {
    const batch = rows.slice(from, from + CATALOG_BATCH_SIZE)
    const result = await db.query(
      'DELETE FROM search_files WHERE (root, rel_path) IN (SELECT * FROM unnest($1::text[], $2::text[]))',
      [batch.map((row) => row.root), batch.map((row) => row.relPath)],
    )
    removed += result.rowCount ?? 0
  }
  return removed
}

export interface FileWrite {
  readonly root: string
  readonly relPath: string
  readonly pathKey: string
  readonly sha256: string | null
  readonly size: number
  readonly model: string
  readonly indexedAt: Date
}

const UPSERT_FILE =
  'INSERT INTO search_files (root, rel_path, path_key, status, reason, sha256, size, model, chunks, indexed_at) ' +
  'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz) ' +
  'ON CONFLICT (root, rel_path) DO UPDATE SET path_key = EXCLUDED.path_key, status = EXCLUDED.status, reason = EXCLUDED.reason, ' +
  'sha256 = EXCLUDED.sha256, size = EXCLUDED.size, model = EXCLUDED.model, chunks = EXCLUDED.chunks, indexed_at = EXCLUDED.indexed_at'

async function upsertFile(tx: PgQueryable, write: FileWrite, state: { status: 'indexed' | 'skipped'; reason: string | null; chunks: number }): Promise<void> {
  await tx.query(UPSERT_FILE, [
    write.root,
    write.relPath,
    write.pathKey,
    state.status,
    state.reason,
    write.sha256,
    write.size,
    write.model,
    state.chunks,
    write.indexedAt.toISOString(),
  ])
  await tx.query('DELETE FROM search_chunks WHERE root = $1 AND rel_path = $2', [write.root, write.relPath])
}

/** A skipped file: the row says why, and no chunk of it survives. Call inside a transaction. */
export async function writeSkipped(tx: PgQueryable, write: FileWrite, reason: string): Promise<void> {
  await upsertFile(tx, write, { status: 'skipped', reason, chunks: 0 })
}

export interface EmbeddedChunk extends TextChunk {
  readonly embedding: Float32Array
}

function vectorText(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`
}

/** An indexed file: the row, then its chunks replacing the old ones. Call inside a transaction. */
export async function writeIndexed(tx: PgQueryable, vectorSchema: string, write: FileWrite, chunks: readonly EmbeddedChunk[]): Promise<void> {
  await upsertFile(tx, write, { status: 'indexed', reason: null, chunks: chunks.length })
  for (let from = 0; from < chunks.length; from += CHUNK_INSERT_BATCH) {
    const batch = chunks.slice(from, from + CHUNK_INSERT_BATCH).map((chunk, offset) => ({
      chunk_no: from + offset,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      body: chunk.body,
      embedding: vectorText(chunk.embedding),
    }))
    await tx.query(
      'INSERT INTO search_chunks (root, rel_path, chunk_no, start_line, end_line, body, embedding) ' +
        `SELECT $1, $2, x.chunk_no, x.start_line, x.end_line, x.body, x.embedding::${vectorSchema}.vector ` +
        'FROM jsonb_to_recordset($3::jsonb) AS x(chunk_no int, start_line int, end_line int, body text, embedding text)',
      [write.root, write.relPath, JSON.stringify(batch)],
    )
  }
}
