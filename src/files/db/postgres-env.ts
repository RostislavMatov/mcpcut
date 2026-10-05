import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DB_NAME, DB_USER, POSTGRES_ENV_FILE_NAME } from './constants.js'

/**
 * `<modules>/postgres.env` — the file the docker container reads its user,
 * password and database from. Created once (mode 0600, `wx`); a later run
 * reuses its password so a container made earlier still matches the URL.
 */

const PASSWORD_BYTES = 32
const ENV_FILE_MODE = 0o600
const MODULES_DIR_MODE = 0o700
/** base64url only: the password goes into a URL unescaped. */
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{16,}$/

export type PostgresEnv =
  | { readonly ok: true; readonly path: string; readonly password: string; readonly created: boolean }
  | { readonly ok: false; readonly path: string }

export function postgresEnvPathOf(modulesDir: string): string {
  return join(modulesDir, POSTGRES_ENV_FILE_NAME)
}

function passwordOf(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith('POSTGRES_PASSWORD='))
  const value = line?.slice('POSTGRES_PASSWORD='.length)
  return value !== undefined && PASSWORD_PATTERN.test(value) ? value : undefined
}

function envContentOf(password: string): string {
  return `POSTGRES_USER=${DB_USER}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${DB_NAME}\n`
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reads the env file, or creates it with a fresh password. `ok: false` means it exists but is malformed. */
export async function ensurePostgresEnv(modulesDir: string): Promise<PostgresEnv> {
  const path = postgresEnvPathOf(modulesDir)
  await mkdir(dirname(path), { recursive: true, mode: MODULES_DIR_MODE })
  const existing = await readExisting(path)
  if (existing !== undefined) {
    const password = passwordOf(existing)
    return password === undefined ? { ok: false, path } : { ok: true, path, password, created: false }
  }
  const password = randomBytes(PASSWORD_BYTES).toString('base64url')
  try {
    await writeFile(path, envContentOf(password), { flag: 'wx', mode: ENV_FILE_MODE })
  } catch (error: unknown) {
    // Another process created it between the read and the write: use theirs.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return ensurePostgresEnv(modulesDir)
  }
  return { ok: true, path, password, created: true }
}
