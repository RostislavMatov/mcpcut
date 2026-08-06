import { buildDecisionRecord } from '../journal/decision.js'
import type { DecisionInfo, PolicyOutcome, QuarantineState, ToolClass } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import { canonicalJson, sha256Hex } from '../policy/hash.js'
import type { JsonRpcId } from '../protocol/classify.js'
import { parseToolCallParams, type ParsedToolCall, type ToolDescriptor } from '../protocol/mcp.js'
import type { Verdict } from './pipeline.js'
import { denialError, quarantinedError, type SynthesizableId } from './synthesize.js'

/**
 * Supporting cast for the session policy gate (`proxy/gate.ts`): small pure
 * helpers shared by the gate's modules (`gate.ts`, `gate-router.ts`,
 * `gate-approvals.ts`, `tool-catalog.ts`). Split out purely to keep `gate.ts`
 * focused on the decision flow. The id-bookkeeping structures live in
 * `id-tracking.ts` and are re-exported here so consumers keep one import
 * surface.
 */

export {
  createAnswerGuard,
  createBoundedIdSet,
  type AnswerGuard,
  type BoundedIdSet,
} from './id-tracking.js'

/** Shared, frozen verdicts: the gate returns these by identity, never a fresh object. */
export const FORWARD: Verdict = Object.freeze({ action: 'forward' as const })
export const DROP: Verdict = Object.freeze({ action: 'drop' as const })

/**
 * The agent dimension of the gate (M3): what one authenticated agent may
 * see and call on this session's server. Structurally satisfied by
 * `agents/scope.ts`'s `agentScope()` output plus the agent's name — the
 * gate depends only on this interface, never on the agents module, so a
 * test (or the session core's live-reloading wrapper) can supply its own.
 * Absent entirely on the ad-hoc `wrap` path: that is exactly the M2
 * behavior, byte for byte.
 */
export interface GateAgentScope {
  /** Journal-facing identity of the authenticated agent. */
  readonly agentName: string
  /** True iff the agent's grant matrix covers `tool` on this server. */
  isGranted(tool: string): boolean
  /** The subset of `tools` the agent may see, input order preserved. */
  filterVisible(tools: readonly string[]): string[]
}

const NEWLINE_BYTE = 0x0a

/**
 * Strips one trailing `\n` so a line-framed buffer (synthesized errors and
 * rewritten catalogs both end in `\n` — `synthesize.ts`, `tools-filter.ts`)
 * becomes message-level *content* bytes. The message contract carries
 * framing in metadata, not in the bytes (`transport/message.ts`); the stdio
 * sink reattaches the terminator on the way out, so the wire stays
 * byte-identical. Bytes without a trailing newline pass through unchanged.
 */
export function trimTrailingNewline(bytes: Buffer): Buffer {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== NEWLINE_BYTE) {
    return bytes
  }
  return bytes.subarray(0, bytes.length - 1)
}

/** `rule` value `decide()` reports when quarantine is what blocked a call. */
export const QUARANTINE_RULE = 'quarantine'
/** `rule` recorded when the gate itself failed and closed the call down. */
export const GATE_ERROR_RULE = 'gate-error'
/** `rule` recorded when an approval landed on an id the gate already answered. */
export const ALREADY_ANSWERED_RULE = 'already-answered-locally'
/** `rule` recorded when the server answered an id the gate had answered locally. */
export const DUPLICATE_RESPONSE_RULE = 'duplicate-response-warning'
/** `rule` recorded when a client frame could not be positively identified as safe and was dropped (C2). */
export const UNPARSEABLE_CLIENT_FRAME_RULE = 'unparseable-client-frame'
/** `rule` recorded when a `tools/call` request could not be parsed into a call and was dropped (C2). */
export const MALFORMED_TOOLS_CALL_RULE = 'malformed-tools-call'

