import type { ClassifiedMessage, JsonRpcId } from './classify.js'

/**
 * MCP-specific semantic extractions layered on top of the generic
 * JSON-RPC classification in `protocol/classify.ts`.
 *
 * THIS MODULE IS THE SINGLE POINT OF COUPLING TO THE MCP PROTOCOL SPEC
 * VERSION. The 2026-07-28 revision (finalized and current as of Task 1's
 * verification — see `docs/research/http-spec-matrix.md`) moves the
 * protocol to stateless HTTP (no `Mcp-Session-Id`, per-message
 * `Mcp-Method`/`Mcp-Name` headers). Any future adaptation to spec changes
 * belongs here, and in the semantic gate that consumes it
 * (`proxy/gate.ts`) — nowhere else. The version helpers at the bottom of
 * this file (`isInitializeRequest`, `detectInitializeBytes`,
 * `extractPerMessageHeaders`) exist precisely so the HTTP transport can be
 * handed spec knowledge as injected callbacks without ever importing it.
 * `protocol/classify.ts` and `protocol/split.ts` stay deliberately
 * spec-shallow (JSON-RPC only) and must not grow MCP-specific knowledge.
 *
 * Every export here is pure and never throws: any input with an
 * unexpected shape is treated as "not this kind of message" and yields
 * `null` (or `false`/an empty result), rather than raising.
 */

/** The single point of coupling to the MCP `tools/call` method name; import it rather than re-typing the literal. */
export const TOOLS_CALL_METHOD = 'tools/call'
/** Same rule for `tools/list` (the probe engine and inventory both need it). */
export const TOOLS_LIST_METHOD = 'tools/list'
/** Same rule for the two prompt methods the agent pool merges and routes (ADR-0015). */
export const PROMPTS_LIST_METHOD = 'prompts/list'
export const PROMPTS_GET_METHOD = 'prompts/get'

/** A single tool as reported by a server's `tools/list` response. */
export interface ToolDescriptor {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly [key: string]: unknown
  }
}

/** The result of successfully parsing a `tools/call` request. */
export interface ParsedToolCall {
  readonly toolName: string
  readonly args: unknown
  readonly id: JsonRpcId
}

/** The result of successfully parsing a `tools/list` response. */
export interface ParsedToolsListResult {
  readonly tools: readonly ToolDescriptor[]
  readonly nextCursor?: string
}

/**
 * Extracts the tool name and arguments of a `tools/call` from its raw JSON
 * line, with no assumption about the presence of an `id`. This is the ONE
 * shape-validation for a tool call: both the id-bearing request path
 * (`parseToolCall`) and the id-less notification-shaped path (C2/N1,
 * `proxy/gate-helpers.ts`) go through it, so the two can never drift in what
 * they accept. Returns `null` on any malformed shape.
 */
export function parseToolCallParams(raw: string): Pick<ParsedToolCall, 'toolName' | 'args'> | null {
  const parsed = tryParseJsonObject(raw)
  if (!parsed) {
    return null
  }

  const params = parsed['params']
  if (!isPlainObject(params)) {
    return null
  }

  const name = params['name']
  if (typeof name !== 'string' || name.length === 0) {
    return null
  }

  const rawArgs = params['arguments']
  return { toolName: name, args: rawArgs === undefined ? null : rawArgs }
}

/**
 * Extracts the tool name, arguments, and request id from a `tools/call`
 * request. Only handles requests — a `tools/call` with no id classifies as a
 * notification and is parsed by `proxy/gate-helpers.ts`'s
 * `parseIdlessToolCall` instead, through the same `parseToolCallParams`
 * (it is gated identically, never blindly forwarded — C2/N1).
 * Returns `null` for any other message kind/method or malformed shape.
 */
export function parseToolCall(msg: ClassifiedMessage): ParsedToolCall | null {
  if (msg.kind !== 'request' || msg.method !== TOOLS_CALL_METHOD) {
    return null
  }

  const parsed = parseToolCallParams(msg.raw)
  if (!parsed) {
    return null
  }

  return { ...parsed, id: msg.id }
}

/** True if `msg` is a `tools/list` request. */
export function isToolsListRequest(msg: ClassifiedMessage): boolean {
  return msg.kind === 'request' && msg.method === TOOLS_LIST_METHOD
}

