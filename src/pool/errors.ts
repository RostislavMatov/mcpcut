import { synthesizeError, type SynthesizableId } from '../proxy/synthesize.js'
import {
  ERROR_CODE_POOL_AT_CAPACITY,
  ERROR_CODE_POOL_INVALID_PARAMS,
  ERROR_CODE_POOL_MEMBER_GONE,
  ERROR_CODE_POOL_METHOD_NOT_FOUND,
  MAX_ERROR_NAME_CHARS,
} from './constants.js'

/**
 * Replies the pool synthesizes itself, for the frames it answers instead of
 * routing (ADR-0015 §§4-5). `route-request.ts` owns the one for an unknown
 * target; everything else lives here, alongside the hygiene both share.
 *
 * Every message below echoes something the AGENT sent — a method it named, a
 * server it prefixed — so the echo is bounded and washed. What the pool never
 * echoes is anything it knows and the agent does not: which servers the
 * installation holds, why a child refused to come up, or what the plane's own
 * configuration looks like. That prose belongs on the operator's stderr.
 */

/**
 * Everything that could make this text read as something other than what the
 * agent actually asked for: C0 controls and DEL, bidi overrides and embeds,
 * and zero-width/invisible formatting characters. Then bounded in length.
 *
 * This is display hygiene for a string a human will read in the journal or
 * the console — the same concern as `ui/display-name.ts` (audit finding H2),
 * which this module cannot import and must not: the pool ADDRESSES names, it
 * does not render them, and the raw name is never altered on any routing path.
 *
 * The character class is written with \uXXXX escapes and must stay that way.
 * Spelling it with the literal characters works and reads the same, and that
 * is the danger: an editor, a patch tool or a paste through a terminal that
 * normalizes Unicode can drop one of them, and a corrupted class fails
 * SILENTLY — no compile error, just a sanitizer doing less than it claims, in
 * exactly the string it exists to protect. This file has already lost them
 * once.
 */
export function safeNameOf(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .slice(0, MAX_ERROR_NAME_CHARS)
}

/**
 * A method the pool serves no capability for. The method name is the agent's
 * own word, echoed back so a client library can tell which of its calls was
 * refused — washed and bounded like every other echo.
 */
export function poolMethodNotFoundError(id: SynthesizableId, method: string): Buffer {
  const safe = safeNameOf(method)
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_METHOD_NOT_FOUND,
    message:
      `Method "${safe}" is not available at this address. ` +
      'A pool address serves tools and prompts only.',
    data: { reason: 'pool_unsupported_method', method: safe },
  })
}

/**
 * The server serving an in-flight call left the pool — its grant was revoked,
 * or its session died. Exactly one outcome reaches the agent for that id, and
 * this is it. Echoing the server name is safe: the agent named it itself, in
 * the prefix of the call being answered.
 */
export function poolMemberGoneError(id: SynthesizableId, server: string): Buffer {
  const safe = safeNameOf(server)
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_MEMBER_GONE,
    message:
      `Server "${safe}" is no longer part of this pool; the call was not completed. ` +
      'Read the tool list again to see what is available now.',
    data: { reason: 'pool_member_gone', serverName: safe },
  })
}

/**
 * A `cursor` the pool never issued. The pool drains each upstream's pages
 * itself and its merged result carries no `nextCursor` (`merge-lists.ts`), so
 * a cursor arriving in a request is either a confused client or a forged one.
 */
export function poolCursorError(id: SynthesizableId): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_INVALID_PARAMS,
    message: 'This address does not paginate; omit "cursor" and read the whole list.',
    data: { reason: 'pool_cursor_unsupported' },
  })
}

/** `ping`, answered by the plane: the pool is the server at this address (PE12). */
export function poolPingResult(id: SynthesizableId): Buffer {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`, 'utf8')
}

/**
 * The agent reused an id its previous request still holds. Answering the NEW
 * request is the only honest move: two live requests under one id is "one
 * outcome per id" broken, and the pool will not quietly pick one of them.
 */
export function poolDuplicateIdError(id: SynthesizableId): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_INVALID_PARAMS,
    message: 'A request with this id is already in flight; use a fresh id.',
    data: { reason: 'pool_duplicate_id' },
  })
}

/**
 * The correlation table is full. Fail closed rather than evicting: a forgotten
 * id would be a reply with nowhere to go, so the pool refuses the new request
 * instead of losing an old one.
 */
export function poolAtCapacityError(id: SynthesizableId): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_AT_CAPACITY,
    message: 'This address is tracking too many requests; retry when one has answered.',
    data: { reason: 'pool_at_capacity' },
  })
}

/**
 * The agent used an id in the range the plane reserves for its OWN upstream
 * requests. Tracking it would let a plane-originated reply be forwarded to the
 * agent as if it had asked for it (ADR-0015 §3).
 */
export function poolReservedIdError(id: SynthesizableId): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_POOL_INVALID_PARAMS,
    message: 'This request id is reserved; use one that does not start with the plane prefix.',
    data: { reason: 'pool_reserved_id' },
  })
}
