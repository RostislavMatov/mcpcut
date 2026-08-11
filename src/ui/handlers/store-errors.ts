import { BODY_INTERNAL, HTTP_STATUS_INTERNAL_ERROR } from '../constants.js'
import type { UiResult } from '../routes.js'

/**
 * Telling operator mistakes apart from infrastructure failures at the handler
 * boundary.
 *
 * The stores raise two very different kinds of `Error` from the same call: a
 * NAMED, typed one describing bad input ("that agent already exists", "the last
 * owner cannot be removed") and an unnamed one describing a broken plane (a
 * corrupt store file, a lock that never came free, an I/O error). Rendering
 * both as `400 <raw message>` — the previous behaviour — is wrong twice over:
 * an operator reads a real outage as their own typo, and the raw message of an
 * unanticipated failure is echoed back into the browser.
 *
 * So: a listed error class → 400 with its (author-written, safe) message;
 * anything else → 500 with the same detail-free body the server's catch-all
 * uses. The lists live with each handler, because only the handler knows which
 * of its store's errors are the caller's fault.
 */

/** A constructor of some `Error` subclass, as stored in a handler's list. */
export type ErrorClass = abstract new (...args: never[]) => Error

/** True when `error` is an instance of one of the listed (input-fault) classes. */
export function isKnownStoreError(error: unknown, classes: readonly ErrorClass[]): boolean {
  return classes.some((candidate) => error instanceof candidate)
}

/**
 * The uniform answer to an unrecognized store failure: 500 with no detail.
 * Byte-identical to `server.ts`'s catch-all, so a handler that catches and a
 * handler that throws are indistinguishable from outside.
 */
export function internalErrorResult(): UiResult {
  return { kind: 'response', status: HTTP_STATUS_INTERNAL_ERROR, body: BODY_INTERNAL }
}
