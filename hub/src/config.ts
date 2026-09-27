import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { z } from 'zod'

/**
 * The hub's own configuration (plan `hub-signin-accounts`, Task 2): env vars
 * only — the hub is a separate process on `mcpcut.com` (ADR-0017 phase 2), not
 * an install, so it never reads `~/.mcpcut/config.json` or anything under
 * `src/setup/**` (that would be a second door into an install's state, the
 * exact thing `tests/architecture/hub-imports.test.ts` (H1) forbids).
 *
 * `loadHubConfig` never throws: it returns every problem it found as one line
 * per issue (the shape `formatInstallConfigErrors` fixed in `src/setup/schema.ts`),
 * so the caller (`hub/src/cli.ts`, Task 5) is the one that prints them and exits
 * — "fail fast" belongs to the entry point, not to a module that is also unit
 * tested.
 */

/** Upper bound on how many accounts the hosted service will ever seat at once
 * (HA3: shared host, 15 today). Generous enough that a future host move never
 * needs a code change, tight enough that a typo (`HUB_MAX_ACCOUNTS=15000`)
 * cannot silently promise capacity the host does not have. */
const MAX_ACCOUNTS_BOUND = 1000
/** Upper bound on the GitHub-account-age gate (HA12: 30 days today). */
const MAX_ACCOUNT_AGE_DAYS_BOUND = 3650
/** Upper bound on the per-IP signup rate (HA12: 3/hour today). */
const MAX_SIGNUPS_PER_HOUR_BOUND = 10_000
const MAX_TCP_PORT = 65535
/** Generous ceiling on every free-text env value, so a malformed environment
 * cannot make this process hold megabytes of string before validation fails
 * it anyway. */
const MAX_ENV_STRING_LENGTH = 4096

/**
 * `https://host[:port]` and nothing else — no path, query, fragment or
 * userinfo. Mirrors `PUBLIC_ORIGIN_PATTERN` (`src/setup/constants.ts`) except
 * the scheme: the hub only ever runs behind Cloudflare + Caddy TLS (H6/H5),
 * so `http://` is refused here rather than merely discouraged.
 */
