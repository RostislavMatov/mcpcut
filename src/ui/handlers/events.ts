import { HTTP_STATUS_SERVICE_UNAVAILABLE } from '../constants.js'
import type { EventHub } from '../events.js'
import type { UiHandler, UiResult } from '../routes.js'

/**
 * `GET /events` handler (M4 Task 11): the SSE endpoint the admin UI keeps open
 * for live approval/quarantine deltas. Authentication and role checks are done
 * by `ui/server.ts` (Task 9) BEFORE this runs — this handler receives an
 * already-authorized operator and only decides between attaching to the hub or
 * refusing when the hub is full.
 *
 * It returns a `UiResult` like every other injected handler; it does NOT touch
 * `res` or write any headers itself. The server owns the response contract:
 *
 *  - hub has capacity → `{ kind: 'stream' }`. The server writes `200` with
 *    `securityHeaders()` + `SSE_HEADERS` ONCE, then calls `onStream(res)`,
 *    which hands the socket to the hub. There is exactly one `writeHead`.
 *  - hub is full → `{ kind: 'response', status: 503 }` with a short
 *    `Retry-After`, decided BEFORE any `200` is written, so an over-capacity
 *    request gets a clean refusal instead of a broken half-written stream.
 *
 * The capacity check and the subscribe run in the same synchronous request
 * turn (the server calls `onStream` inline), so no other subscriber can claim
 * the slot in between; `hub.subscribe` still refuses defensively if it does.
 */

const RETRY_AFTER_SECONDS = '5'
const CONTENT_TYPE_TEXT = 'text/plain; charset=utf-8'

/** Builds the injectable `events` handler bound to a single process-wide hub. */
export function createEventsHandler(hub: EventHub): UiHandler {
  return function events(): UiResult {
    if (!hub.hasCapacity()) {
      return {
        kind: 'response',
        status: HTTP_STATUS_SERVICE_UNAVAILABLE,
        headers: { 'content-type': CONTENT_TYPE_TEXT, 'retry-after': RETRY_AFTER_SECONDS },
        body: 'event stream at capacity',
      }
    }
    return {
      kind: 'stream',
      // The identity comes from the server (it owns the cookie), not from the
      // request context: it binds this never-ending request to its session so
      // the hub can end it when that session is revoked, rotated or expires.
      onStream: (res, identity) => {
        hub.subscribe(res, identity)
      },
    }
  }
}
