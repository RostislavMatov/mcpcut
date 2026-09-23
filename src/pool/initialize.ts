import {
  INITIALIZE_METHOD,
  INITIALIZED_NOTIFICATION,
  LATEST_SESSIONFUL_PROTOCOL_VERSION,
  SESSIONFUL_PROTOCOL_VERSIONS,
} from '../protocol/mcp.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import { POOL_SERVER_INFO_NAME, POOL_UPSTREAM_CLIENT_NAME } from './constants.js'
import { isPlainObject, tryParseObject } from './json.js'

/**
 * The `initialize` handshake of a pool address (ADR-0015 §4), on both sides:
 * the plane answers the agent itself, and opens a handshake of its own to
 * every upstream.
 *
 * This is where ADR-0002 §4 ("the plane forwards protocolVersion and never
 * substitutes it") stops applying — and only here. At a pool address there is
 * no single upstream whose answer could be forwarded, so the plane is the
 * server. Per-server addresses are untouched.
 *
 * `planeVersion` is a parameter rather than a constant: there is no version
 * literal under `src/`, and this module must not read `package.json`.
 */

/** Capabilities the pool declares: exactly the first-version scope of PE3. */
const POOL_CAPABILITIES = {
  tools: { listChanged: true },
  prompts: { listChanged: true },
} as const

/**
 * The revision to answer with: the requested one when the plane supports it,
 * otherwise the newest it supports. Anything that is not a supported revision
 * string — including the stateless 2026-07-28, which has no handshake at all —
 * takes the fallback.
 */
export function negotiatePoolVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LATEST_SESSIONFUL_PROTOCOL_VERSION
  return SESSIONFUL_PROTOCOL_VERSIONS.find((version) => version === requested) ?? LATEST_SESSIONFUL_PROTOCOL_VERSION
}

/**
 * Pulls `params.protocolVersion` out of an agent's `initialize` request,
 * unnarrowed: judging it is `negotiatePoolVersion`'s single job.
 */
export function readRequestedVersion(raw: string): unknown {
  const parsed = tryParseObject(raw)
  if (parsed === null) return undefined

  const params = parsed['params']
  return isPlainObject(params) ? params['protocolVersion'] : undefined
}

/** The plane's own `initialize` result, framed and ready for the agent. */
export function synthesizeInitializeResult(
  id: SynthesizableId,
  requested: unknown,
  planeVersion: string,
): Buffer {
  const body = {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: negotiatePoolVersion(requested),
      capabilities: POOL_CAPABILITIES,
      serverInfo: { name: POOL_SERVER_INFO_NAME, version: planeVersion },
    },
  }

  return Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
}

/**
 * The handshake the plane opens to one upstream. `capabilities: {}` is
 * load-bearing, not tidiness: a server told of no sampling, elicitation or
 * roots will not initiate any (PE3), and what arrives regardless is dropped
 * with a journal record rather than reaching an agent that never offered them.
 *
 * Returned as a line WITHOUT framing — that belongs to the transport.
 */
export function buildUpstreamInitialize(
  id: string,
  protocolVersion: string,
  planeVersion: string,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: INITIALIZE_METHOD,
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: POOL_UPSTREAM_CLIENT_NAME, version: planeVersion },
    },
  })
}

/** The notification that closes the plane's own handshake with an upstream. */
export const UPSTREAM_INITIALIZED_LINE: string = JSON.stringify({
  jsonrpc: '2.0',
  method: INITIALIZED_NOTIFICATION,
})

/** What the plane keeps from an upstream's `initialize` result. */
export interface UpstreamInitializeInfo {
  readonly protocolVersion: string
  readonly hasTools: boolean
  readonly hasPrompts: boolean
}

/**
 * How one upstream answered the plane's `initialize` (RV2):
 *
 *  - `sessionful` — a revision the plane has a handshake for;
 *  - `other-revision` — a result naming any other revision (2026-07-28, or a
 *    future one): not a server that is down, but one to ask `server/discover`;
 *  - `error` — a JSON-RPC error: a server that speaks only the new revision
 *    answers the handshake this way (`-32022`), and any error at all leads to
 *    discover, because the spec forbids keying the fallback to one code;
 *  - `unreadable` — anything else, which is a server that did not come up.
 */
export type UpstreamInitializeReply =
  | { readonly kind: 'sessionful'; readonly info: UpstreamInitializeInfo }
  | { readonly kind: 'other-revision'; readonly protocolVersion: string }
  | { readonly kind: 'error' }
  | { readonly kind: 'unreadable' }

export function readUpstreamInitializeReply(raw: string): UpstreamInitializeReply {
  const parsed = tryParseObject(raw)
  if (parsed === null) return { kind: 'unreadable' }

  const result = parsed['result']
  if (!isPlainObject(result)) {
    return 'error' in parsed ? { kind: 'error' } : { kind: 'unreadable' }
  }

  const protocolVersion = result['protocolVersion']
  if (typeof protocolVersion !== 'string') return { kind: 'unreadable' }
  if (!SESSIONFUL_PROTOCOL_VERSIONS.some((version) => version === protocolVersion)) {
    return { kind: 'other-revision', protocolVersion }
  }

  const capabilities = result['capabilities']
  const declared = isPlainObject(capabilities) ? capabilities : {}

  return {
    kind: 'sessionful',
    info: {
      protocolVersion,
      hasTools: isPlainObject(declared['tools']),
      hasPrompts: isPlainObject(declared['prompts']),
    },
  }
}
