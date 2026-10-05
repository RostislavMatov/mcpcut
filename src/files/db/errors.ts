import { DOCKER_CONTAINER_NAME, FILES_PG_URL_SECRET } from './constants.js'
import { hostPortOf, parseDbUrl } from './db-url.js'

/**
 * Every Postgres failure becomes a `FilesDbError` here, once: one line, the
 * next step in it, and never the password (ADR-0020 §6). Callers print
 * `error.message` as is.
 */

export class FilesDbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilesDbError'
  }
}

/** The database was written by a newer mcpcut: nothing is applied, nothing is read. */
export class FilesDbSchemaTooNewError extends FilesDbError {
  constructor(found: number, known: number) {
    super(`Postgres holds schema version ${found}, newer than this mcpcut knows (${known}): update mcpcut`)
    this.name = 'FilesDbSchemaTooNewError'
  }
}

export interface DbErrorContext {
  readonly url: string
  readonly schema: string
  readonly cli: string
}

const UNREACHABLE_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN']
const LOGIN_CODES = ['28P01', '28000']
const TIMEOUT_PATTERN = /timeout|terminated unexpectedly|ended unexpectedly/i

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const direct = (error as { code?: unknown }).code
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = (error as { errors?: unknown }).errors
  return Array.isArray(nested) ? codeOf(nested[0]) : undefined
}

function isUnreachable(error: unknown, code: string | undefined): boolean {
  if (code !== undefined && UNREACHABLE_CODES.includes(code)) return true
  return code === undefined && error instanceof Error && TIMEOUT_PATTERN.test(error.message)
}

/** Removes the raw and the URL-decoded password from a driver message. */
export function scrubPassword(text: string, url: string): string {
  const parsed = parseDbUrl(url)
  if (!parsed.ok || parsed.url.password === '') return text
  const raw = parsed.url.password
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // keep the raw form only
  }
  return [raw, decoded].reduce((out, secret) => (secret === '' ? out : out.replaceAll(secret, '***')), text)
}

function setUrlStep(cli: string): string {
  return `printf '%s' '<url>' | ${cli} vault set ${FILES_PG_URL_SECRET}`
}

/** The one-line error for anything the driver or the server threw. */
export function mapPgError(error: unknown, ctx: DbErrorContext): FilesDbError {
  if (error instanceof FilesDbError) return error
  const code = codeOf(error)
  const parsed = parseDbUrl(ctx.url)
  const user = parsed.ok ? parsed.url.username : ''
  const database = parsed.ok ? parsed.url.pathname.replace(/^\//, '') : ''
  if (isUnreachable(error, code)) {
    return new FilesDbError(
      `Postgres at ${hostPortOf(ctx.url)} is not reachable: start it with \`docker start ${DOCKER_CONTAINER_NAME}\`, then \`${ctx.cli} files db status\``,
    )
  }
  if (code !== undefined && LOGIN_CODES.includes(code)) {
    return new FilesDbError(`Postgres refused the login for ${user}: put the right URL with \`${setUrlStep(ctx.cli)}\``)
  }
  if (code === '3D000') {
    return new FilesDbError(`Postgres has no database "${database}": create it, or put the right URL with \`${setUrlStep(ctx.cli)}\``)
  }
  if (code === '42501') {
    return new FilesDbError(`Postgres user ${user} may not create the schema "${ctx.schema}": grant it CREATE on database "${database}"`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new FilesDbError(`Postgres error ${code ?? 'unknown'}: ${scrubPassword(message, ctx.url)}`)
}
