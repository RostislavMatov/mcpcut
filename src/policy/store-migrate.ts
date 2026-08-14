import {
  markerPresent,
  assertNotPreviouslyMigrated,
  dbPathFor,
  keyFor,
  loadLegacyTextAt,
  openStateDbShared,
  rethrowClassified,
  selectDocument,
} from './store-backend.js'

/**
 * The explicit-command counterpart of `createJsonStore`'s lazy import, used
 * by `mcp-journal migrate` (`src/cli/migrate-cmd.ts`) to report on every
 * store up front, without requiring an operator to touch each one through
 * its own CLI surface first.
 *
 * This module never writes: it probes the current status and, when an import
 * is due, delegates to `importDocument` — a callback the CLI wires to a READ
 * through the document's own domain store. That read triggers the lazy
 * import inside `createJsonStore`, which gates on the DOMAIN validator, so
 * `migrate` can never persist a document the ordinary path would refuse
 * (valid-JSON-but-wrong-shape included): a bad legacy file surfaces as
 * `StoreCorruptError`, imports nothing, and stays fixable on disk.
 */

/**
 * Row status `migrateLegacyStateFile` reports for one document. `native`
 * means the row was born in `state.db` and never came from a legacy file —
 * an operator auditing which hosts still hold importable legacy `*.json`
 * must be able to tell that apart from `already-migrated`.
 */
export type LegacyMigrationStatus = 'imported' | 'already-migrated' | 'native' | 'no-file'

export async function migrateLegacyStateFile(
  filePath: string,
  importDocument: () => Promise<void>,
): Promise<LegacyMigrationStatus> {
  const dbPath = dbPathFor(filePath)
  const documentName = keyFor(filePath)

  let db
  try {
    db = (await openStateDbShared(dbPath)).db
  } catch (error: unknown) {
    rethrowClassified(filePath, error, true)
  }

  try {
    if (selectDocument(db, documentName, filePath) !== null) {
      return markerPresent(db, documentName) ? 'already-migrated' : 'native'
    }
    // A marker without a row is data loss, not "not migrated yet" — the same
    // refusal the lazy path raises, surfaced here before any import runs.
    assertNotPreviouslyMigrated(db, documentName, filePath)

    if ((await loadLegacyTextAt(filePath)) === null) return 'no-file'

    await importDocument()
    // The domain read either imported the file (row present now) or threw;
    // a still-missing row means the file vanished mid-run — report honestly.
    return selectDocument(db, documentName, filePath) !== null ? 'imported' : 'no-file'
  } catch (error: unknown) {
    rethrowClassified(filePath, error)
  }
}
