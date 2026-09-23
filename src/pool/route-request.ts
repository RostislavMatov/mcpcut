import { PROMPTS_GET_METHOD, TOOLS_CALL_METHOD } from '../protocol/mcp.js'
import { synthesizeError, type SynthesizableId } from '../proxy/synthesize.js'
import { ERROR_CODE_UNKNOWN_POOL_TARGET } from './constants.js'
import { safeNameOf } from './errors.js'
import { isPlainObject, tryParseObject } from './json.js'
import { decodePoolName } from './name-codec.js'

/**
 * Routing of one agent request at a pool address: which child session it
 * belongs to, and the same frame with the server prefix removed (ADR-0015 §2).
 *
 * The stripping happens BEFORE the frame reaches a child session, which is
 * what lets every enforcement module downstream stay untouched — `Mcp-Name` is
 * derived from these rewritten bytes, so the header mirrors the bare name by
 * construction rather than by a second rule.
 *
 * A frame this module cannot read yields `null`. The caller answers it with a
 * synthesized error; it must never fall back to forwarding an unexamined frame
 * to "some" server.
 *
 * What survives the rewrite is every FIELD, not every byte: the frame goes
 * through `JSON.parse`/`JSON.stringify`, which normalizes numbers (integers
 * past `Number.MAX_SAFE_INTEGER` round, `-0` becomes `0`, `1.50` becomes
 * `1.5`) and collapses duplicate keys. `proxy/tools-filter.ts` has always done
 * the same to list responses; ADR-0015 §9 states the limit explicitly rather
 * than letting "byte-identical" be read as a promise this path cannot keep.
 */

/** The two methods that carry a pool-prefixed name in `params.name`. */
const ADDRESSED_METHODS: ReadonlySet<string> = new Set([TOOLS_CALL_METHOD, PROMPTS_GET_METHOD])

export type PoolRouteOutcome =
  /** Belongs to `server`; `serialized` is the frame to hand the child session. */
  | { readonly kind: 'routed'; readonly server: string; readonly name: string; readonly serialized: string }
  /** No separator, or a server this agent's pool does not contain. */
  | { readonly kind: 'unknown-target'; readonly poolName: string }
  /** A method that carries no pool name (`tools/list`, `ping`, …). */
  | { readonly kind: 'not-addressed' }

/**
 * `isPoolMember` answers for the pool of the agent this session belongs to.
 * A server outside it is reported exactly like one that does not exist: the
 * agent must not be able to enumerate the installation through error replies.
 */
export function routePoolRequest(
  raw: string,
  isPoolMember: (server: string) => boolean,
): PoolRouteOutcome | null {
  const parsed = tryParseObject(raw)
  if (parsed === null) return null

  const method = parsed['method']
  if (typeof method !== 'string') return null
  if (!ADDRESSED_METHODS.has(method)) return { kind: 'not-addressed' }

  const params = parsed['params']
  if (!isPlainObject(params)) return null

  const poolName = params['name']
  if (typeof poolName !== 'string' || poolName.length === 0) return null

  const decoded = decodePoolName(poolName)
  if (decoded === null || !isPoolMember(decoded.server)) {
    return { kind: 'unknown-target', poolName }
  }

  const serialized = JSON.stringify({ ...parsed, params: { ...params, name: decoded.name } })
  if (serialized.includes('\n')) return null

  return { kind: 'routed', server: decoded.server, name: decoded.name, serialized }
}

/**
 * The single reply for every unroutable name. One message for "no separator"
 * and for "not in this pool" alike, because distinguishing them would tell the
 * agent which servers the installation holds outside its own grants.
 */
export function unknownTargetError(id: SynthesizableId, poolName: string): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_UNKNOWN_POOL_TARGET,
    message: `Unknown tool: ${safeNameOf(poolName)}`,
    data: { reason: 'unknown_pool_target', toolName: safeNameOf(poolName) },
  })
}
