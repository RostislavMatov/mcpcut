/** Postgres side of the file module (ADR-0020 §6, §7): names, limits and lock keys, in one place. */

/** The client version users get; also an exact devDependency so tests run the same client. */
export const PG_PACKAGE_VERSION = '8.23.1'

/** The vault secret that switches Postgres mode on: mode is on exactly when the vault holds it. */
export const FILES_PG_URL_SECRET = 'files-pg-url'

export const DEFAULT_DB_SCHEMA = 'mcpcut'

/** Schema names are interpolated into `search_path` and `CREATE SCHEMA`: validated first. */
export const DB_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/

/** First 8 bytes of sha256('mcpcut:files:migrate') as a signed bigint. */
export const MIGRATION_LOCK_KEY = '6862388375162300193'

/** First 8 bytes of sha256('mcpcut:files:ingest') as a signed bigint. */
export const INGEST_LOCK_KEY = '3942871068712752337'

export const DOCKER_CONTAINER_NAME = 'mcpcut-postgres'
export const DOCKER_VOLUME_NAME = 'mcpcut-postgres'
export const DOCKER_IMAGE = 'pgvector/pgvector:pg18'
export const DOCKER_HOST_PORT = 55432
export const DB_USER = 'mcpcut'
export const DB_NAME = 'mcpcut'
/** The pg18 image keeps its data under this volume (`PGDATA=/var/lib/postgresql/18/docker`). */
export const DOCKER_DATA_MOUNT = '/var/lib/postgresql'

export const CONNECT_TIMEOUT_MS = 3000
export const STATEMENT_TIMEOUT_MS = 30_000
/** Three: in `serve` the index round holds one client for its lock and one for a query, while the hourly walk runs beside it. */
export const POOL_MAX = 3
export const APPLICATION_NAME = 'mcpcut'

/** The data-dir folder that holds the pinned client tree and `postgres.env`. */
export const MODULES_DIR_NAME = 'modules'
export const POSTGRES_ENV_FILE_NAME = 'postgres.env'

/** The catalog walk: entries per root before it stops without deleting, and the largest file it hashes. */
export const CATALOG_MAX_ENTRIES = 200_000
export const CATALOG_HASH_MAX_BYTES = 32 * 1024 * 1024
export const CATALOG_BATCH_SIZE = 500
/** Paths longer than this (code points, root or relative) are not catalogued: they would not fit an index row. */
export const CATALOG_MAX_PATH_CODE_POINTS = 600
/** Bytes one walk may read for hashing; changed files past it are recorded without a hash and hashed by a later walk. */
export const CATALOG_HASH_BUDGET_BYTES = 1024 * 1024 * 1024
