import { LATEST_SESSIONFUL_PROTOCOL_VERSION, SESSIONFUL_PROTOCOL_VERSIONS } from '../protocol/mcp.js'
import type { FileRule } from './rights.js'
import type { SearchBackend } from './search/search-backend.js'
import { contextFor, errorOutput, type ToolOutput } from './tool-context.js'
import { runTool } from './tool-handlers.js'
import { listedTools } from './tools.js'

/**
 * The file module's in-process MCP server (ADR-0020 §1): it answers parsed
 * JSON-RPC objects and knows nothing of transports. Roots and rules are read
 * afresh on every `tools/call`, so a revoked right applies to the next call.
 * A handler that throws yields a generic one-line tool error — never a stack,
 * never a path from the exception — and the server stays usable.
 */

export interface FilesServerInfo {
  readonly name: string
  readonly version: string
}

export interface FilesServerDeps {
  readonly roots: () => Promise<readonly string[]>
  readonly rules: () => Promise<readonly FileRule[]>
  readonly actor: string
  readonly serverInfo?: FilesServerInfo
  /** True when `search_files` is to be listed (an index rule is on); absent means not listed. Never rejects the listing. */
  readonly searchListed?: () => Promise<boolean>
  /** The search by meaning behind `search_files`; absent means the tool answers that search is not available. */
  readonly search?: SearchBackend
}

export interface FilesServer {
  /** A request gets its response; a notification gets `null`. */
  handle(request: unknown): Promise<JsonRpcResponse | null>
}

type JsonRpcId = string | number | null

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly error: { readonly code: number; readonly message: string } }

const DEFAULT_SERVER_INFO: FilesServerInfo = { name: 'mcpcut-files', version: '1' }
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const UNEXPECTED_FAILURE_MESSAGE =
  'The file tool failed unexpectedly: try again, and if it keeps failing ask an administrator to check the mcpcut log.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function toolResult(output: ToolOutput): unknown {
  const content = [{ type: 'text', text: output.text }]
  return output.isError ? { content, isError: true } : { content }
}

function negotiatedVersion(params: unknown): string {
  const asked = isRecord(params) ? params['protocolVersion'] : undefined
  const known = SESSIONFUL_PROTOCOL_VERSIONS.find((version) => version === asked)
  return known ?? LATEST_SESSIONFUL_PROTOCOL_VERSION
}

export function createFilesServer(deps: FilesServerDeps): FilesServer {
  const serverInfo = deps.serverInfo ?? DEFAULT_SERVER_INFO

  async function isSearchListed(): Promise<boolean> {
    try {
      return (await deps.searchListed?.()) === true
    } catch {
      return false
    }
  }

  async function callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const name = isRecord(params) ? params['name'] : undefined
    if (typeof name !== 'string' || name === '') return failure(id, INVALID_PARAMS, 'tools/call needs params.name, the tool to call.')
    const args = (params as Record<string, unknown>)['arguments']
    try {
      return success(id, toolResult(await runTool(name, await contextFor(deps), args)))
    } catch {
      return success(id, toolResult(errorOutput(UNEXPECTED_FAILURE_MESSAGE)))
    }
  }

  async function answer(id: JsonRpcId, method: string, params: unknown): Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize':
        return success(id, { protocolVersion: negotiatedVersion(params), capabilities: { tools: {} }, serverInfo })
      case 'ping':
        return success(id, {})
      case 'tools/list':
        return success(id, { tools: listedTools({ isSearchListed: await isSearchListed() }) })
      case 'tools/call':
        return callTool(id, params)
      default:
        return failure(id, METHOD_NOT_FOUND, `Method ${method} is not supported by the file server.`)
    }
  }

  return {
    async handle(request: unknown): Promise<JsonRpcResponse | null> {
      if (!isRecord(request)) return failure(null, INVALID_REQUEST, 'A request must be a JSON-RPC object.')
      const method = request['method']
      const rawId = request['id']
      const hasId = 'id' in request && (typeof rawId === 'string' || typeof rawId === 'number' || rawId === null)
      if (typeof method !== 'string') {
        return hasId ? failure(rawId as JsonRpcId, INVALID_REQUEST, 'A request needs a string "method".') : failure(null, INVALID_REQUEST, 'A request needs a string "method".')
      }
      if (!hasId) return null
      return answer(rawId as JsonRpcId, method, request['params'])
    },
  }
}