const HUB_PUBLIC_URL_PATTERN = /^https:\/\/[^\s/\\?#@]+$/i

/** A real domain name (at least one dot) — `mcpcut.com`, not a bare label. */
const HUB_TENANT_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i

const boundedString = z
  .string({ error: 'is required' })
  .min(1, 'is required')
  .max(MAX_ENV_STRING_LENGTH, 'is too long')

/** `'0'` or `'1'`, defaulting to `'0'`, coerced to a boolean. Anything else —
 * `'true'`, `'yes'`, empty string — is refused rather than guessed at: a
 * mistyped flag that silently means "off" is exactly how `HUB_TRUST_CF_CONNECTING_IP`
 * would end up trusting a spoofable header (H6/HA12) without anyone noticing. */
function booleanFlagField(defaultValue: '0' | '1') {
  return z
    .string()
    .refine((value) => value === '0' || value === '1', 'must be "0" or "1"')
    .optional()
    .default(defaultValue)
    .transform((value) => value === '1')
}

/** An integer env var with a default, applied when the var is unset — never
 * when it is present but unparsable, so `HUB_MAX_ACCOUNTS=fifteen` is a
 * config error, not a silent fallback to 15. */
function intEnvField(defaultValue: number, min: number, max: number) {
  const message = `must be an integer between ${min} and ${max}`
  return z.coerce.number({ error: message }).int(message).min(min, message).max(max, message)
}

const rawHubConfigSchema = z.object({
  HUB_PUBLIC_URL: boundedString.regex(
    HUB_PUBLIC_URL_PATTERN,
    'must be an https origin: https://host[:port], no path',
  ),
  HUB_TENANT_DOMAIN: boundedString
    .regex(HUB_TENANT_DOMAIN_PATTERN, 'must be a domain name, e.g. mcpcut.com')
    .optional()
    .default('mcpcut.com'),
  HUB_GITHUB_CLIENT_ID: boundedString,
  HUB_GITHUB_CLIENT_SECRET_FILE: boundedString,
  HUB_DATA_DIR: boundedString,
  HUB_HOST: boundedString.optional().default('127.0.0.1'),
  HUB_PORT: intEnvField(8092, 0, MAX_TCP_PORT).optional().default(8092),
  HUB_MAX_ACCOUNTS: intEnvField(15, 1, MAX_ACCOUNTS_BOUND).optional().default(15),
  HUB_MIN_ACCOUNT_AGE_DAYS: intEnvField(30, 0, MAX_ACCOUNT_AGE_DAYS_BOUND).optional().default(30),
  HUB_SIGNUPS_PER_HOUR_PER_IP: intEnvField(3, 1, MAX_SIGNUPS_PER_HOUR_BOUND)
    .optional()
    .default(3),
  HUB_TRUST_CF_CONNECTING_IP: booleanFlagField('0'),
})

/** The hub's fully validated configuration. */
export interface HubConfig {
  /** The `https://…` origin the hub itself is reached at (behind Caddy). */
  readonly publicUrl: string
  /** The tenant domain accounts get a subdomain of, e.g. `mcpcut.com`. */
  readonly tenantDomain: string
  readonly githubClientId: string
  /**
   * The GitHub OAuth App's client secret, read once from
   * `HUB_GITHUB_CLIENT_SECRET_FILE` — never accepted in the environment
   * (a process's env is visible to `/proc`, crash reporters and child
   * processes far more readily than a 0600 file is). Never logged, never
   * serialized: callers pass it straight to `github.ts`'s token exchange.
   */
  readonly githubClientSecret: string
  readonly dataDir: string
  readonly host: string
  readonly port: number
  /** HA3: total accounts the shared host may seat at once. */
  readonly maxAccounts: number
  /** HA12: a GitHub account younger than this is refused at signup. */
  readonly minAccountAgeDays: number
  /** HA12: signups accepted from one IP address per rolling hour. */
  readonly signupsPerHourPerIp: number
  /**
   * Whether `CF-Connecting-IP` may be trusted as the client's real address
   * (H6). Must be `true` only when the hub is unreachable except through
   * Caddy — a direct connection to the origin can set this header to
   * anything and walk straight through the per-IP rate limit otherwise.
   */
  readonly trustCfConnectingIp: boolean
}

export type HubConfigLoad =
  | { readonly kind: 'ok'; readonly config: HubConfig }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }

/** Minimal `fs.Stats` surface the permission check needs; real `statSync` satisfies it. */
export interface SecretFileStat {
  isFile(): boolean
  readonly mode: number
}

export interface LoadHubConfigOptions {
  /** Environment to read the `HUB_*` vars from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Stat seam for the client-secret file. Defaults to `node:fs`'s `statSync`. */
  readonly statSecretFile?: (path: string) => SecretFileStat
  /** Read seam for the client-secret file. Defaults to `node:fs`'s `readFileSync`. */
  readonly readSecretFile?: (path: string) => string
}

/** Bits allowed on the client-secret file: owner read/write, nothing else. */
const SECRET_FILE_ALLOWED_MODE_BITS = 0o600

/**
 * Resolves and validates every `HUB_*` env var, including reading and
 * permission-checking the GitHub client secret file. Every problem found —
 * env var and secret file alike — is collected and returned together, so a
 * misconfigured operator sees the whole list on one run rather than fixing
 * issues one at a time.
 */
