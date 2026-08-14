import { setTimeout as sleep } from 'node:timers/promises'
import { isSqliteBusy, type SqliteHandle } from '../store/sqlite.js'
import {
  StoreCorruptError,
  StoreLockError,
  assertNotPreviouslyMigrated,
  dbPathFor,
  insertDocumentFirstWrite,
  keyFor,
  loadLegacyTextAt,
  openStateDbShared,
  rethrowClassified,
  selectDocument,
  updateDocumentCas,
} from './store-backend.js'

/**
 * Transactional store for control-plane state (approved tool inventory,
 * quarantine, grants, agents, admins, registry). One `state.db` per journal
 * directory holds every document as a row, and each read-modify-write commits
 * through an optimistic revision CAS — no cross-process lockfile and no
 * whole-file rewrite (ADR-0006).
 *
 * The write path is deliberately optimistic rather than `BEGIN IMMEDIATE`
 * around the whole cycle: parsing, `validate`, `fn` and serialization all run
 * OUTSIDE the writer lock, and the only serialized work is one indexed
 * conditional `UPDATE`. A lost race costs a retry, not a held lock, and the
 * synchronous busy-wait `node:sqlite` imposes on a contended statement is
 * capped at `STATEMENT_BUSY_TIMEOUT_MS` per attempt — the real waiting
 * happens in this module's async retry loop, so a contended store never
 * freezes the event loop for the whole budget. After
 * `CAS_LOSSES_BEFORE_PESSIMISTIC` straight losses one attempt runs under
 * `BEGIN IMMEDIATE` instead, so an expensive writer racing cheap ones is
 * guaranteed forward progress.
 *
 * The `filePath` argument is still the identity of a document: its basename
 * is the row key and its directory picks the database, so callers keep the
 * paths they always had. A legacy `*.json` file at that path is imported on
 * first touch (recorded in `migrated_documents`, atomically) and then left
 * alone as a cold backup; a migrated document whose row later vanishes is
 * refused loudly rather than silently re-imported (see `store-backend.ts`).
 *
 * Deliberately dependency-free: callers inject a `validate` function instead
 * of this module importing a zod schema, so it has no coupling to
 * `src/policy/schema.ts`, and it talks to SQLite only through
 * `src/store/sqlite.ts`.
 */

export { StoreCorruptError, StoreLockError } from './store-backend.js'
export type { StateDatabase } from './store-backend.js'

/** Budgets of the transactional write path (distinct from the vault's file-lock options). */
export interface JsonStoreLockOptions {
  /** Total budget of one write (busy waits and CAS retries combined) before `StoreLockError`. */
  readonly totalWaitMs?: number
}

export interface JsonStoreOptions<T> {
  /** Parses/validates the raw JSON value read from storage. Must throw on any invalid shape. */
  readonly validate: (raw: unknown) => T
  /** Returned (as a deep copy) when the document does not exist yet. */
  readonly defaultValue: T
  /**
   * Overrides for the write budgets. A one-shot CLI and a long-lived `serve`
   * do not want the same waits, and tests must not pay a real 5-second budget
   * to exercise the contended path.
   */
  readonly lock?: JsonStoreLockOptions
}

export interface JsonStore<T> {
  /**
   * Missing document → a deep copy of `defaultValue`. A corrupt document,
   * database, or legacy file → rejects with `StoreCorruptError`; a write lock
   * held past the budget during the one write `read()` can perform (the
   * first-touch legacy import) → rejects with `StoreLockError`. Never
   * silently falls back to the default for a document that exists but is
   * bad — corrupt state must be loud, not quietly treated as empty.
   *
   * A read of a document that does not exist yet still creates the database
   * file (opening is what creates it) but writes no row.
   */
  read(): Promise<T>
  /**
   * Read-modify-write committed by an optimistic revision CAS, additionally
   * serialized per store instance so concurrent in-process callers never
   * interleave. It resolves with the value that was persisted, as a fresh
   * deep copy round-tripped through JSON — exactly what a subsequent `read()`
   * would yield. If the current document is corrupt, the update is rejected
   * rather than silently overwriting it with a fresh default.
   *
   * `fn` MUST be a pure function of the value it is handed, and MUST tolerate
   * being called more than once: when a concurrent writer commits between our
   * read and our conditional write, the whole cycle re-runs against the value
   * that writer committed. An `fn` that accumulates into a captured variable,
   * journals, or mints an id as a side effect will observe that replay — keep
   * all of it in the returned value. An error thrown by `fn` propagates only
   * once the snapshot it saw is known to be current; an error computed from a
   * stale snapshot is discarded and the cycle re-runs.
   */
  update(fn: (current: T) => T): Promise<T>
}

