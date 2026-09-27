/**
 * Owner-only permissions for everything the plane writes to disk. A leaf
 * module on purpose: `src/store/sqlite.ts` needs these two numbers, and
 * reaching them through `src/config.ts` would resolve the install's data
 * directory (it reads `~/.mcpcut/config.json` at import) in every process
 * that opens a database — including the hub, which is not an install.
 * `src/config.ts` re-exports both, so its importers are unchanged.
 */

/** Journal directory permissions: owner-only (journals hold sensitive traffic). */
export const JOURNAL_DIR_MODE = 0o700

/** Journal file permissions: owner read/write only. */
export const JOURNAL_FILE_MODE = 0o600
