import { LATEST_SESSIONFUL_PROTOCOL_VERSION } from '../protocol/mcp.js'
import { STATELESS_PROTOCOL_VERSION } from '../protocol/mcp-stateless.js'
import { POOL_TAG_DISCOVER, POOL_TAG_INITIALIZE } from './constants.js'
import { buildServerDiscover, readServerDiscoverResult } from './discover.js'
import {
  buildUpstreamInitialize,
  readUpstreamInitializeReply,
  UPSTREAM_INITIALIZED_LINE,
} from './initialize.js'

/**
 * How the plane introduces itself to one upstream of a pool (ADR-0015 §4 and
 * its 2026-09-23 amendment, RV1-RV2).
 *
 * A pool address answers the AGENT's `initialize` itself (PE12), so nothing
 * the agent sends reaches an upstream — the plane has to introduce itself, in
 * its own name, or a server that follows the spec refuses every request that
 * follows. This is also where PE3 is enforced: the plane declares no client
 * capabilities, on either revision.
 *
 * The handshake goes FIRST, even to a stdio server, where the spec says a
 * client SHOULD try `server/discover` first. A deliberate departure: every
 * public server checked (26) answers `initialize`, dual-mode ones included;
 * servers built on rmcp EXIT on any request before `initialize`; and old
 * servers answer an early discover in four different ways, one of them
 * HTTP 200 + `-32601`. Asking the handshake first costs a server that speaks
 * only the new revision one extra exchange, and costs everyone else nothing.
 *
 * Every failure is a server that did not come up — the caller opens the pool
 * without it (PE6) — and the whole negotiation shares ONE deadline (BU1): the
 * second step gets what is left, not a fresh budget.
 */

/** Which negotiation a registry record asks for (RV1). */
export type UpstreamRevisionHint = 'legacy-first' | 'sessionful-only' | 'stateless-only'

/** How the pool must speak to a member from now on. */
export type PoolMemberDiscipline =
  | { readonly model: 'sessionful'; readonly protocolVersion: string }
  | { readonly model: 'stateless'; readonly protocolVersion: typeof STATELESS_PROTOCOL_VERSION }

export type NegotiationOutcome =
  | { readonly ok: true; readonly discipline: PoolMemberDiscipline }
  | { readonly ok: false; readonly reason: 'start-timeout' | 'handshake-failed' }

/** One request in the plane's own name, with this step's budget; `null` = no answer. */
export type UpstreamAsk = (
  tag: string,
  buildLine: (id: string) => string,
  timeoutMs: number,
) => Promise<string | null>

export interface NegotiateInput {
  readonly ask: UpstreamAsk
  /** Writes one notification line to the member, unstamped. */
  readonly notify: (line: string) => Promise<void>
  readonly hint: UpstreamRevisionHint
  readonly deadline: number
  readonly now: () => number
  readonly planeVersion: string
}

type Failure = Extract<NegotiationOutcome, { ok: false }>

const HANDSHAKE_FAILED: Failure = { ok: false, reason: 'handshake-failed' }

export async function negotiateUpstream(input: NegotiateInput): Promise<NegotiationOutcome> {
  if (input.hint === 'stateless-only') {
    // ADR-0002: an `initialize` to a server registered as stateless would be
    // a request its revision does not have.
    return discover(input)
  }
  const raw = await input.ask(
    POOL_TAG_INITIALIZE,
    (id) => buildUpstreamInitialize(id, LATEST_SESSIONFUL_PROTOCOL_VERSION, input.planeVersion),
    remaining(input),
  )
  if (raw === null) return noAnswer(input)

  const reply = readUpstreamInitializeReply(raw)
  if (reply.kind === 'sessionful') {
    // The notification that closes the handshake. A server that ignores it
    // is still a server the plane can list.
    await input.notify(UPSTREAM_INITIALIZED_LINE)
    return { ok: true, discipline: { model: 'sessionful', protocolVersion: reply.info.protocolVersion } }
  }
  if (reply.kind === 'unreadable' || input.hint === 'sessionful-only') {
    return HANDSHAKE_FAILED
  }
  // An error, or a revision with no handshake: ask the new way.
  return discover(input)
}

async function discover(input: NegotiateInput): Promise<NegotiationOutcome> {
  const raw = await input.ask(
    POOL_TAG_DISCOVER,
    (id) => buildServerDiscover(id, input.planeVersion),
    remaining(input),
  )
  if (raw === null) return noAnswer(input)
  return readServerDiscoverResult(raw) === null
    ? HANDSHAKE_FAILED
    : { ok: true, discipline: { model: 'stateless', protocolVersion: STATELESS_PROTOCOL_VERSION } }
}

/** What is left of the one deadline; never negative. */
function remaining(input: NegotiateInput): number {
  return Math.max(0, input.deadline - input.now())
}

/** No answer is a timeout only once the deadline has passed; before, the ask gave up. */
function noAnswer(input: NegotiateInput): Failure {
  return input.now() >= input.deadline ? { ok: false, reason: 'start-timeout' } : HANDSHAKE_FAILED
}
