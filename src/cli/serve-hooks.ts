import type { IncomingHttpHeaders } from 'node:http'
import { classify } from '../protocol/classify.js'
import { detectInitializeBytes, extractPerMessageHeaders } from '../protocol/mcp.js'
import { idKeyOf } from '../proxy/gate-helpers.js'
import type {
  DetectInitialize,
  ExpectsResponse,
  ResponseCorrelation,
  StatelessValidation,
  ValidateStatelessHeaders,
} from '../transport/http/session.js'
import { headerMismatchBody, type DownstreamModel } from './serve-constants.js'

/**
 * The three semantic hooks `serve` injects into the HTTP front (M3 Task 13),
 * plus the downstream-model handoff the session factory reads.
 *
 * The front (`transport/http/*`) must not learn JSON-RPC — the architectural
 * invariant of CLAUDE.md, enforced by the import-graph test. So everything
 * spec-shaped it needs arrives as a callback built here, on the semantic side
 * of the plane, out of `protocol/mcp.ts` (the single point of coupling to the
 * spec) and `protocol/classify.ts`.
 *
 * ## The downstream-model handoff contract
 *
 * The session manager decides the downstream model per request but its
 * `openSession(ctx)` contract carries only `{agentName, serverName}` — and
 * the factory MUST know the model to enforce the ADR-0002 mismatch matrix.
 * The handoff below closes that gap without touching the transport's
 * contract:
 *
 *  - `detectInitialize(body)` is called by `handlePost` for every POST with
 *    no session id, and notes `'sessionful'` (it returned true) or
 *    `'stateless'` (it returned false);
 *  - `openSession(ctx)` is then invoked in the SAME synchronous chain — no
 *    `await` sits between the two in `session.ts`'s `handlePost` /
 *    `handleInitializePost` / `handleStatelessPost` — so the factory reads
 *    the note back before any other request can run. Single-threaded
 *    execution is what makes this exact, and the factory must therefore call
 *    `take()` as its very first statement.
 *  - `take()` clears the note. A factory invocation that finds none refuses
 *    (`REFUSAL_MODEL_UNDETECTED`): an undetermined model must never silently
 *    default to one, which is why this is a one-shot value rather than a
 *    sticky "last seen" flag.
 *
 * POSTs that carry a session id never reach the factory (the session already
 * exists), and GET/DELETE never open sessions, so those paths cannot leave a
 * stale note behind.
 */

/** One-shot channel carrying the detected downstream model to the factory. */
export interface ModelHandoff {
  note(model: DownstreamModel): void
  /** Reads and clears the pending model, `null` when there is none. */
  take(): DownstreamModel | null
}

export function createModelHandoff(): ModelHandoff {
  let pending: DownstreamModel | null = null
  return Object.freeze({
    note: (model: DownstreamModel) => {
      pending = model
    },
    take: () => {
      const taken = pending
      pending = null
      return taken
    },
  })
}

export interface ServeHooks {
  readonly detectInitialize: DetectInitialize
  readonly validateStatelessHeaders: ValidateStatelessHeaders
  readonly expectsResponse: ExpectsResponse
  readonly handoff: ModelHandoff
}

/** Header names SEP-2243 requires to mirror the request body, in check order. */
const MIRRORED_HEADERS: readonly string[] = ['Mcp-Method', 'Mcp-Name']

/** First value of a header (node lowercases names; arrays keep the first). */
function headerValueOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()]
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Stateless header↔body validation (SEP-2243, spec matrix §2.3). The plane
 * reads bodies (journal + policy), so it is a server "processing the body"
 * and the MUST applies to it in full:
 *
 *  - the expected values are DERIVED from the body by `protocol/mcp.ts`'s
 *    `extractPerMessageHeaders` — the very function the upstream client uses
 *    to mirror them — so downstream validation and upstream mirroring can
 *    never drift apart;
 *  - a missing header is a failure, not a pass: the matrix rates
 *    "мисматч/отсутствие → 400 + -32020" at MUST level, and accepting a
 *    body whose headers were never asserted would let an intermediary route
 *    on values the plane never checked;
 *  - a header the body does not justify (e.g. `Mcp-Name` on a `tools/list`)
 *    is equally a mismatch — the header set must mirror the body exactly.
 *
 * `MCP-Protocol-Version` is deliberately NOT validated here: version
 * negotiation is pass-through by ADR-0002 §4 (the plane forwards, never
 * substitutes), and an unsupported version is the upstream's `-32022` to
 * raise, not a `-32020` header mismatch.
 */
export function validateStatelessHeaders(
  headers: IncomingHttpHeaders,
  bytes: Buffer,
): StatelessValidation {
  const expected = extractPerMessageHeaders(bytes)
  for (const name of MIRRORED_HEADERS) {
    if (headerValueOf(headers, name) !== expected[name]) {
      return { ok: false, errorBody: headerMismatchBody(name) }
    }
  }
  return { ok: true }
}

/**
 * Whether the agent's POST is owed a JSON-RPC answer on that same HTTP
 * response. Requests are; notifications and responses are not (202). An
 * unparseable body is treated as "no answer expected" on purpose: the gate
 * fails such a message closed (dropping it, with a decision record), and
 * whether it can synthesize an error depends on recovering an id from
 * garbage — so promising the agent a response here would risk holding its
 * POST open until the session's idle TTL.
 */
export function expectsResponse(bytes: Buffer): boolean {
  return classify(bytes.toString('utf8')).kind === 'request'
}

/**
 * How the front pairs a POOL session's replies with its requests (ADR-0015
 * phase 3, plan decision P1). Lives here for the same reason every other hook
 * does: the key is a JSON-RPC `id`, and the transport must not learn what that
 * is — it only compares the strings this returns.
 *
 * A request or response with no id (a notification, or garbage) correlates
 * nothing, which the front reads as "owed no answer" and acknowledges with a
 * 202. `idKeyOf` is the gate's own keying function, so an id is keyed
 * identically wherever the plane tracks one.
 */
export const poolResponseCorrelation: ResponseCorrelation = Object.freeze({
  keyOfRequest: (bytes: Buffer): string | null => correlationKeyOf(bytes, 'request'),
  keyOfResponse: (bytes: Buffer): string | null => correlationKeyOf(bytes, 'response'),
})

/** The id key of a classified message of `kind`, or `null` when it has none. */
function correlationKeyOf(bytes: Buffer, kind: 'request' | 'response'): string | null {
  const message = classify(bytes.toString('utf8'))
  if (message.kind !== kind || message.id === null) {
    return null
  }
  return idKeyOf(message.id)
}

/** Builds the hook set for one `serve` run, sharing one model handoff. */
export function createServeHooks(): ServeHooks {
  const handoff = createModelHandoff()

  return Object.freeze({
    handoff,
    detectInitialize: (bytes: Buffer): boolean => {
      const isInitialize = detectInitializeBytes(bytes)
      handoff.note(isInitialize ? 'sessionful' : 'stateless')
      return isInitialize
    },
    validateStatelessHeaders,
    expectsResponse,
  })
}
