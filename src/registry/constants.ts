import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'

/**
 * Defaults and limits for the MCP server registry (`src/registry/*`). Kept
 * out of `src/config.ts` so the two files have distinct, non-overlapping
 * owners (same rule as `src/policy/constants.ts`).
 */

/** File name of the registry store inside the journal directory. */
export const REGISTRY_FILE_NAME = 'registry.json'

/** Absolute path of the registry store for a given journal directory. */
export function registryFilePath(journalDir: string = JOURNAL_DIR): string {
  return join(journalDir, REGISTRY_FILE_NAME)
}

/**
 * Registry server names: lowercase DNS-label style. Deliberately narrower
 * than the policy `SERVER_NAME_PATTERN` (which also has to describe
 * proxy-generated `auto:<hash>` identities): registry names become CLI
 * arguments, URL path segments (`/servers/:server`, M3 Wave 3) and store map
 * keys, so no `:`/`.`/`_`/uppercase.
 */
export const REGISTRY_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Reserved name prefix: `auto:<sha256 prefix>` is the M2 fallback identity
 * the proxy mints for ad-hoc `wrap` sessions. A registry entry must never be
 * able to shadow (or be confused with) one of those. The name pattern above
 * already rejects `:`, but the prefix gets its own check + message so the
 * operator learns *why*, not just "bad name".
 */
export const RESERVED_SERVER_NAME_PREFIX = 'auto:'

/** Prefix marking an env/header value as a vault reference, not a literal. */
export const VAULT_REF_PREFIX = 'vault:'

/** Full shape of a vault reference: `vault:<name>` with a registry-style name. */
export const VAULT_REF_PATTERN = /^vault:[a-z0-9][a-z0-9-]{0,63}$/

/** Transports a registry entry can declare. */
export const SERVER_TRANSPORT_VALUES = ['stdio', 'http'] as const

/**
 * HTTP session models for upstream connections (see ADR 0002, dual-version):
 * `sessionful` (initialize + `Mcp-Session-Id`), `stateless` (2026-07-28
 * revision), or `auto` (probe with initialize, then pin).
 */
export const HTTP_PROTOCOL_VALUES = ['sessionful', 'stateless', 'auto'] as const

/** Default HTTP session model when a record does not pin one. */
export const DEFAULT_HTTP_PROTOCOL = 'auto'

/** Env variable names must be portable identifiers (also keeps keys shell-safe). */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** HTTP header field names: RFC 9110 token characters. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Max servers a single registry file may hold (bounds validation and `server list` cost). */
export const MAX_SERVERS_IN_REGISTRY = 200

/** Max env entries per server record. */
export const MAX_ENV_ENTRIES_PER_SERVER = 100

/** Max header entries per server record. */
export const MAX_HEADER_ENTRIES_PER_SERVER = 100

/** Max argv entries per stdio server record. */
export const MAX_ARGS_PER_SERVER = 100

/** Max characters for any single string value in a record (command, url, arg, env/header value). */
export const MAX_RECORD_VALUE_CHARS = 4096
