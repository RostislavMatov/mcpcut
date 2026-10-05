import { FILES_PG_URL_SECRET } from './constants.js'
import { createVaultStore } from '../../vault/store.js'

/**
 * The Postgres URL lives in the vault under one secret name; mode is on
 * exactly when it is there (ADR-0020 §6). The URL carries the password, so
 * nothing outside this file prints it: `describeDbUrl` is the only form that
 * may reach a screen, a journal record or an error.
 */

export type DbUrlState =
  | { readonly status: 'off' }
  | { readonly status: 'on'; readonly url: string }
  | { readonly status: 'vault-error'; readonly message: string }

export interface ReadDbUrlOptions {
  readonly journalDir: string
  /** The CLI prefix for next-step lines (`mcpcut` or the npx form). */
  readonly cli?: string
}

export async function readDbUrl(opts: ReadDbUrlOptions): Promise<DbUrlState> {
  const cli = opts.cli ?? 'mcpcut'
  const result = await createVaultStore({ journalDir: opts.journalDir }).readSecretValues([FILES_PG_URL_SECRET])
  if (result.status === 'not-initialized') {
    return { status: 'vault-error', message: `the vault is not initialized: run \`${cli} vault init\`` }
  }
  if (result.status === 'corrupt') {
    return { status: 'vault-error', message: `the vault cannot be read (${result.message}): check it with \`${cli} vault list\`` }
  }
  const url = result.values[FILES_PG_URL_SECRET]
  return url === undefined ? { status: 'off' } : { status: 'on', url }
}

export type ParsedDbUrl = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly message: string }

const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:']
const DEFAULT_PG_PORT = '5432'

export function invalidUrlMessage(cli: string): string {
  return (
    `the vault secret ${FILES_PG_URL_SECRET} is not a postgres:// URL: ` +
    `replace it with \`printf '%s' '<url>' | ${cli} vault set ${FILES_PG_URL_SECRET}\``
  )
}

/** Only `postgres:` / `postgresql:` URLs with a host; the message never echoes the value. */
export function parseDbUrl(value: string, cli = 'mcpcut'): ParsedDbUrl {
  try {
    const url = new URL(value)
    if (POSTGRES_PROTOCOLS.includes(url.protocol) && url.hostname !== '') return { ok: true, url }
  } catch {
    // fall through to the one refusal below
  }
  return { ok: false, message: invalidUrlMessage(cli) }
}

/** `postgres://user@host:port/db` — never the password, never query parameters. */
export function describeDbUrl(value: string): string {
  const parsed = parseDbUrl(value)
  if (!parsed.ok) return '(not a postgres:// URL)'
  const { username, hostname, port, pathname } = parsed.url
  const user = username === '' ? '' : `${username}@`
  return `postgres://${user}${hostname}:${port === '' ? DEFAULT_PG_PORT : port}${pathname}`
}

/** The `host:port` of a URL, for the not-reachable line. */
export function hostPortOf(value: string): string {
  const parsed = parseDbUrl(value)
  if (!parsed.ok) return 'the configured host'
  return `${parsed.url.hostname}:${parsed.url.port === '' ? DEFAULT_PG_PORT : parsed.url.port}`
}
