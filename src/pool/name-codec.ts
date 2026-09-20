import { REGISTRY_SERVER_NAME_PATTERN } from '../registry/constants.js'
import {
  POOL_NAME_HIDE_ABOVE_CHARS,
  POOL_NAME_SEPARATOR,
  POOL_NAME_WARN_ABOVE_CHARS,
} from './constants.js'

/**
 * The name codec of the agent pool (ADR-0015 §2): the ONE place a server
 * prefix is attached or removed. The plane prefixes names when it merges
 * catalogs, and strips the prefix before a frame reaches a child session — so
 * policy, inventory, approvals, the journal and the `Mcp-Name` header all keep
 * seeing the bare tool name, exactly as in the per-server mode.
 *
 * Pure and total: an input it cannot read positively yields `null`, never an
 * exception and never a guess.
 */

/** A pool name split back into the server that owns it and its bare name. */
export interface DecodedPoolName {
  readonly server: string
  readonly name: string
}

/** How an encoded name sits against known client limits (PE2). */
export type PoolNameFit = 'ok' | 'warn' | 'hidden'

/**
 * Builds `<server>__<name>`. Returns `null` when `server` is not a registry
 * name or `name` is empty — rather than ever producing a name that could not
 * be decoded back unambiguously.
 */
export function encodePoolName(server: string, name: string): string | null {
  if (!REGISTRY_SERVER_NAME_PATTERN.test(server) || name.length === 0) {
    return null
  }
  return `${server}${POOL_NAME_SEPARATOR}${name}`
}

/**
 * Splits at the FIRST separator. Registry server names carry no `_`, so the
 * first occurrence is the one the plane wrote: a tool genuinely called
 * `other__drop` on server `a` decodes to `{server: 'a', name: 'other__drop'}`,
 * and a hostile server cannot address another one by naming its tools.
 *
 * `null` when there is no separator, when the prefix is not a registry name,
 * or when either half is empty.
 */
export function decodePoolName(poolName: string): DecodedPoolName | null {
  const at = poolName.indexOf(POOL_NAME_SEPARATOR)
  if (at <= 0) {
    return null
  }

  const server = poolName.slice(0, at)
  const name = poolName.slice(at + POOL_NAME_SEPARATOR.length)
  if (name.length === 0 || !REGISTRY_SERVER_NAME_PATTERN.test(server)) {
    return null
  }

  return { server, name }
}

/**
 * Classifies an ALREADY ENCODED name against the client limits of PE2.
 * Length is counted in UTF-16 units: spec tool names are ASCII, and a
 * non-ASCII name only ever gets longer downstream, so this errs safely.
 */
export function poolNameFit(poolName: string): PoolNameFit {
  if (poolName.length > POOL_NAME_HIDE_ABOVE_CHARS) {
    return 'hidden'
  }
  return poolName.length > POOL_NAME_WARN_ABOVE_CHARS ? 'warn' : 'ok'
}
