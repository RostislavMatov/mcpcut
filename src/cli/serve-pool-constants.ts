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