/** Matches the acquisition budget the file lock used to give one `update()`. */
const DEFAULT_TOTAL_WAIT_MS = 5_000
/** Cap of the exponential retry backoff between CAS attempts. */
const RETRY_BACKOFF_CAP_MS = 32
/** Straight CAS losses before one attempt runs under `BEGIN IMMEDIATE` to force progress. */
const CAS_LOSSES_BEFORE_PESSIMISTIC = 4

/** One update attempt's outcome; `fnError` is boxed so `undefined` thrown by `fn` survives. */
type AttemptResult =
  | { readonly kind: 'committed'; readonly text: string }
  | { readonly kind: 'conflict'; readonly fnError?: readonly [unknown] }

/**
 * Creates a store for the document identified by `filePath`, backed by
 * `state.db` in the same directory. That directory and database share the
 * journal's ownership model — directory 0700, file 0600 — applied by the
 * SQLite adapter, because this data (approved tool schemas, quarantine,
 * grants, agent tokens) is as sensitive as the journal itself.
 */
export function createJsonStore<T>(filePath: string, opts: JsonStoreOptions<T>): JsonStore<T> {
  const { validate, defaultValue } = opts
  const dbPath = dbPathFor(filePath)
  const documentName = keyFor(filePath)
  const totalWaitMs = opts.lock?.totalWaitMs ?? DEFAULT_TOTAL_WAIT_MS

  /** Serializes every read-modify-write cycle so updates never interleave. */
  let queue: Promise<void> = Promise.resolve()

  async function stateDb(): Promise<SqliteHandle> {
    try {
      return await openStateDbShared(dbPath)
    } catch (error: unknown) {
      rethrowClassified(filePath, error, true)
    }
  }

  function parseValidated(text: string): T {
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

  /**
   * Wraps one storage statement: busy and already-typed store errors pass
   * through untouched (the caller classifies busy), anything else — say, a
   * pre-existing `documents` table with a foreign shape — is corruption, not
   * an internal error to leak raw.
   */
  function guarded<R>(op: () => R): R {
    try {
      return op()
    } catch (error: unknown) {
      if (isSqliteBusy(error) || error instanceof StoreCorruptError) throw error
      throw new StoreCorruptError(filePath, error)
    }
  }

  /**
   * The legacy text to import on first touch, gated through the DOMAIN
   * validator before it is ever allowed near the database: an unimportable
   * file is corruption, not an empty store. `null` when there is nothing to
   * import.
   */
  async function legacyImportCandidate(): Promise<string | null> {
    const text = await loadLegacyTextAt(filePath)
    if (text !== null) parseValidated(text)
    return text
  }

  /**
   * Retries `op` on a busy writer with the same async pacing as `update()`,
   * so the one write `read()` can perform (the first-touch legacy import)
   * shares the store's `totalWaitMs` budget instead of failing on a single
   * 50 ms statement window.
   */
  async function withBusyRetries<R>(op: () => R): Promise<R> {
    const deadlineAt = performance.now() + totalWaitMs
    let attempt = 0
    for (;;) {
      try {
        return op()
      } catch (error: unknown) {
        if (!isSqliteBusy(error) || performance.now() >= deadlineAt) throw error
      }
      attempt += 1
      await sleep(Math.min(2 ** attempt, RETRY_BACKOFF_CAP_MS) * Math.random())
    }
  }

  async function read(): Promise<T> {
    const handle = await stateDb()
    try {
      const row = guarded(() => selectDocument(handle.db, documentName, filePath))
      // Either branch yields a value nobody else holds a reference to: a
      // fresh parse, or a clone of the caller's `defaultValue`.
      if (row !== null) return parseValidated(row.doc)

      guarded(() => assertNotPreviouslyMigrated(handle.db, documentName, filePath))
      const legacyText = await legacyImportCandidate()
      if (legacyText === null) return structuredClone(defaultValue)

      // Import races with concurrent writers are benign: if someone landed a
      // row first, the insert is skipped and their (current) row is read back.
      await withBusyRetries(() =>
        guarded(() => insertDocumentFirstWrite(handle, documentName, filePath, legacyText, true)),
      )
      const imported = guarded(() => selectDocument(handle.db, documentName, filePath))
      return imported === null ? structuredClone(defaultValue) : parseValidated(imported.doc)
    } catch (error: unknown) {
      rethrowClassified(filePath, error)
    }
  }

  /** One optimistic attempt. All heavy work (parse, `fn`, stringify) runs with no lock held. */
  async function attemptOptimistic(
    handle: SqliteHandle,
    fn: (current: T) => T,
  ): Promise<AttemptResult> {
    const db = handle.db
    const row = guarded(() => selectDocument(db, documentName, filePath))

    if (row === null) {
      guarded(() => assertNotPreviouslyMigrated(db, documentName, filePath))
      const legacyText = await legacyImportCandidate()
      const current = legacyText === null ? structuredClone(defaultValue) : parseValidated(legacyText)

      let next: T
      try {
        next = fn(current)
      } catch (error: unknown) {
        if (guarded(() => selectDocument(db, documentName, filePath)) === null) throw error
        return { kind: 'conflict', fnError: [error] }
      }

      const text = JSON.stringify(next)
      // The legacy value (if any) is superseded by `next` in the same insert —
      // importing it as a separate step would double-write; the migration
      // marker still lands in the same transaction.
      const inserted = guarded(() =>
        insertDocumentFirstWrite(handle, documentName, filePath, text, legacyText !== null),
      )
      return inserted ? { kind: 'committed', text } : { kind: 'conflict' }
    }

    const current = parseValidated(row.doc)
    let next: T
    try {
      next = fn(current)
    } catch (error: unknown) {
      const nowRev = guarded(() => selectDocument(db, documentName, filePath))?.rev ?? null
      if (nowRev === row.rev) throw error
      return { kind: 'conflict', fnError: [error] }
    }

    const text = JSON.stringify(next)
    const won = guarded(() => updateDocumentCas(db, documentName, text, row.rev))
    return won ? { kind: 'committed', text } : { kind: 'conflict' }
  }

  /**
   * The pessimistic fallback: the whole cycle under `BEGIN IMMEDIATE`, so a
   * writer that keeps losing the optimistic race is guaranteed to land. Under
   * the write lock the snapshot cannot be stale, so an `fn` throw here is
   * genuine and propagates (rolling the transaction back). A missing row is
   * left to the optimistic path — it owns the legacy-import logic.
   */
  function attemptPessimistic(handle: SqliteHandle, fn: (current: T) => T): AttemptResult {
    return handle.transaction((db) => {
      const row = selectDocument(db, documentName, filePath)
      if (row === null) return { kind: 'conflict' as const }
      const next = fn(parseValidated(row.doc))
      const text = JSON.stringify(next)
      updateDocumentCas(db, documentName, text, row.rev)
      return { kind: 'committed' as const, text }
    })
  }

  async function updateWithRetries(fn: (current: T) => T): Promise<T> {
    const handle = await stateDb()
    const deadlineAt = performance.now() + totalWaitMs
    let conflicts = 0
    let lastFnError: readonly [unknown] | undefined

    for (;;) {
      let outcome: AttemptResult
      try {
        if (conflicts >= CAS_LOSSES_BEFORE_PESSIMISTIC) {
          outcome = attemptPessimistic(handle, fn)
          // Pessimistic conflicts only on a missing row, and row creation
          // (with its async legacy import) belongs to the optimistic path —
          // fall through to it in the same iteration, or a first-ever write
          // would livelock once the pessimistic threshold is crossed.
          if (outcome.kind === 'conflict') outcome = await attemptOptimistic(handle, fn)
        } else {
          outcome = await attemptOptimistic(handle, fn)
        }
      } catch (error: unknown) {
        // Busy = some other writer holds the lock right now; that is a
        // retryable state of the world, not a verdict. Everything else
        // (corruption, a genuine `fn` error) propagates.
        if (!isSqliteBusy(error)) throw error
        outcome = { kind: 'conflict' }
      }

      if (outcome.kind === 'committed') {
        // Resolve with what was PERSISTED: a fresh deep copy round-tripped
        // through JSON, exactly what the next read() yields.
        return JSON.parse(outcome.text) as T
      }

      conflicts += 1
      // Only the LAST attempt's verdict is kept: an error `fn` threw against
      // a snapshot that later attempts already superseded (and ran through
      // successfully) is stale knowledge, not the current truth — so a
      // successful-but-losing attempt CLEARS the recorded error.
      lastFnError = outcome.fnError
      if (performance.now() >= deadlineAt) {
        // A deterministic `fn` error still standing on the final attempt
        // beats a phantom lock report: the operator should see the domain
        // failure, not go hunting for a lock holder that does not exist.
        if (lastFnError !== undefined) throw lastFnError[0]
        throw new StoreLockError(
          filePath,
          `concurrent writers kept winning the revision race for ${totalWaitMs} ms`,
        )
      }
      // Exponential backoff with jitter so hot writers do not retry in
      // lockstep against the same winner.
      await sleep(Math.min(2 ** conflicts, RETRY_BACKOFF_CAP_MS) * Math.random())
    }
  }

  function update(fn: (current: T) => T): Promise<T> {
    const task = queue.then(() => updateWithRetries(fn))

    // Keep the queue itself always-resolved so one failed update doesn't
    // permanently wedge the chain for subsequent callers; the rejection is
    // still delivered to whoever awaited this particular `task`.
    queue = task.then(
      () => undefined,
      () => undefined,
    )

    return task
  }

  return { read, update }
}
