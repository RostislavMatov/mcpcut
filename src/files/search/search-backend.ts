import { formatReadableField } from '../../journal/format.js'
import type { FilesDb } from '../db/connection.js'
import { DB_SCHEMA_PATTERN } from '../db/constants.js'
import { appliedVersion } from '../db/migrate.js'
import { openConfiguredDb } from '../db/open-configured.js'
import { loadPg, modulesDirOf } from '../db/pg-loader.js'
import type { PgModule } from '../db/pg-types.js'
import { SEARCH_MIGRATION_BASE } from './constants.js'
import { createLocalEmbedder } from './embedder.js'
import { searchRuntimeProblem } from './readiness.js'
import { searchMigrations, type SearchDb } from './search-schema.js'
import type { Embedder } from './types.js'

/**
 * What `search_files` runs on, built lazily and once per process (ADR-0020
 * §6, phase 5 C3): the configured Postgres, the search tables and the local
 * embedder, each opened on the first search that needs it. A failure is a
 * one-line problem for the administrator and is NOT remembered: the next call
 * tries again, so installing the runtime or starting Postgres needs no restart.
 *
 * An agent's call never creates anything: it reads the search tables when they
 * exist and answers `empty` when they do not. Only the administrator's paths
 * (`files index on`, `db sync`, `serve`) create the extension and the tables.
 */

export type SearchOpen =
  | { readonly kind: 'ready'; readonly sdb: SearchDb; readonly embedder: Embedder }
  /** Postgres is up but nothing was ever indexed: no search tables yet. */
  | { readonly kind: 'empty' }
  /** `problem` is one line for the administrator; it names the command that fixes it. */
  | { readonly kind: 'unavailable'; readonly problem: string }

export interface SearchBackend {
  open(): Promise<SearchOpen>
  /** Closes the embedder and the connection pool; idempotent. */
  close(): Promise<void>
}

export interface SearchBackendOptions {
  readonly journalDir: string
  /** The CLI prefix for the commands inside problems. */
  readonly cli: string
  readonly env?: NodeJS.ProcessEnv
  /** Test seams: the same ones the `serve` sync takes. */
  readonly loadPg?: (modulesDir: string) => Promise<PgModule>
  readonly schema?: string
  readonly createEmbedder?: (modulesDir: string) => Promise<Embedder>
}

/** What a caller (connect, serve, a test) may replace; production code leaves them out. */
export type SearchSeams = Pick<SearchBackendOptions, 'loadPg' | 'schema' | 'createEmbedder'>

const NEWEST_SEARCH_VERSION = SEARCH_MIGRATION_BASE + searchMigrations('public').length

const SELECT_VECTOR_SCHEMA =
  "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'"

type Probe = { readonly kind: 'ready'; readonly sdb: SearchDb } | { readonly kind: 'empty' } | { readonly kind: 'unavailable'; readonly problem: string }

/** Reads the search tables' state without changing anything. */
export async function probeSearchDb(db: FilesDb, cli: string): Promise<Probe> {
  const table = await db.query<{ found: string | null }>("SELECT to_regclass('search_files')::text AS found")
  if (table.rows[0]?.found == null) return { kind: 'empty' }
  const version = await appliedVersion(db, 'search')
  if (version > NEWEST_SEARCH_VERSION) return { kind: 'unavailable', problem: `the search index was made by a newer mcpcut: update mcpcut (\`${cli} --version\` shows this one)` }
  if (version < NEWEST_SEARCH_VERSION) return { kind: 'empty' }
  const extension = await db.query<{ schema: string }>(SELECT_VECTOR_SCHEMA)
  const vectorSchema = extension.rows[0]?.schema
  if (vectorSchema === undefined || !DB_SCHEMA_PATTERN.test(vectorSchema)) {
    return { kind: 'unavailable', problem: `this Postgres has no pgvector extension: run \`${cli} files index on <folder>\` again as an administrator` }
  }
  return { kind: 'ready', sdb: { db, vectorSchema } }
}

function describeError(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}

/** The readiness line says "search by meaning is not installed"; inside the handler's own prefix it reads "the search runtime is not installed". */
function runtimeProblemText(problem: string): string {
  return problem.replace(/^search by meaning is not installed/, 'the search runtime is not installed')
}

/** A value made once on success; a failure is thrown to the caller and forgotten. */
function lazy<T>(make: () => Promise<T>): { get(): Promise<T>; peek(): Promise<T> | undefined; reset(): void } {
  let pending: Promise<T> | undefined
  return {
    get: () => {
      if (pending !== undefined) return pending
      const made = make()
      pending = made
      made.catch(() => {
        if (pending === made) pending = undefined
      })
      return made
    },
    peek: () => pending,
    reset: () => {
      pending = undefined
    },
  }
}

class ProblemError extends Error {}

export function createSearchBackend(opts: SearchBackendOptions): SearchBackend {
  let isClosed = false
  const modulesDir = modulesDirOf(opts.journalDir)

  const database = lazy(async (): Promise<FilesDb> => {
    const configured = await openConfiguredDb({
      journalDir: opts.journalDir,
      cli: opts.cli,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.loadPg !== undefined ? { loadPg: opts.loadPg } : { loadPg }),
      ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    })
    if (configured.kind === 'off') throw new ProblemError(`Postgres is not set up: an administrator runs \`${opts.cli} files db init\``)
    if (configured.kind === 'unavailable') throw new ProblemError(configured.reason)
    return configured.db
  })

  const embedder = lazy(async (): Promise<Embedder> => {
    if (opts.createEmbedder !== undefined) return opts.createEmbedder(modulesDir)
    const problem = await searchRuntimeProblem(modulesDir, opts.cli)
    if (problem !== null) throw new ProblemError(runtimeProblemText(problem))
    return createLocalEmbedder({ modulesDir, cli: opts.cli })
  })

  async function open(): Promise<SearchOpen> {
    if (isClosed) return { kind: 'unavailable', problem: 'the file server is closing: connect again' }
    try {
      const probe = await probeSearchDb(await database.get(), opts.cli)
      if (probe.kind !== 'ready') return probe
      return { kind: 'ready', sdb: probe.sdb, embedder: await embedder.get() }
    } catch (error: unknown) {
      return { kind: 'unavailable', problem: describeError(error) }
    }
  }

  async function close(): Promise<void> {
    isClosed = true
    const [opened, model] = [database.peek(), embedder.peek()]
    database.reset()
    embedder.reset()
    await Promise.allSettled([
      model?.then((made) => made.close()) ?? Promise.resolve(),
      opened?.then((db) => db.close()) ?? Promise.resolve(),
    ])
  }

  return { open, close }
}
