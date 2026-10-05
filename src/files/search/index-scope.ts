import { pathMatchKey } from '../db/path-key.js'
import { isWithinOn, segmentCount } from '../names.js'
import { INDEX_SKIP_DIR_NAMES } from './constants.js'
import type { IndexRule } from './index-rules-store.js'

/**
 * What is indexed, as pure decisions: which folder rule covers a file, and
 * which names are never read at all (ADR-0020 §6). The name filter is the
 * first of two defences — the second is the redaction of the text itself.
 */

export type SkipReason = 'secret-like name' | 'skipped folder'

/** The deepest rule containing the path decides; no rule means not indexed. */
export function isIndexed(absPath: string, rules: readonly Pick<IndexRule, 'path' | 'enabled'>[], platform: NodeJS.Platform): boolean {
  const key = pathMatchKey(absPath, platform)
  let best: { depth: number; enabled: boolean } | undefined
  for (const rule of rules) {
    const ruleKey = pathMatchKey(rule.path, platform)
    if (!isWithinOn(ruleKey, key, platform)) continue
    const depth = segmentCount(ruleKey)
    if (best === undefined || depth > best.depth) best = { depth, enabled: rule.enabled }
  }
  return best?.enabled === true
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
  '.tfstate',
  '.tfvars',
  '.ovpn',
]

function isSecretBasename(lower: string): boolean {
  if (SECRET_EXACT.has(lower)) return true
  if (SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  if (SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return lower.startsWith('service-account') && lower.endsWith('.json')
}

/** Why a path relative to its root is never indexed, or `null`. */
export function skipReasonOfName(relPath: string): SkipReason | null {
  const segments = relPath.split(/[\\/]/).filter((segment) => segment !== '')
  if (segments.some((segment) => INDEX_SKIP_DIR_NAMES.includes(segment.toLowerCase()))) return 'skipped folder'
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  return isSecretBasename(base) ? 'secret-like name' : null
}
