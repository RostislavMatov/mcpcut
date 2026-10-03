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
