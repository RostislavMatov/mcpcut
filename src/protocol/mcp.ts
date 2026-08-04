import type { ClassifiedMessage, JsonRpcId } from './classify.js'

/**
 * MCP-specific semantic extractions layered on top of the generic
 * JSON-RPC classification in `protocol/classify.ts`.
 *
 * THIS MODULE IS THE SINGLE POINT OF COUPLING TO THE MCP PROTOCOL SPEC
 * VERSION. As of writing, the MCP spec RC dated 2026-07-28 is mid-churn on
 * statelessness (dropping `Mcp-Session-Id`, changing server-initiated
 * request shapes). Any future adaptation to spec changes belongs here, and
 * in the semantic gate that consumes it (`proxy/gate.ts`) — nowhere else.
 * `protocol/classify.ts` and `protocol/split.ts` stay deliberately
 * spec-shallow (JSON-RPC only) and must not grow MCP-specific knowledge.
 *
 * Every export here is pure and never throws: any input with an
 * unexpected shape is treated as "not this kind of message" and yields
 * `null` (or `false`/an empty result), rather than raising.
 */

const TOOLS_CALL_METHOD = 'tools/call'
const TOOLS_LIST_METHOD = 'tools/list'

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
 * Extracts the tool name, arguments, and request id from a `tools/call`
 * request. Only handles requests (a `tools/call` notification has no id to
 * reply to, which is itself a spec violation — callers are expected to
 * forward notifications unconditionally without consulting this parser).
 * Returns `null` for any other message kind/method or malformed shape.
 */
export function parseToolCall(msg: ClassifiedMessage): ParsedToolCall | null {
  if (msg.kind !== 'request' || msg.method !== TOOLS_CALL_METHOD) {
    return null
  }

  const parsed = tryParseJsonObject(msg.raw)
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
  const args = rawArgs === undefined ? null : rawArgs

  return { toolName: name, args, id: msg.id }
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
