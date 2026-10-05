import { redactString } from '../../redact/redact.js'
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
 * An agent's call opens the database through `openFilesDb`, which runs the
 * core migrations (the catalog and audit tables of the schema, when missing or
 * behind). It never creates the search tables or the pgvector extension: it
 * reads them when they exist and answers `empty` when they do not. Only the
 * administrator's paths (`files index on`, `db sync`, `serve`) create those.
 *
 * What the agent is told is a fixed line (`tool-search.ts`); the detailed
 * problem goes to the administrator through `onProblem`, once per distinct text.
 */

export type SearchOpen =
  | { readonly kind: 'ready'; readonly sdb: SearchDb; readonly embedder: Embedder }
  /** Postgres is up but nothing was ever indexed: no search tables yet. */
  | { readonly kind: 'empty' }
  /** `problem` is one line for the administrator, never shown to the agent; it names the command that fixes it. `isClosing`: the backend was closed. */
  | { readonly kind: 'unavailable'; readonly problem: string; readonly isClosing?: true }

/** What the agent is told when the file server shuts down under its call. */
export const CLOSING_PROBLEM = 'the file server is closing: connect again'

export interface SearchBackend {
  open(): Promise<SearchOpen>
  /** Closes the embedder and the connection pool; idempotent. */
  close(): Promise<void>
  /** True once `close` has been called: an error that arrives after that is the shutdown, not a fault. */
  isClosed(): boolean
  /** The CLI prefix for the commands in the lines the agent sees. */
  readonly cli: string
  /** Tells the administrator about a problem the agent was not told in detail; the same text is passed on once. */
  report(problem: string): void
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
  /** Where the administrator hears of a problem (stderr of `serve` or `connect`); called once per distinct text. */
  readonly onProblem?: (problem: string) => void
  /** @internal test seams. */
  readonly now?: () => number
  readonly probe?: typeof probeSearchDb
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

/** A value was made after `close`: it is closed again at once and the call says the server is closing. */
class ClosingError extends Error {}

/** A good probe is trusted this long: an agent searching in a loop does not repeat the 2-4 catalog queries. */
const PROBE_CACHE_MS = 30_000
/** The administrator is told of this many distinct problems per process; beyond that, silence beats a flood. */
const REPORTED_PROBLEMS_MAX = 50

const closingOpen = (): SearchOpen => ({ kind: 'unavailable', problem: CLOSING_PROBLEM, isClosing: true })

export function createSearchBackend(opts: SearchBackendOptions): SearchBackend {
  let isClosed = false
  let goodProbe: { readonly sdb: SearchDb; readonly at: number } | undefined
  const reported = new Set<string>()
  const clock = opts.now ?? Date.now
  const probe = opts.probe ?? probeSearchDb
  const modulesDir = modulesDirOf(opts.journalDir)

  function report(raw: string): void {
    const problem = redactString(formatReadableField(raw))
    if (opts.onProblem === undefined || reported.has(problem) || reported.size >= REPORTED_PROBLEMS_MAX) return
    reported.add(problem)
    try {
      opts.onProblem(problem)
    } catch {
      // The administrator's channel failing must not fail the agent's call.
    }
  }

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
    return closedIfLate(configured.db)
  })

  const embedder = lazy(async (): Promise<Embedder> => {
    if (opts.createEmbedder !== undefined) return closedIfLate(await opts.createEmbedder(modulesDir))
    const problem = await searchRuntimeProblem(modulesDir, opts.cli)
    if (problem !== null) throw new ProblemError(runtimeProblemText(problem))
    return closedIfLate(await createLocalEmbedder({ modulesDir, cli: opts.cli }))
  })

  /** Whatever finishes being made after `close` has nobody to close it: it is closed here. */
  async function closedIfLate<T extends { close(): Promise<void> }>(made: T): Promise<T> {
    if (!isClosed) return made
    await made.close().catch(() => undefined)
    throw new ClosingError()
  }

  async function readyState(): Promise<SearchOpen> {
    const db = await database.get()
    if (isClosed) return closingOpen()
    const found = await probeOf(db)
    if (found.kind !== 'ready') return found
    if (isClosed) return closingOpen()
    const made = await embedder.get()
    return isClosed ? closingOpen() : { kind: 'ready', sdb: found.sdb, embedder: made }
  }

  /** The cached good probe, or a fresh one (cached only when it is ready: empty and failed answers are asked again). */
  async function probeOf(db: FilesDb): Promise<Probe> {
    if (goodProbe !== undefined && clock() - goodProbe.at < PROBE_CACHE_MS) return { kind: 'ready', sdb: goodProbe.sdb }
    const found = await probe(db, opts.cli)
    if (found.kind !== 'ready') return found
    goodProbe = { sdb: found.sdb, at: clock() }
    return found
  }

  async function open(): Promise<SearchOpen> {
    if (isClosed) return closingOpen()
    try {
      const opened = await readyState()
      if (opened.kind === 'unavailable' && opened.isClosing !== true) report(opened.problem)
      return opened
    } catch (error: unknown) {
      if (isClosed || error instanceof ClosingError) return closingOpen()
      const problem = describeError(error)
      report(problem)
      return { kind: 'unavailable', problem }
    }
  }

  async function close(): Promise<void> {
    isClosed = true
    goodProbe = undefined
    const [opened, model] = [database.peek(), embedder.peek()]
    database.reset()
    embedder.reset()
    await Promise.allSettled([
      model?.then((made) => made.close()) ?? Promise.resolve(),
      opened?.then((db) => db.close()) ?? Promise.resolve(),
    ])
  }

  return { open, close, isClosed: () => isClosed, cli: opts.cli, report }
}
