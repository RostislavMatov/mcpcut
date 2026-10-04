/** File-module constants shared by the schema, the resolver and the rights (ADR-0020). */

/** The operations a file rule can give, in the order they are shown and returned. */
export const FILE_OPS = ['read', 'write', 'edit', 'delete'] as const

export type FileOp = (typeof FILE_OPS)[number]

/** The per-root trash folder (ADR-0020 §4); no file tool may name it. */
export const TRASH_DIR_NAME = '.mcpcut-trash'

/** Longer paths are refused outright — no real folder tree needs more. */
export const MAX_PATH_LENGTH = 4096

/** Max folder rules in one grant (one agent's or one group's, for the files server). */
export const MAX_PATHS_PER_GRANT = 100

/** Max declared roots (folders the module works with at all). */
export const MAX_ROOTS = 50

/** The built-in file server's name — the key of its grant in an agent's (or group's) grants. */
export const FILES_SERVER_NAME = 'files'

/** The roots document (a row in `state.db` next to agents and the registry). */
export const ROOTS_FILE_NAME = 'files-roots.json'

/** The largest file the I/O layer reads (10 MiB); a bigger one is `too-large`. */
export const MAX_READ_BYTES = 10 * 1024 * 1024

/** The largest content one write or edit may produce (10 MiB). */
export const MAX_WRITE_BYTES = 10 * 1024 * 1024

/** The most entries one directory listing returns; the rest is `truncated`. */
export const MAX_LIST_ENTRIES = 1000

/** One day in milliseconds. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** How long a trashed item is kept before the automatic purge in `serve` (and the default of `files trash purge`). */
export const TRASH_RETENTION_DAYS = 30

/** The largest `--older-than-days` a purge accepts (about ten years). */
export const MAX_PURGE_DAYS = 3650
