import { stripControlChars } from '../../journal/format.js'
import { MAX_WITHDRAW_REASON_CHARS } from '../constants.js'

/**
 * Why a request was withdrawn (decision M36): the agent stopped waiting, so
 * the request closes and nothing is sent. Three ways to leave are told apart
 * on the record — the client's own cancel carries its `params.reason`
 * (`AbortError: user-cancel` on Esc, `SdkError: Request timed out` on its own
 * timeout in Claude Code), a closed connection is `disconnected`, and a
 * process that died holding the request is `process-lost` (the heartbeat
 * sweep).
 */

/** The connection to the agent closed (stdio EOF, session teardown) while the call was held. */
export const WITHDRAW_REASON_DISCONNECTED = 'disconnected'

/** The process holding the request stopped refreshing its heartbeat (crash backstop). */
export const WITHDRAW_REASON_PROCESS_LOST = 'process-lost'

/** What a cancel that named no usable reason records. */
export const WITHDRAW_REASON_CANCELLED = 'cancelled'

/**
 * The client-chosen reason of a cancel, made safe to store: control and
 * invisible characters removed, length capped. Anything that is not a
 * non-empty string after cleaning reads as `cancelled` — the cancel itself is
 * the fact, its wording only a detail.
 */
export function cleanWithdrawReason(raw: unknown): string {
  if (typeof raw !== 'string') return WITHDRAW_REASON_CANCELLED
  const cleaned = stripControlChars(raw).slice(0, MAX_WITHDRAW_REASON_CHARS).trim()
  return cleaned === '' ? WITHDRAW_REASON_CANCELLED : cleaned
}
