import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory where per-session JSONL journal files are stored. */
export const JOURNAL_DIR = join(homedir(), '.mcp-journal')

/**
 * Case-insensitive substring matches against object keys whose values
 * must never reach the journal unredacted.
 */
export const REDACT_KEY_PATTERNS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'private_key',
  'access_key',
  'session_id',
  'cookie',
]

/** Regex patterns matched against string values (e.g. inline bearer tokens). */
export const REDACT_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
]

/** Replacement placeholder written to the journal instead of a secret. */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** Max time to keep an unanswered request id for duration correlation. */
export const REQUEST_CORRELATION_TTL_MS = 5 * 60 * 1000

/** Max buffered incomplete line size before the framer flushes it as-is. */
export const MAX_LINE_BUFFER_BYTES = 16 * 1024 * 1024
