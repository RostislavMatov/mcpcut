/**
 * Thin, best-effort classification of a single JSON-RPC 2.0 line for
 * journaling purposes only. This proxy never modifies or rejects traffic
 * based on classification — it only decides how to summarize a line in the
 * journal. Deliberately shallow: the MCP spec's transport/session shape is
 * still moving (see 2026-07-28 RC), so this module avoids deep protocol
 * knowledge and stays easy to replace.
 */

const JSON_RPC_VERSION = '2.0'

/** A JSON-RPC 2.0 message id: string, number, or null. */
export type JsonRpcId = string | number | null

export interface ClassifiedRequest {
  readonly kind: 'request'
  readonly id: JsonRpcId
  readonly method: string
  readonly raw: string
}

export interface ClassifiedNotification {
  readonly kind: 'notification'
  readonly method: string
  readonly raw: string
}

export interface ClassifiedResponseSuccess {
  readonly kind: 'response'
  readonly id: JsonRpcId
  readonly isError: false
  readonly raw: string
}

export interface ClassifiedResponseError {
  readonly kind: 'response'
  readonly id: JsonRpcId
  readonly isError: true
  readonly errorCode: number
  readonly errorMessage: string
  readonly raw: string
}

export type ClassifiedResponse = ClassifiedResponseSuccess | ClassifiedResponseError

export interface ClassifiedInvalid {
  readonly kind: 'invalid'
  readonly raw: string
  readonly reason: string
}

/** Discriminated union over `kind` describing a classified journal line. */
export type ClassifiedMessage =
  | ClassifiedRequest
  | ClassifiedNotification
  | ClassifiedResponse
  | ClassifiedInvalid

/**
 * Classifies a single line of proxied traffic as a JSON-RPC 2.0 request,
 * response, notification, or invalid. Never throws: any unparseable or
 * non-JSON-RPC input is classified as 'invalid' with the raw line preserved.
 */
export function classify(line: string): ClassifiedMessage {
  const parsed = tryParseJson(line)
  if (!parsed.ok) {
    return invalid(line, 'not valid JSON')
  }

  if (!isPlainObject(parsed.value)) {
    return invalid(line, 'not a JSON-RPC object (batches are not yet supported)')
  }

  const message = parsed.value
  if (message['jsonrpc'] !== JSON_RPC_VERSION) {
    return invalid(line, 'missing or unsupported "jsonrpc" version')
  }

  const hasId = 'id' in message
  const hasMethod = typeof message['method'] === 'string'

  if (hasMethod) {
    return classifyMethodMessage(message, hasId, line)
  }

  if (hasId) {
    return classifyResponse(message, line)
  }

  return invalid(line, 'has neither "method" nor "result"/"error"')
}

function classifyMethodMessage(
  message: Readonly<Record<string, unknown>>,
  hasId: boolean,
  line: string,
): ClassifiedRequest | ClassifiedNotification | ClassifiedInvalid {
  const method = message['method'] as string

  if (!hasId) {
    return { kind: 'notification', method, raw: line }
  }

  const id = message['id']
  if (!isJsonRpcId(id)) {
    return invalid(line, 'invalid "id" type')
  }

  return { kind: 'request', id, method, raw: line }
}

function classifyResponse(
  message: Readonly<Record<string, unknown>>,
  line: string,
): ClassifiedResponse | ClassifiedInvalid {
  const id = message['id']
  if (!isJsonRpcId(id)) {
    return invalid(line, 'invalid "id" type')
  }

  const hasError = 'error' in message
  const hasResult = 'result' in message

  if (hasError && !hasResult) {
    const { code, message: errorMessage } = extractError(message['error'])
    return { kind: 'response', id, isError: true, errorCode: code, errorMessage, raw: line }
  }

  if (hasResult && !hasError) {
    return { kind: 'response', id, isError: false, raw: line }
  }

  return invalid(line, 'must have exactly one of "result" or "error"')
}

function extractError(error: unknown): { code: number; message: string } {
  if (!isPlainObject(error)) {
    return { code: -32603, message: 'unknown error' }
  }

  const code = typeof error['code'] === 'number' ? error['code'] : -32603
  const message = typeof error['message'] === 'string' ? error['message'] : 'unknown error'
  return { code, message }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number' || value === null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(raw: string, reason: string): ClassifiedInvalid {
  return { kind: 'invalid', raw, reason }
}

type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

function tryParseJson(line: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}