/**
 * Extracts the tool list from a successful `tools/list` response.
 * Malformed tool entries (not an object, or without a string `name`) are
 * skipped rather than failing the whole parse. Returns `null` if the
 * message isn't a successful response, or `result.tools` isn't an array.
 */
export function parseToolsListResult(msg: ClassifiedMessage): ParsedToolsListResult | null {
  if (msg.kind !== 'response' || msg.isError) {
    return null
  }

  const parsed = tryParseJsonObject(msg.raw)
  if (!parsed) {
    return null
  }

  const result = parsed['result']
  if (!isPlainObject(result)) {
    return null
  }

  const rawTools = result['tools']
  if (!Array.isArray(rawTools)) {
    return null
  }

  const tools = rawTools
    .map(toToolDescriptor)
    .filter((tool): tool is ToolDescriptor => tool !== null)

  const nextCursor = result['nextCursor']
  if (typeof nextCursor === 'string') {
    return { tools, nextCursor }
  }

  return { tools }
}

/**
 * Re-serializes the original `tools/list` response with `result.tools`
 * replaced, preserving every other field of the message and of `result`
 * (e.g. `_meta`, `nextCursor`). Parses `original.raw` for this; any
 * failure to parse (or a missing/malformed `result` object) yields `null`.
 * Output is guaranteed single-line JSON (defensive: `JSON.stringify` never
 * emits a literal newline, but the guarantee is asserted rather than
 * assumed).
 */
export function serializeToolsListResult(
  original: ClassifiedMessage,
  tools: readonly ToolDescriptor[],
): string | null {
  const parsed = tryParseJsonObject(original.raw)
  if (!parsed) {
    return null
  }

  const result = parsed['result']
  if (!isPlainObject(result)) {
    return null
  }

  const updated = {
    ...parsed,
    result: {
      ...result,
      tools: tools.map(toToolJson),
    },
  }

  const serialized = JSON.stringify(updated)
  return serialized.includes('\n') ? null : serialized
}

function toToolDescriptor(entry: unknown): ToolDescriptor | null {
  if (!isPlainObject(entry) || typeof entry['name'] !== 'string') {
    return null
  }

  const description = typeof entry['description'] === 'string' ? entry['description'] : undefined
  const annotations = isPlainObject(entry['annotations'])
    ? (entry['annotations'] as ToolDescriptor['annotations'])
    : undefined

  return {
    name: entry['name'],
    ...(description !== undefined ? { description } : {}),
    ...('inputSchema' in entry ? { inputSchema: entry['inputSchema'] } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  }
}

function toToolJson(tool: ToolDescriptor): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }
}

// ---------------------------------------------------------------------------
// Version helpers (M3): the session-model knowledge the HTTP transport needs,
// exposed as pure functions so `transport/http/*` can receive them injected
// and stay semantics-free. All of them treat garbage as "no" — never throw.
// ---------------------------------------------------------------------------

/** The MCP handshake method that marks the sessionful (≤ 2025-11-25) model. */
export const INITIALIZE_METHOD = 'initialize'

/** The notification a client sends once it has accepted an `initialize` result. */
export const INITIALIZED_NOTIFICATION = 'notifications/initialized'
/** Server-initiated "my catalog changed" notifications, one per list kind. */
export const TOOLS_LIST_CHANGED_NOTIFICATION = 'notifications/tools/list_changed'
export const PROMPTS_LIST_CHANGED_NOTIFICATION = 'notifications/prompts/list_changed'

/**
 * The spec's liveness request. A pool address answers it itself: the plane is
 * the server there (PE12), and forwarding one ping to N upstreams would turn
 * a keepalive into a fan-out.
 */
export const PING_METHOD = 'ping'

/**
 * "Stop working on this request." Its `params.requestId` names an id the
 * CLIENT issued, so at a pool address it is the one notification that has to
 * be routed rather than broadcast — it belongs to whichever upstream holds
 * that id.
 */
export const CANCELLED_NOTIFICATION = 'notifications/cancelled'

/**
 * Sessionful revisions the plane can answer `initialize` for ITSELF, oldest
 * first, so the tail is "latest supported" (ADR-0015 §4: at a pool address the
 * plane is the server, and ADR-0002 §4's "forward, never substitute" does not
 * apply). 2026-07-28 is deliberately absent: that revision removed the
 * handshake entirely, so it cannot be negotiated through one — a stateless
 * agent is a second-wave concern (PE3), not a version in this list.
 */
export const SESSIONFUL_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'] as const

