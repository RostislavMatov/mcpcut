import type { PgQueryable } from './pg-types.js'
import { CATALOG_BATCH_SIZE } from './constants.js'

/** SQL of the catalog table: one place for the upsert, the load and the deletes. */

export interface CatalogRow {
  readonly rel_path: string
  readonly kind: 'file' | 'dir'
  readonly size: number
  readonly mtime_ms: number
  readonly sha256: string | null
}

export type KnownRows = ReadonlyMap<string, CatalogRow>

const UPSERT =
  'INSERT INTO catalog (root, rel_path, kind, size, mtime_ms, sha256, seen_at) ' +
  'SELECT $1, x.rel_path, x.kind, x.size, x.mtime_ms, x.sha256, $2::timestamptz ' +
  'FROM jsonb_to_recordset($3::jsonb) AS x(rel_path text, kind text, size bigint, mtime_ms bigint, sha256 text) ' +
  'ON CONFLICT (root, rel_path) DO UPDATE SET kind = EXCLUDED.kind, size = EXCLUDED.size, ' +
  'mtime_ms = EXCLUDED.mtime_ms, sha256 = EXCLUDED.sha256, seen_at = EXCLUDED.seen_at'

function chunksOf<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = []
  for (let from = 0; from < items.length; from += CATALOG_BATCH_SIZE) chunks.push(items.slice(from, from + CATALOG_BATCH_SIZE))
  return chunks
}

export function loadKnownRows(db: PgQueryable, root: string): Promise<KnownRows> {
  return loadKnownRowsWhere(db, 'root = $1', [root])
}

async function loadKnownRowsWhere(db: PgQueryable, where: string, params: readonly unknown[]): Promise<KnownRows> {
  const found = await db.query<{ rel_path: string; kind: 'file' | 'dir'; size: string; mtime_ms: string; sha256: string | null }>(
    `SELECT rel_path, kind, size, mtime_ms, sha256 FROM catalog WHERE ${where}`,
    params,
  )
  return new Map(
    found.rows.map((row) => [row.rel_path, { rel_path: row.rel_path, kind: row.kind, size: Number(row.size), mtime_ms: Number(row.mtime_ms), sha256: row.sha256 }]),
  )
}

export async function loadKnownRow(db: PgQueryable, root: string, relPath: string): Promise<CatalogRow | undefined> {
  const found = await loadKnownRowsWhere(db, 'root = $1 AND rel_path = $2', [root, relPath])
  return found.get(relPath)
}

export async function upsertRows(db: PgQueryable, root: string, now: Date, rows: readonly CatalogRow[]): Promise<void> {
  for (const chunk of chunksOf(rows)) await db.query(UPSERT, [root, now.toISOString(), JSON.stringify(chunk)])
}

export async function deleteRows(db: PgQueryable, root: string, relPaths: readonly string[]): Promise<void> {
  for (const chunk of chunksOf(relPaths)) {
    await db.query('DELETE FROM catalog WHERE root = $1 AND rel_path = ANY($2::text[])', [root, chunk])
  }
}

/** A folder's own row and everything under it. */
export async function deleteSubtree(db: PgQueryable, root: string, relPath: string): Promise<void> {
  await db.query("DELETE FROM catalog WHERE root = $1 AND (rel_path = $2 OR starts_with(rel_path, $2 || '/'))", [root, relPath])
}