/** An id-less `tools/call` that resolved to require-approval: denied instead of enqueued (re-review L4). */
export const IDLESS_APPROVAL_RULE = 'idless-require-approval'
/** `rule` recorded when a `tools/list` observation failed or the catalog is untrusted (C3/C4). */
export const INVENTORY_UNAVAILABLE_RULE = 'inventory-unavailable'
/** `rule` recorded when a call is failed closed because the tool catalog is untrusted (C3/C4). */
export const CATALOG_UNTRUSTED_RULE = 'catalog-untrusted'
/** `rule` recorded when the outstanding `tools/list` id tracker had to evict an id (M9). */
export const TOOLS_LIST_OVERFLOW_RULE = 'tools-list-tracking-overflow'
/** `toolName` stamped on a record about a client frame with no recoverable tool identity. */
export const UNPARSEABLE_TOOL_NAME = '<unparseable>'
/** `rule` of the decision record holding the catalog exactly as the server sent it. */
export const TOOLS_LIST_ORIGINAL_RULE = 'toolsList.original'
/** `rule` of the decision record holding the catalog as the client actually saw it. */
export const TOOLS_LIST_FILTERED_RULE = 'toolsList.filtered'
/** `toolName` stamped on the two `tools/list` bookkeeping records. */
export const TOOLS_LIST_TOOL_NAME = 'tools/list'
/** `toolName` stamped on a duplicate-response bookkeeping record (no tool involved). */
export const RESPONSE_TOOL_NAME = '<response>'

/**
 * A JSON-RPC id is `string | number | null`, and numeric `1` must never
 * collide with string `"1"` — the same type-qualified key discipline
 * `journal/record.ts` uses for request correlation.
 */
export function idKeyOf(id: JsonRpcId): string {
  return `${typeof id} ${String(id)}`
}

/** Distinguishes a settled verdict from one still in flight, without awaiting it. */
export function isPromiseVerdict(outcome: Verdict | Promise<Verdict>): outcome is Promise<Verdict> {
  return typeof (outcome as Partial<Promise<Verdict>>).then === 'function'
}

/** Everything the gate has resolved about one tool call before deciding it. */
export interface CallFacts {
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly quarantineState: QuarantineState
  readonly argsHash: string
}

/** Optional per-outcome fields that only some decision records carry. */
export interface DecisionExtras {
  readonly approvalId?: string
  readonly latencyMs?: number
}

/** Assembles the `DecisionInfo` for one decided call. */
export function decisionInfoOf(
  facts: CallFacts,
  outcome: PolicyOutcome,
  rule: string,
  extras: DecisionExtras = {},
): DecisionInfo {
  return { ...facts, outcome, rule, ...extras }
}

/**
 * `DecisionInfo` for a record about something that is not a gated tool call
 * (a `tools/list` rewrite, a duplicate response). No call was blocked, so the
 * outcome is `allow` and the class/state fields carry the least alarming
 * values available; `argsHash` fingerprints `subject`, which is what makes
 * two otherwise identical bookkeeping records tell each other apart.
 */
export function bookkeepingDecisionInfo(
  serverName: string,
  rule: string,
  toolName: string,
  subject: unknown,
): DecisionInfo {
  return {
    outcome: 'allow',
    rule,
    serverName,
    toolName,
    toolClass: 'read',
    quarantineState: 'unknown',
    argsHash: sha256Hex(canonicalJson(subject)),
  }
}

/**
 * Fingerprint of a call's arguments, used as the grant key and stored on
 * every decision record. `undefined` and an explicit `null` hash the same
 * way, matching `approvals/queue.ts`'s own hashing of the same arguments.
 */
export function argsHashOf(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? null))
}

/** The subset of `JournalSink` the gate needs; lets tests inject a minimal fake. */
export type GateSink = Pick<JournalSink, 'write' | 'flush'>

/** Outcome buckets of one `observeToolsList`, plus a `failed` flag; see `GateInventory`. */
export interface GateObserveResult {
  readonly known: readonly string[]
  readonly new: readonly string[]
  readonly changed: readonly string[]
  /** `true` when the store update itself failed (disk error / corrupt store); never thrown. */
  readonly failed: boolean
}

/**
 * The inventory contract the gate consumes. Defined structurally (rather than
 * `Pick<Inventory>`) so the gate is decoupled from the concrete inventory
 * module: it depends only on these five methods, exactly as pinned by the
 * cross-agent interface. `stateOf` is authoritative once `load()` has run;
 * `observeToolsList` never throws (it reports failure via `failed`);
 * `isCatalogTrusted()` goes false on an observe/load failure, at which point
 * every subsequent `tools/call` must fail closed at the call level.
 */
