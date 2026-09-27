/**
 * GitHub login → hub subdomain (plan `hub-signin-accounts`, Task 2, HA1/HA4).
 * Pure: the caller injects "is this candidate already spoken for", so tests
 * never need a database and `signup-policy.ts`/`accounts-db.ts` stay the only
 * two places that know what "spoken for" means (a row in `accounts`, or a
 * name this hub reserves for itself).
 */

/** A DNS label: 1–63 chars, alphanumeric, hyphens only in the middle. */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** Longest a DNS label may be. */
const MAX_LABEL_LENGTH = 63

/**
 * Names this hub never hands out, whatever GitHub login asks for them: the
 * hub's own routes and infrastructure conventions a browser or admin would
 * reasonably expect to resolve to something else entirely.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'mcp',
  'api',
  'hub',
  'admin',
  'app',
  'mail',
  'smtp',
  'status',
  'docs',
  'blog',
  'auth',
  'account',
  'cdn',
  'static',
  'assets',
  'dev',
  'test',
  'staging',
  'ns1',
  'ns2',
])

/** Suffixes tried before giving up (`-2` through this bound). Generous: a
 * login this popular among distinct GitHub accounts never happens in a
 * 15-account service, but the loop must still terminate on hostile input. */
const MAX_SUFFIX_ATTEMPTS = 200

export class SubdomainExhaustedError extends Error {
  constructor(base: string) {
    super(`could not find a free subdomain for "${base}" after ${MAX_SUFFIX_ATTEMPTS} suffixes`)
    this.name = 'SubdomainExhaustedError'
  }
}

/**
 * Lowercases `login` and folds every character outside `[a-z0-9-]` to a
 * hyphen, collapses runs of hyphens, and trims leading/trailing ones. GitHub
 * logins are already `[A-Za-z0-9-]` and never start/end with a hyphen, so
 * this is a no-op for real profiles; it exists so a malformed or spoofed
 * `login` (untrusted external input — CLAUDE.md "never trust external data")
 * still yields a valid DNS label instead of a broken one.
 */
function foldToLabelAlphabet(login: string): string {
  return login
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Falls back to a stable placeholder when folding leaves nothing usable
 * (e.g. a login that is entirely non-ASCII) — the suffix loop then finds it
 * a free number, exactly as it would a real collision. */
const EMPTY_LOGIN_FALLBACK = 'user'

function baseSubdomainFrom(login: string): string {
  const folded = foldToLabelAlphabet(login)
  const base = folded.length > 0 ? folded : EMPTY_LOGIN_FALLBACK
  return base.length > MAX_LABEL_LENGTH ? trimToLabel(base.slice(0, MAX_LABEL_LENGTH)) : base
}

/** Re-applies the trim rules after a length cut, which can leave a trailing hyphen. */
function trimToLabel(candidate: string): string {
  const trimmed = candidate.replace(/-+$/g, '')
  return trimmed.length > 0 ? trimmed : EMPTY_LOGIN_FALLBACK
}

/** `base` with `-N` appended, cut back down to `MAX_LABEL_LENGTH` if needed. */
function withSuffix(base: string, suffix: number): string {
  const suffixText = `-${suffix}`
  const roomForBase = MAX_LABEL_LENGTH - suffixText.length
  const trimmedBase = base.length > roomForBase ? trimToLabel(base.slice(0, roomForBase)) : base
  return `${trimmedBase}${suffixText}`
}

export interface AssignSubdomainOptions {
  /** True when `candidate` is already in use by a different account. */
  readonly isOccupied: (candidate: string) => boolean
}

/**
 * Picks a free subdomain for a brand-new account: the login folded to a DNS
 * label, or that label with `-2`, `-3`, … appended when it is reserved or
 * already occupied. Never called for a returning account — an existing
 * account keeps its subdomain even if its GitHub `login` changes (`touch`
 * updates `login`, never `subdomain`).
 */
export function assignSubdomain(login: string, options: AssignSubdomainOptions): string {
  const base = baseSubdomainFrom(login)
  if (isFree(base, options)) return base

  for (let suffix = 2; suffix <= MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    const candidate = withSuffix(base, suffix)
    if (isFree(candidate, options)) return candidate
  }
  throw new SubdomainExhaustedError(base)
}

function isFree(candidate: string, options: AssignSubdomainOptions): boolean {
  return (
    LABEL_PATTERN.test(candidate) &&
    !RESERVED_SUBDOMAINS.has(candidate) &&
    !options.isOccupied(candidate)
  )
}
