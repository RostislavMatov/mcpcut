import { StoreCorruptError, StoreWriteRejectedError, type DocumentRow } from './store-backend.js'
import { cloneKeepingPrototypes } from './store-clone.js'

/**
 * The domain validator at the store boundary, on both sides of it, plus the
 * memo that keeps it from running twice over the same bytes.
 *
 * READ side — a document that exists but does not parse or does not validate
 * is `StoreCorruptError`, never a silent fall back to the default: corrupt
 * state must be loud, not quietly treated as empty.
 *
 * WRITE side — a value the caller computed but the schema refuses (a
 * collection pushed past a `MAX_*` cap, say) is refused BEFORE the CAS. Such a
 * value would be accepted once and then fail EVERY subsequent read, with no
 * in-product way back: `groups.json` is read on every authentication, so a
 * single over-cap write would brick `serve` and `connect` for everyone. The
 * refusal is its own error class, never `StoreCorruptError` — nothing on disk
 * is corrupt, the caller simply asked for something the schema forbids.
 *
 * MEMO — `groups.json` and `agents.json` are read on EVERY authenticated
 * request, and re-running a zod schema over an unchanged document is pure
 * overhead; the CAS already hands `read()` a revision, so "did anything move?"
 * is a comparison, not a guess. Both `rev` AND the stored bytes are matched,
 * so a database that was recreated (revisions restarting at 1) cannot serve a
 * stale value, and a write by another process is caught by the mismatch.
 *
 * The memo caches the PARSE, not the object handed out: every `parseRow`
 * returns a copy of it, so `read()` keeps its original contract — the caller
 * owns a value nobody else holds a reference to, and a caller that mutates
 * what it read cannot poison the next reader. A clone is still far cheaper
 * than `JSON.parse` plus a zod schema. The owning store must `invalidate()`
 * on every commit.
 *
 * That copy is `cloneKeepingPrototypes`, NOT `structuredClone`: the validator
 * may build null-prototype maps on purpose (`policy/inventory-store.ts` does,
 * for every map keyed by a name a server chooses), and a clone that rebuilds
 * them with `Object.prototype` would hand the read side back the very
 * prototype-chain lookups those maps exist to prevent.
 */
export interface DocumentValidator<T> {
  /** Parses and validates raw document text; `StoreCorruptError` on either failure. */
  parseText(text: string): T
  /** Same, memoised on the row's revision and bytes; a fresh deep copy, prototypes intact. */
  parseRow(row: DocumentRow): T
  /** Refuses a value the schema rejects with `StoreWriteRejectedError`, before any write. */
  assertWritable(next: T): void
  /** Forgets the memo; call on every committed write. */
  invalidate(): void
}

export function createDocumentValidator<T>(
  filePath: string,
  validate: (raw: unknown) => T,
): DocumentValidator<T> {
  let memo: { readonly rev: number; readonly doc: string; readonly value: T } | null = null

  function parseText(text: string): T {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      throw new StoreCorruptError(filePath, error)
    }
    try {
      return validate(parsed)
    } catch (error: unknown) {
      throw new StoreCorruptError(filePath, error)
    }
  }

  function parseRow(row: DocumentRow): T {
    if (memo === null || memo.rev !== row.rev || memo.doc !== row.doc) {
      memo = { rev: row.rev, doc: row.doc, value: parseText(row.doc) }
    }
    return cloneKeepingPrototypes(memo.value)
  }

  function assertWritable(next: T): void {
    try {
      validate(next)
    } catch (error: unknown) {
      throw new StoreWriteRejectedError(filePath, error)
    }
  }

  return {
    parseText,
    parseRow,
    assertWritable,
    invalidate: () => {
      memo = null
    },
  }
}
