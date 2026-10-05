import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODULES_DIR_NAME } from './constants.js'
import type { PgModule } from './pg-types.js'

/**
 * Loads the Postgres client at run time from the modules folder (ADR-0020 §7):
 * `pg` is not a dependency of mcpcut, `files setup` installs the pinned tree
 * next to the data. The folder sits in the data directory so
 * `MCPCUT_DATA_DIR` isolates it.
 */

export function modulesDirOf(journalDir: string): string {
  return join(journalDir, MODULES_DIR_NAME)
}

/** The client is not installed. The caller words the next step (it knows the CLI prefix). */
export class FilesDbModuleMissingError extends Error {
  constructor() {
    super('the pg client is not installed')
    this.name = 'FilesDbModuleMissingError'
  }
}

/** The one-line message for a missing client, with the real CLI prefix. */
export function moduleMissingMessage(cli: string): string {
  return `Postgres support is not installed: run \`${cli} files setup\``
}

function isPgModule(value: unknown): value is PgModule {
  return typeof value === 'object' && value !== null && typeof (value as { Pool?: unknown }).Pool === 'function'
}

function resolvePg(modulesDir: string): string {
  try {
    return createRequire(join(modulesDir, 'package.json')).resolve('pg')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') throw new FilesDbModuleMissingError()
    throw error
  }
}

export async function loadPg(modulesDir: string): Promise<PgModule> {
  const resolved = resolvePg(modulesDir)
  const loaded = (await import(pathToFileURL(resolved).href)) as { default?: unknown }
  const candidate = loaded.default ?? loaded
  if (isPgModule(candidate)) return candidate
  if (isPgModule(loaded)) return loaded
  throw new Error(`the pg package at ${resolved} does not export a Pool: run \`mcpcut files setup\` again`)
}