export function loadHubConfig(options: LoadHubConfigOptions = {}): HubConfigLoad {
  const env = options.env ?? process.env
  const raw = {
    HUB_PUBLIC_URL: env.HUB_PUBLIC_URL,
    HUB_TENANT_DOMAIN: env.HUB_TENANT_DOMAIN,
    HUB_GITHUB_CLIENT_ID: env.HUB_GITHUB_CLIENT_ID,
    HUB_GITHUB_CLIENT_SECRET_FILE: env.HUB_GITHUB_CLIENT_SECRET_FILE,
    HUB_DATA_DIR: env.HUB_DATA_DIR,
    HUB_HOST: env.HUB_HOST,
    HUB_PORT: env.HUB_PORT,
    HUB_MAX_ACCOUNTS: env.HUB_MAX_ACCOUNTS,
    HUB_MIN_ACCOUNT_AGE_DAYS: env.HUB_MIN_ACCOUNT_AGE_DAYS,
    HUB_SIGNUPS_PER_HOUR_PER_IP: env.HUB_SIGNUPS_PER_HOUR_PER_IP,
    HUB_TRUST_CF_CONNECTING_IP: env.HUB_TRUST_CF_CONNECTING_IP,
  }

  const parsed = rawHubConfigSchema.safeParse(raw)
  const problems = parsed.success ? [] : formatIssues(parsed.error)

  // The secret file is only worth checking once the var naming it is itself
  // a valid, non-empty string; otherwise its problem is already listed above.
  const secretFilePath = parsed.success ? parsed.data.HUB_GITHUB_CLIENT_SECRET_FILE : undefined
  const secret =
    secretFilePath === undefined ? undefined : readClientSecretFile(secretFilePath, options)
  if (secret !== undefined && !secret.ok) problems.push(secret.problem)

  if (!parsed.success || secret === undefined || !secret.ok) {
    return { kind: 'invalid', problems }
  }

  const data = parsed.data
  return {
    kind: 'ok',
    config: {
      publicUrl: data.HUB_PUBLIC_URL,
      tenantDomain: data.HUB_TENANT_DOMAIN,
      githubClientId: data.HUB_GITHUB_CLIENT_ID,
      githubClientSecret: secret.value,
      dataDir: data.HUB_DATA_DIR,
      host: data.HUB_HOST,
      port: data.HUB_PORT,
      maxAccounts: data.HUB_MAX_ACCOUNTS,
      minAccountAgeDays: data.HUB_MIN_ACCOUNT_AGE_DAYS,
      signupsPerHourPerIp: data.HUB_SIGNUPS_PER_HOUR_PER_IP,
      trustCfConnectingIp: data.HUB_TRUST_CF_CONNECTING_IP,
    },
  }
}

type SecretFileRead = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string }

/**
 * Reads the GitHub client secret from `path`, refusing a file that does not
 * exist, is not a regular file, or grants any permission bit beyond owner
 * read/write (H4: the secret is never accepted in the environment, so the
 * file is its only copy at rest and must not be group- or world-readable).
 */
function readClientSecretFile(path: string, options: LoadHubConfigOptions): SecretFileRead {
  const statSync = options.statSecretFile ?? fsStatSync
  const readFileSync = options.readSecretFile ?? ((p: string) => fsReadFileSync(p, 'utf8'))

  let stats: SecretFileStat
  try {
    stats = statSync(path)
  } catch (error: unknown) {
    return {
      ok: false,
      problem: `HUB_GITHUB_CLIENT_SECRET_FILE: could not stat "${path}": ${describeError(error)}`,
    }
  }
  if (!stats.isFile()) {
    return { ok: false, problem: `HUB_GITHUB_CLIENT_SECRET_FILE: "${path}" is not a regular file` }
  }
  const excessBits = (stats.mode & 0o777) & ~SECRET_FILE_ALLOWED_MODE_BITS
  if (excessBits !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0')
    return {
      ok: false,
      problem:
        `HUB_GITHUB_CLIENT_SECRET_FILE: "${path}" has mode 0${mode}, wider than the required 0600 ` +
        '(owner read/write only)',
    }
  }

  let text: string
  try {
    text = readFileSync(path)
  } catch (error: unknown) {
    return {
      ok: false,
      problem: `HUB_GITHUB_CLIENT_SECRET_FILE: could not read "${path}": ${describeError(error)}`,
    }
  }
  const value = text.trim()
  if (value.length === 0) {
    return { ok: false, problem: `HUB_GITHUB_CLIENT_SECRET_FILE: "${path}" is empty` }
  }
  return { ok: true, value }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Renders a `z.ZodError` as one line per issue: `HUB_FOO: message`, matching
 * `formatInstallConfigErrors` (`src/setup/schema.ts`) — the shape this
 * codebase already uses for "every problem an operator needs to fix, on its
 * own line".
 */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}
