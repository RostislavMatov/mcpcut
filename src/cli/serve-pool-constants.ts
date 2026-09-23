/**
 * Refusal codes and stderr texts of the agent pool address (ADR-0015 phase 3).
 * Its own file for the same reason `serve-constants.ts` is: the pool adds
 * refusals of its own, and the per-server list must stay readable as a list.
 */

/**
 * A pool POST that is not an `initialize`. The first version of the pool is
 * sessionful-only (PE3): the plane answers the handshake itself and holds the
 * children behind the session it opens. A stateless agent has no session to
 * hold them, which is a second wave rather than a variation.
 */
export const REFUSAL_POOL_SESSIONFUL_ONLY = 'pool-sessionful-only'

/**
 * The agent vanished or was revoked between the front's token check and the
 * pool opening. Deliberately the SAME code a per-server address gives an
 * agent with no grant: whether this installation serves a pool at all is not
 * something an unauthorized caller gets to learn.
 */
export const REFUSAL_POOL_NO_AGENT = 'no-grant'

/** Stderr line when the plane could not tell which session model a POST wanted. */
export const POOL_MODEL_UNDETECTED_MESSAGE =
  'the downstream session model could not be determined; refusing'

/** Stderr line when an agent addressed the pool without a handshake. */
export const POOL_STATELESS_MESSAGE =
  'a pool address serves sessionful agents only; send initialize first'

/**
 * The stderr line for a start that did not produce a member (BU3), or `null`
 * for a refusal that is not about starting (a full pool, an unknown server —
 * those already say what they are in the journal). Three different lines
 * because they send the operator to three different remedies: a faster
 * command (an installed binary rather than `npx`), a broken command, or a
 * server that speaks no revision the plane does.
 */
export function startRefusalLine(server: string, reason: string, startTimeoutMs: number): string | null {
  if (reason === 'start-timeout') {
    return `server ${server} did not start within ${Math.round(startTimeoutMs / 1000)} s`
  }
  if (reason === 'ended-during-start') return `server ${server} ended before it started`
  if (reason === 'handshake-failed') return `server ${server} did not complete the handshake`
  return null
}
