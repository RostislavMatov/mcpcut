/**
 * The 2026-07-28 revision of MCP, as far as the plane speaks it: the version
 * literal, `server/discover`, and the `_meta` every request to such a server
 * MUST carry (spec `basic/index#meta`).
 *
 * A sibling of `mcp.ts` under the same rule — together they are the single
 * point of coupling to the spec — split off only for the 400-line cap. The
 * plane speaks this revision in exactly one role: as a CLIENT of a pool member
 * that serves it (ADR-0015 amendment 2026-09-23, RV1-RV3). A stateless AGENT
 * at a pool address remains a second wave (PE3).
 *
 * Every export here is pure and never throws.
 */

/** The stateless revision: no handshake, `_meta` on every request. */
export const STATELESS_PROTOCOL_VERSION = '2026-07-28'

/** What a 2026-07-28 server answers instead of `initialize` (spec `server/discover`). */
export const SERVER_DISCOVER_METHOD = 'server/discover'

/** `params._meta` key carrying the stateless protocol version (MUST on every request). */
export const META_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'

/** `params._meta` key carrying the client's capabilities (MUST; `{}` = none). */
export const META_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

/** `params._meta` key carrying the client's name and version (SHOULD). */
export const META_CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo'

/**
 * `result.resultType` of a finished result. The 2026-07-28 revision puts a
 * `resultType` on every result; absent means this value, and any other value
 * (`input_required`, or one the plane does not know) is NOT a finished result.
 */
export const RESULT_TYPE_COMPLETE = 'complete'

/** Who the plane says it is to a stateless server. */
export interface StatelessClientMeta {
  readonly name: string
  readonly version: string
}

/**
 * `raw` with the three `_meta` keys of a 2026-07-28 client added, or `null`
 * when `raw` is not a request or notification (no string `method`).
 *
 * The three keys are OVERWRITTEN with the plane's values: it is the plane that
 * speaks to the member, not the agent, and an agent's own `protocolVersion`
 * or declared capabilities would be a claim the plane never made. Every other
 * field — of the frame, of `params`, of `_meta` (an agent's `progressToken`) —
 * is carried over unchanged. `clientCapabilities: {}` is load-bearing in the
 * same way as the handshake's (PE3): no sampling, elicitation or roots.
 */
export function withStatelessMeta(raw: string, client: StatelessClientMeta): string | null {
  const parsed = tryParseObject(raw)
  if (parsed === null || typeof parsed['method'] !== 'string') {
    return null
  }
  const params = isPlainObject(parsed['params']) ? parsed['params'] : {}
  const meta = isPlainObject(params['_meta']) ? params['_meta'] : {}
  return JSON.stringify({
    ...parsed,
    params: {
      ...params,
      _meta: {
        ...meta,
        [META_PROTOCOL_VERSION_KEY]: STATELESS_PROTOCOL_VERSION,
        [META_CLIENT_CAPABILITIES_KEY]: {},
        [META_CLIENT_INFO_KEY]: { name: client.name, version: client.version },
      },
    },
  })
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
