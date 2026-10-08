import { stripControlChars } from '../../journal/format.js'
import { redactString } from '../../redact/redact.js'
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
 * How much of a client-chosen reason is looked at before redaction: a bound on
 * the work, generous enough that redaction (which may shorten a long secret to
 * a short marker) cannot pull text from past this point into the stored cap.
 */
const REASON_SCAN_CHARS = MAX_WITHDRAW_REASON_CHARS * 16

/**
 * The client-chosen reason of a cancel, made safe to store and to show:
 * control and invisible characters removed, secrets redacted (the queue and
 * the CLI show it, not only the journal — review R8), length capped. The cap
 * comes AFTER redaction, so it can never cut a secret into a fragment the
 * patterns no longer recognize. Anything that is not a non-empty string after
 * cleaning reads as `cancelled` — the cancel itself is the fact, its wording
 * only a detail.
 */
export function cleanWithdrawReason(raw: unknown): string {
  if (typeof raw !== 'string') return WITHDRAW_REASON_CANCELLED
  const visible = stripControlChars(raw.slice(0, REASON_SCAN_CHARS))
  const cleaned = redactString(visible).slice(0, MAX_WITHDRAW_REASON_CHARS).trim()
  return cleaned === '' ? WITHDRAW_REASON_CANCELLED : cleaned
}
