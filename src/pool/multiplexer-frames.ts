import type { JsonRpcId } from '../protocol/classify.js'
import { PROMPTS_LIST_METHOD, TOOLS_LIST_METHOD } from '../protocol/mcp.js'
import { RESULT_TYPE_COMPLETE } from '../protocol/mcp-stateless.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import {
  poolAtCapacityError,
  poolDuplicateIdError,
  poolReservedIdError,
} from './errors.js'
import { isPlainObject, tryParseObject } from './json.js'
import type { PoolListKind } from './merge-lists.js'
import { POOL_NAME_SEPARATOR } from './constants.js'

/**
 * The readings and the frames the multiplexer needs, kept apart from the
 * dispatch itself so that file stays one readable piece.
 *
 * Everything here is pure and total: an input it cannot read positively
 * yields `null`, never an exception and never a guess — the same contract the
 * rest of `src/pool/*` holds to.
 */

/** The one reply each tracking refusal deserves; see the codes' own docs. */
export function refusalFor(
  reason: 'duplicate-id' | 'at-capacity' | 'reserved-id',
  id: SynthesizableId,
): Buffer {
  if (reason === 'duplicate-id') return poolDuplicateIdError(id)
  if (reason === 'at-capacity') return poolAtCapacityError(id)
  return poolReservedIdError(id)
}

/** The method name a list kind came from, for the record's `method` field. */
export const LIST_KIND_BY_METHOD_NAME: Readonly<Record<PoolListKind, string>> = {
  tools: TOOLS_LIST_METHOD,
  prompts: PROMPTS_LIST_METHOD,
}

/** True when the agent sent a `cursor` the pool never issued. */
export function hasCursor(raw: string): boolean {
  const parsed = tryParseObject(raw)
  const params = parsed?.['params']
  return isPlainObject(params) && params['cursor'] !== undefined
}

/** The client id a `notifications/cancelled` names, or `null`. */
export function cancelledRequestIdOf(raw: string): SynthesizableId | null {
  const parsed = tryParseObject(raw)
  const params = parsed?.['params']
  if (!isPlainObject(params)) return null
  const id = params['requestId']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/**
 * The `progressToken` an agent put on a request, from `params._meta`, or
 * `null`. Only a string or a finite number is a token (MCP progress spec);
 * anything else binds nothing, so progress on it can never be forwarded.
 */
export function progressTokenOfRequest(raw: string): SynthesizableId | null {
  const params = tryParseObject(raw)?.['params']
  const meta = isPlainObject(params) ? params['_meta'] : undefined
  return isPlainObject(meta) ? tokenOf(meta['progressToken']) : null
}

/** The `progressToken` a `notifications/progress` reports on, from `params`, or `null`. */
export function progressTokenOfNotification(raw: string): SynthesizableId | null {
  const params = tryParseObject(raw)?.['params']
  return isPlainObject(params) ? tokenOf(params['progressToken']) : null
}

function tokenOf(value: unknown): SynthesizableId | null {
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * `result.resultType` of a reply when it is a string other than `complete`, or
 * `null` (RV5). A member of the 2026-07-28 revision may answer `input_required`
 * — or, to a client that declared no capabilities, a bare `requestState` to
 * retry with. The plane runs no such retry, and a sessionful agent would read
 * that result as finished and empty. Parsed only for replies to the agent's
 * own calls, never on the notification path.
 */
export function incompleteResultTypeOf(raw: string): string | null {
  const result = tryParseObject(raw)?.['result']
  if (!isPlainObject(result)) return null
  const resultType = result['resultType']
  return typeof resultType === 'string' && resultType !== RESULT_TYPE_COMPLETE ? resultType : null
}

/** The plane-minted id, as the catalog filed its page under. */
export function fanoutTagOf(id: JsonRpcId): string {
  return typeof id === 'string' ? id : String(id)
}

/** A bare notification line. Unframed: framing belongs to the transport. */
export function notificationFrame(method: string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', method }), 'utf8')
}

/** An empty catalog: a legal answer, and never an error (an agent may hold no grants). */
export function emptyListFrame(id: SynthesizableId, kind: PoolListKind): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { [kind]: [] } }), 'utf8')
}

/** The pool-side name a merge reported as hidden or warned. */
export function poolNameOf(entry: { readonly server: string; readonly name: string }): string {
  return `${entry.server}${POOL_NAME_SEPARATOR}${entry.name}`
}
