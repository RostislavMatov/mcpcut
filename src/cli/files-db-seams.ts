import type { FilesDb } from '../files/db/connection.js'
import type { PgModule } from '../files/db/pg-types.js'
import type { Embedder } from '../files/search/types.js'

/** What `files setup` hands the runner: constant arguments, never user input. */
export interface NpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly shell: boolean
}

/**
 * Test seams for the Postgres commands (`files setup`, `files db …`). Every
 * one defaults to the real thing; none is reachable from the command line.
 */
export interface FilesDbCliSeams {
  /** Runs npm and resolves with its exit code; rejects when it cannot be started. */
  readonly runNpm?: (invocation: NpmInvocation) => Promise<number>
  readonly platform?: NodeJS.Platform
  /** Loads the pg client from the modules folder. */
  readonly loadPg?: (modulesDir: string) => Promise<PgModule>
  /** The schema to use instead of the default (validated by `openFilesDb`). */
  readonly schema?: string
  /** Receives the opened database, for a test that needs to see the schema it ran against. */
  readonly onOpen?: (db: FilesDb) => void
  /** Search index (phase 5 B): makes the embedder `files db sync` indexes with; the local model by default. */
  readonly indexEmbedder?: (modulesDir: string) => Promise<Embedder>
  /** Search index (phase 5 B): `null` when the search runtime and model are in place, else the one line saying what is missing. */
  readonly searchProblem?: (modulesDir: string, cli: string) => Promise<string | null>
}
