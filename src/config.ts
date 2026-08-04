import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory where per-session JSONL journal files are stored. */
export const JOURNAL_DIR = join(homedir(), '.mcp-journal')

/** Journal directory permissions: owner-only (journals hold sensitive traffic). */
export const JOURNAL_DIR_MODE = 0o700

/** Journal file permissions: owner read/write only. */
export const JOURNAL_FILE_MODE = 0o600

/**
 * Session ids become file names, so they are validated against this pattern
 * before any path is built from them (path-traversal guard). Deliberately
 * wider than the ULID alphabet: callers may inject their own session ids.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Case-insensitive *substring* matches against object keys whose values must
 * never reach the journal unredacted.
 *
 * Tradeoffs, deliberately chosen (an audit journal prefers over-redaction to
 * under-redaction):
 * - 'auth' also matches unrelated keys such as 'author'. Kept anyway: missing
 *   an auth-bearing key is a security bug, redacting an author name is not.
 * - bare 'key' is intentionally NOT in this list: it would swallow 'keyword',
 *   'hotkey', 'keys' and similar. Real secret-bearing key names are covered by
 *   'api_key' / 'apikey' / 'access_key' / 'private_key' / 'ssh'.
 * - short, ambiguous names (pass, pin, pat, ...) live in REDACT_KEY_TOKENS
 *   instead, where they only match whole key tokens.
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
  'bearer',
  'signature',
  'mnemonic',
  'certificate',
  'ssh',
  'dsn',
  'connection_string',
  'conn_str',
]

/**
 * Sensitive names that are too short or too ambiguous for substring matching.
 * These are compared against whole key *tokens* (split on separators and
 * camelCase), so 'pin' matches `user_pin` / `userPin` but not `ping`, and
 * 'pat' matches `github_pat` but not `path` or `patch`.
 */
export const REDACT_KEY_TOKENS: readonly string[] = [
  'pass',
  'pwd',
  'jwt',
  'otp',
  'pin',
  'mfa',
  'salt',
  'seed',
  'pem',
  'pat',
  'sig',
]

/**
 * Regex patterns matched against string values. The whole match is replaced
 * by REDACTED_PLACEHOLDER, so each pattern must span exactly the secret (plus
 * any label that is safe to lose).
 *
 * Order matters:
 * - PEM blocks first, so their body is never partially rewritten.
 * - Bearer/Basic and other well-shaped tokens before the generic
 *   `label: value` pattern, which would otherwise stop at the first space and
 *   leave the tail of the secret behind.
 * All patterns are linear (no nested quantifiers) to stay ReDoS-free.
 */
export const REDACT_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[posu]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // `API_KEY=...`, `x-api-key: ...`, `password = ...` in headers, env dumps
  // and log lines. The value stops at whitespace, `&`, quotes and `;` so that
  // neighbouring query parameters and JSON syntax survive; the negative
  // lookahead keeps an already-redacted value from swallowing what follows.
  /(?:api[-_ ]?key|x-api-key|authorization|token|secret|password|passwd)\s*[:=]\s*(?!\[REDACTED\])[^\s&"',;]+/gi,
]

/** A value pattern that redacts only part of its match, via `$n` back-references. */
export interface PartialValueRule {
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * Patterns where blanking the whole match would destroy useful, non-secret
 * context (host names, parameter names), so only the credential segment is
 * replaced. Applied before REDACT_VALUE_PATTERNS.
 */
export const REDACT_PARTIAL_VALUE_PATTERNS: readonly PartialValueRule[] = [
  // scheme://user:pass@host -> scheme://[REDACTED]@host
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: '$1[REDACTED]@' },
  // ?api_key=secret&next=1 -> ?api_key=[REDACTED]&next=1
  {
    pattern: /([?&](?:api[-_]?key|access_token|token|secret|password)=)[^&\s"']+/gi,
    replacement: '$1[REDACTED]',
  },
]

/** Replacement placeholder written to the journal instead of a secret. */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** Appended to a payload that was cut down to MAX_INVALID_PAYLOAD_CHARS. */
export const PAYLOAD_TRUNCATION_MARKER = '…[TRUNCATED]'

/**
 * Max characters kept for a payload that is raw text rather than parsed JSON
 * (unparseable lines, oversize framer flushes, stderr). Without this cap a
 * single MAX_LINE_BUFFER_BYTES fragment would land in the journal whole.
 */
export const MAX_INVALID_PAYLOAD_CHARS = 4096

/**
 * Extra characters beyond MAX_INVALID_PAYLOAD_CHARS that the raw-text
 * redactor still scans, so a secret straddling the cut is matched in full
 * before the payload is trimmed. Scanning is bounded to this window rather
 * than the whole line because a MAX_LINE_BUFFER_BYTES flush would otherwise
 * block the proxy's event loop for seconds. Must comfortably exceed the
 * longest secret shape in REDACT_VALUE_PATTERNS; a truncated PEM body that
 * outgrows it is sealed separately.
 */
export const RAW_REDACTION_OVERLAP_CHARS = 8192

/**
 * Max length of a string value the redactor will try to re-parse as embedded
 * JSON, and how many embedded-JSON levels it will descend. Both bound the
 * work a hostile payload can force (deeply nested double-encoded JSON).
 */
export const MAX_EMBEDDED_JSON_CHARS = 64 * 1024
export const MAX_EMBEDDED_JSON_DEPTH = 3

/**
 * Max serialized length of a *valid* JSON payload kept in a journal record.
 * Well-formed 16 MB tool results (base64 images etc.) should not land in the
 * journal whole; over-limit payloads are stored truncated with a marker.
 */
export const MAX_VALID_PAYLOAD_CHARS = 256 * 1024

/**
 * Grace period after forwarding SIGTERM/SIGINT to the child before escalating
 * to SIGKILL, so a child that ignores signals cannot wedge the proxy.
 */
export const SIGKILL_ESCALATION_MS = 5000

/**
 * Max time to wait for the server→client relay to drain after the child has
 * exited. A client that stopped reading must not hold the proxy open forever.
 */
export const RELAY_DRAIN_TIMEOUT_MS = 5000

/** Max journal files read concurrently by listSessions. */
export const LIST_SESSIONS_CONCURRENCY = 8

/** Max time to keep an unanswered request id for duration correlation. */
export const REQUEST_CORRELATION_TTL_MS = 5 * 60 * 1000

/** Max unanswered requests tracked per session before the oldest are dropped. */
export const MAX_PENDING_REQUESTS = 10_000

/** Max buffered incomplete line size before the framer flushes it as-is. */
export const MAX_LINE_BUFFER_BYTES = 16 * 1024 * 1024
