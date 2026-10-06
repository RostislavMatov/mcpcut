import { pathMatchKey } from '../db/path-key.js'
import { hasTrashSegment, isWithinOn, segmentCount } from '../names.js'
import { INDEX_SKIP_DIR_NAMES } from './constants.js'
import type { IndexRule } from './index-rules-store.js'

/**
 * What is indexed, as pure decisions: which folder rule covers a file, and
 * which names are never read at all (ADR-0020 §6). The name filter is the
 * first of two defences — the second is the redaction of the text itself.
 */

export type SkipReason = 'secret-like name' | 'skipped folder'

export type PathMatcher = (absPath: string) => boolean

/**
 * The rules' keys are worked out once; the matcher then answers per path. The
 * deepest rule containing the path decides; no rule means not indexed.
 */
export function prepareIndexRules(rules: readonly Pick<IndexRule, 'path' | 'enabled'>[], platform: NodeJS.Platform): PathMatcher {
  const prepared = rules.map((rule) => {
    const key = pathMatchKey(rule.path, platform)
    return { key, depth: segmentCount(key), enabled: rule.enabled }
  })
  return (absPath) => {
    const key = pathMatchKey(absPath, platform)
    let best: { depth: number; enabled: boolean } | undefined
    for (const rule of prepared) {
      if (!isWithinOn(rule.key, key, platform)) continue
      if (best === undefined || rule.depth > best.depth) best = rule
    }
    return best?.enabled === true
  }
}

/** One-off form of {@link prepareIndexRules}. */
export function isIndexed(absPath: string, rules: readonly Pick<IndexRule, 'path' | 'enabled'>[], platform: NodeJS.Platform): boolean {
  return prepareIndexRules(rules, platform)(absPath)
}

const SECRET_EXACT: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  'credentials',
  'kubeconfig',
  '.envrc',
  '.yarnrc.yml',
  '.s3cfg',
  '.vault-token',
  'auth.json',
  '.dockercfg',
  'htpasswd',
  'hosts.yml',
  '.terraformrc',
  'api_keys.txt',
  'token.txt',
  'application_default_credentials.json',
])
const SECRET_PREFIXES: readonly string[] = ['.env.', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials.', 'secrets.']
const SECRET_SUFFIXES: readonly string[] = [
  '.env',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.crt',
  '.cer',
  '.der',
  '.csr',
  '.secret',
  '.secrets',
  '.tfvars',
  '.ovpn',
  '.p8',
  '.gpg',
  '.asc',
  '.ppk',
  'history',
]

function isSecretBasename(lower: string): boolean {
  if (SECRET_EXACT.has(lower)) return true
  if (SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  if (lower.includes('.tfstate') || lower.includes('.secret.') || lower.includes('.secrets.')) return true
  if (SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return lower.startsWith('service-account') && lower.endsWith('.json')
}

const splitSegments = (value: string): string[] => value.split(/[\\/]/).filter((segment) => segment !== '')

/** The first folder of `value` that is never indexed (its own name counts), or `null`. */
export function skippedSegmentOf(value: string): string | null {
  return splitSegments(value).find((segment) => INDEX_SKIP_DIR_NAMES.includes(segment.toLowerCase())) ?? null
}

/** Why a path relative to its root is never indexed, or `null`. A skipped folder in the root's own path counts too. */
export function skipReasonOfName(relPath: string, root = ''): SkipReason | null {
  if (skippedSegmentOf(root) !== null) return 'skipped folder'
  const segments = splitSegments(relPath)
  if (skippedSegmentOf(relPath) !== null || hasTrashSegment(relPath)) return 'skipped folder'
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  return isSecretBasename(base) ? 'secret-like name' : null
}
