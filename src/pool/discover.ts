import {
  SERVER_DISCOVER_METHOD,
  STATELESS_PROTOCOL_VERSION,
  withStatelessMeta,
} from '../protocol/mcp-stateless.js'
import { POOL_UPSTREAM_CLIENT_NAME } from './constants.js'
import { isPlainObject, tryParseObject } from './json.js'

/**
 * `server/discover`: what the plane asks a pool member that did not take its
 * handshake (ADR-0015 amendment 2026-09-23, RV1-RV2). The handshake always
 * goes first: every public server checked answers `initialize`, a server that
 * speaks only the new revision answers it with an error, and some old servers
 * exit on any request before `initialize`.
 *
 * Returned as a line WITHOUT framing — that belongs to the transport.
 */

/** What the plane keeps from a stateless member's `server/discover` result. */
export interface StatelessMemberInfo {
  readonly hasTools: boolean
  readonly hasPrompts: boolean
}

/** The discover request, stamped with the `_meta` the revision requires. */
export function buildServerDiscover(id: string, planeVersion: string): string {
  const line = JSON.stringify({ jsonrpc: '2.0', id, method: SERVER_DISCOVER_METHOD, params: {} })
  // Cannot be null — the line above is a request by construction — but a
  // silent fallback would send a request the server MUST refuse.
  return withStatelessMeta(line, { name: POOL_UPSTREAM_CLIENT_NAME, version: planeVersion }) ?? line
}

/**
 * Reads a `server/discover` result. `null` unless `supportedVersions` is an
 * array that names 2026-07-28 and `capabilities` is an object: a server that
 * speaks neither the handshake nor this revision is one the plane cannot use,
 * and opening the pool without it is the fail-closed direction.
 *
 * `supportedVersions` is unreliable as "the ONLY revision" (dual-mode servers
 * name only the new one and still take the handshake) but reliable as "one I
 * speak". A hostile server may make it enormous: it is searched in place and
 * never copied or echoed.
 */
export function readServerDiscoverResult(raw: string): StatelessMemberInfo | null {
  const parsed = tryParseObject(raw)
  if (parsed === null) return null

  const result = parsed['result']
  if (!isPlainObject(result)) return null

  const versions = result['supportedVersions']
  if (!Array.isArray(versions) || !versions.includes(STATELESS_PROTOCOL_VERSION)) return null

  const capabilities = result['capabilities']
  if (!isPlainObject(capabilities)) return null

  return {
    hasTools: isPlainObject(capabilities['tools']),
    hasPrompts: isPlainObject(capabilities['prompts']),
  }
}