/**
 * The newest revision of that list, named here so callers neither index it by
 * `length - 1` (which TypeScript cannot narrow, forcing a bare `!`) nor hold a
 * second copy of the literal that could drift from the list above.
 */
export const LATEST_SESSIONFUL_PROTOCOL_VERSION = '2025-11-25'

/**
 * Methods whose stateless per-message headers carry an `Mcp-Name` mirror,
 * mapped to the `params` field the spec mirrors it from (SEP-2243:
 * `params.name` for tools/call and prompts/get, `params.uri` for
 * resources/read).
 */
const MCP_NAME_PARAM_BY_METHOD: Readonly<Record<string, 'name' | 'uri'>> = {
  [TOOLS_CALL_METHOD]: 'name',
  [PROMPTS_GET_METHOD]: 'name',
  'resources/read': 'uri',
}

/** `params._meta` key carrying the stateless protocol version (2026-07-28). */
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'

/**
 * True iff `msg` is an `initialize` request — the handshake that selects
 * the sessionful HTTP model for a downstream connection (an agent speaking
 * the 2026-07-28 stateless revision never sends one).
 */
export function isInitializeRequest(msg: ClassifiedMessage): boolean {
  return msg.kind === 'request' && msg.method === INITIALIZE_METHOD
}

/**
 * `isInitializeRequest` for a context that has raw bytes but no
 * `ClassifiedMessage` (the HTTP server sees request bodies, not frames).
 * Request-shaped only: an `id` key must be present, like `classify()`
 * requires for a request. Garbage of any shape is simply `false`.
 */
export function detectInitializeBytes(bytes: Buffer): boolean {
  const parsed = tryParseJsonObject(bytes.toString('utf8'))
  return parsed !== null && parsed['method'] === INITIALIZE_METHOD && 'id' in parsed
}

/**
 * Derives the stateless per-message headers (SEP-2243) a stateless upstream
 * requires, by mirroring the message body — the injected implementation of
 * the HTTP client's `perMessageHeaders` hook:
 *
 *  - `Mcp-Method` — the body's `method`, on every request/notification;
 *  - `Mcp-Name` — `params.name` for `tools/call`/`prompts/get`,
 *    `params.uri` for `resources/read` (only those three methods);
 *  - `MCP-Protocol-Version` — mirrored from
 *    `params._meta["io.modelcontextprotocol/protocolVersion"]` when the
 *    body carries one, so header and body agree by construction (MUST).
 *
 * Values outside printable ASCII are wrapped in the spec's Base64 sentinel
 * (`=?base64?<b64>?=`) so they stay legal header values. A body that is not
 * a JSON object with a string `method` (responses, garbage) yields `{}`.
 */
export function extractPerMessageHeaders(bytes: Buffer): Record<string, string> {
  const parsed = tryParseJsonObject(bytes.toString('utf8'))
  if (parsed === null) {
    return {}
  }
  const method = parsed['method']
  if (typeof method !== 'string' || method.length === 0) {
    return {}
  }

  const headers: Record<string, string> = { 'Mcp-Method': headerValueOf(method) }

  const nameParam = MCP_NAME_PARAM_BY_METHOD[method]
  const params = parsed['params']
  if (nameParam !== undefined && isPlainObject(params)) {
    const name = params[nameParam]
    if (typeof name === 'string' && name.length > 0) {
      headers['Mcp-Name'] = headerValueOf(name)
    }
  }

  const protocolVersion = protocolVersionOf(params)
  if (protocolVersion !== null) {
    headers['MCP-Protocol-Version'] = headerValueOf(protocolVersion)
  }

  return headers
}

/** Extracts `params._meta["io.modelcontextprotocol/protocolVersion"]`, if present. */
function protocolVersionOf(params: unknown): string | null {
  if (!isPlainObject(params)) {
    return null
  }
  const meta = params['_meta']
  if (!isPlainObject(meta)) {
    return null
  }
  const version = meta[PROTOCOL_VERSION_META_KEY]
  return typeof version === 'string' && version.length > 0 ? version : null
}

/** Chars legal in an HTTP header value without encoding: printable ASCII. */
const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/

/**
 * A mirrored body value as a header value: passed through when it is
 * printable ASCII, otherwise wrapped in the SEP-2243 Base64 sentinel.
 */
function headerValueOf(value: string): string {
  if (PRINTABLE_ASCII_ONLY.test(value)) {
    return value
  }
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