export interface GateInventory {
  /** Hydrates the in-memory snapshot from the persisted store; call once at session start. */
  load(): Promise<void>
  /** Never throws; `failed:true` means the store update itself failed. */
  observeToolsList(tools: readonly ToolDescriptor[]): Promise<GateObserveResult>
  /** Synchronous, authoritative quarantine state; `'unknown'` only for never-seen names. */
  stateOf(toolName: string): QuarantineState
  /** True once ≥1 `observeToolsList` has been processed (even if it failed). */
  hasObservedCatalog(): boolean
  /** False if the latest observe returned `failed:true` or `load()` hit a corrupt/unavailable store. */
  isCatalogTrusted(): boolean
}

/**
 * Best-effort shallow parse of a raw JSON-RPC line to recover a scalar `id`,
 * so a rejected/unparseable client frame can still be answered with a denial
 * the client can correlate (C2). Returns `null` when no scalar id is
 * recoverable — a top-level batch array, a non-scalar id, or non-JSON — in
 * which case the frame is simply dropped without a synthetic reply.
 */
export function recoverScalarId(raw: string): JsonRpcId {
  const value = tryParse(raw)
  if (!isPlainRecord(value)) return null
  const id = value['id']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/**
 * Extracts the scalar `params.requestId` of a `notifications/cancelled` line,
 * so the client gate can order the cancellation strictly behind the request
 * it cancels (TS-M2). `null` when absent or non-scalar.
 */
export function parseCancelledRequestId(raw: string): JsonRpcId {
  const value = tryParse(raw)
  if (!isPlainRecord(value)) return null
  const params = value['params']
  if (!isPlainRecord(params)) return null
  const requestId = params['requestId']
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null
}

/**
 * `DecisionInfo` for a client frame the gate refused to forward because it
 * could not positively identify it as safe (C2). The most alarming
 * class/state values are stamped on it, and it always denies.
 */
export function unsafeClientFrameDecision(serverName: string, rule: string): DecisionInfo {
  return {
    outcome: 'deny',
    rule,
    serverName,
    toolName: UNPARSEABLE_TOOL_NAME,
    toolClass: 'destructive',
    quarantineState: 'unknown',
    argsHash: '',
  }
}

/**
 * Parses an id-less `tools/call` (spec-violating: `classify()` reports this
 * shape as `kind: 'notification'`, which has no `id` field at all) into the
 * same shape `protocol/mcp.ts`'s `parseToolCall` produces for a proper
 * request, with `id: null`. This is what lets a notification-shaped
 * `tools/call` go through the exact same decide()/journal path as an
 * id-bearing one instead of being blindly forwarded (C2/N1): the gate must
 * never treat "no id" as "no need to look at it". Returns `null` on any
 * malformed shape, mirroring `parseToolCall`'s own contract.
 */
export function parseIdlessToolCall(raw: string): ParsedToolCall | null {
  const parsed = parseToolCallParams(raw)
  return parsed === null ? null : { ...parsed, id: null }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Writes one redacted decision record. Fire-and-forget, like every sink write. */
export type DecisionWriter = (decision: DecisionInfo, args?: unknown) => void

export interface DecisionWriterDeps {
  readonly sink: GateSink
  readonly sessionId: string
  readonly clock: () => number
}

export function createDecisionWriter(deps: DecisionWriterDeps): DecisionWriter {
  return (decision, args) => {
    deps.sink.write(
      buildDecisionRecord({
        sessionId: deps.sessionId,
        decision,
        args: args ?? null,
        clock: deps.clock,
      }),
    )
  }
}

/**
 * Picks the synthetic error a blocked call is answered with: a quarantined
 * tool gets the quarantine-specific message (which tells the operator the
 * exact `quarantine approve` command), everything else gets the generic
 * policy denial.
 */
export function denialBytesFor(
  id: SynthesizableId,
  info: { readonly toolName: string; readonly serverName: string; readonly rule: string },
): Buffer {
  if (info.rule === QUARANTINE_RULE) {
    return quarantinedError(id, { toolName: info.toolName, serverName: info.serverName })
  }
  return denialError(id, { toolName: info.toolName, rule: info.rule })
}
