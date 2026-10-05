import { DB_SCHEMA_PATTERN, DEFAULT_DB_SCHEMA } from './constants.js'
import { FilesDbError } from './errors.js'

/** Hidden test seam: runs the Postgres commands against another schema. Validated like any schema name. */
export const DB_SCHEMA_ENV_VAR = 'MCPCUT_FILES_DB_SCHEMA'

export interface SchemaSources {
  /** A schema given by code (the CLI test seams); wins over the environment. */
  readonly schema?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** The schema to use: the seam, else the environment variable, else the default. Throws `FilesDbError` for a bad name. */
export function resolveSchema(sources: SchemaSources): string {
  const fromEnv = sources.env?.[DB_SCHEMA_ENV_VAR]
  const chosen = sources.schema ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv)
  if (chosen === undefined) return DEFAULT_DB_SCHEMA
  if (!DB_SCHEMA_PATTERN.test(chosen)) {
    throw new FilesDbError(`${DB_SCHEMA_ENV_VAR} is not a valid schema name: use lowercase letters, digits and underscores, or unset it`)
  }
  return chosen
}
