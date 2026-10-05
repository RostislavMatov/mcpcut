import type { EffectiveAgentReader } from '../agents/effective-reader.js'
import type { MessageSink, MessageSource, McpMessage } from '../transport/message.js'
import { serverMessage } from '../transport/message.js'
import { FILES_SERVER_NAME } from './constants.js'
import { JOURNAL_DIR } from '../config.js'
import { rootsOutsideDataDir } from './data-overlap.js'
import { createRootsStore } from './roots-store.js'
import type { FileRule } from './rights.js'
import { createFilesServer, type FilesServer, type JsonRpcResponse } from './server.js'

/**
 * The file server as an upstream (ADR-0020 §1): the pair of endpoints the
 * session core relays through, answering in-process. The core's tap sees every
 * message exactly as it would from a child process — there is no second path.
 * Requests are answered strictly in arrival order; framing is the JSON-RPC
 * object as plain bytes (no terminator, like an HTTP upstream: the client sink
 * owns framing).
 */

/** What the server needs per call: roots, the actor's rules, and who the actor is. */
export interface FilesBackend {
  readonly roots: () => Promise<readonly string[]>
  readonly rules: () => Promise<readonly FileRule[]>
  readonly actor: string
}

export interface FilesEndpoints {
  readonly source: MessageSource
  readonly sink: MessageSink
  /** Stops delivery and waits for the call in flight; idempotent. */
  close(): Promise<void>
}

const PARSE_ERROR = -32700

/** The one line for a built-in file server asked for without an agent identity (ad hoc `wrap`, a probe-less path). */
export function noAgentMessage(cli: string, serverName: string): string {
  return (
    `server "${serverName}" is the built-in file server and works only for an agent: ` +
    `create one with \`${cli} agent create <name>\`, grant it folders, then run \`${cli} connect --agent <name> --server ${serverName}\``
  )
}

function encode(response: JsonRpcResponse): McpMessage {
  return serverMessage(Buffer.from(JSON.stringify(response), 'utf8'))
}

function parseError(): JsonRpcResponse {
  return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'The message is not valid JSON.' } }
}

async function answerOf(server: FilesServer, bytes: Buffer): Promise<JsonRpcResponse | null> {
  let request: unknown
  try {
    request = JSON.parse(bytes.toString('utf8'))
  } catch {
    return parseError()
  }
  return server.handle(request)
}

export function createFilesEndpoints(backend: FilesBackend, onError: (error: unknown) => void): FilesEndpoints {
  const server = createFilesServer(backend)
  let deliver: ((message: McpMessage) => void) | null = null
  let isClosed = false
  let queue: Promise<void> = Promise.resolve()

  async function relay(message: McpMessage): Promise<void> {
    try {
      const response = await answerOf(server, message.bytes)
      if (response !== null && !isClosed) deliver?.(encode(response))
    } catch (error: unknown) {
      onError(error)
    }
  }

  const source: MessageSource = Object.freeze({
    onMessage: (handler: (message: McpMessage) => void) => {
      deliver = handler
    },
    onError: () => undefined,
    onEnd: () => undefined,
    dispose: () => {
      isClosed = true
    },
  })

  const sink: MessageSink = Object.freeze({
    write: (message: McpMessage): Promise<void> => {
      if (isClosed) return Promise.resolve()
      queue = queue.then(() => relay(message))
      return queue
    },
    dispose: () => {
      isClosed = true
    },
  })

  return { source, sink, close: async () => { isClosed = true; await queue } }
}

/** Where the rules of one agent come from: its effective grant for `files`, read fresh each call. */
export interface AgentFilesBackendArgs {
  readonly agentName: string
  readonly agents: Pick<EffectiveAgentReader, 'getAgent'>
  readonly journalDir?: string
}

export function createAgentFilesBackend(args: AgentFilesBackendArgs): FilesBackend {
  const roots = createRootsStore(args.journalDir !== undefined ? { journalDir: args.journalDir } : {})
  return {
    actor: args.agentName,
    roots: async () => rootsOutsideDataDir((await roots.list()).map((root) => root.path), args.journalDir ?? JOURNAL_DIR),
    rules: async () => {
      const agent = await args.agents.getAgent(args.agentName)
      // A revoked or vanished agent has no rights, whatever its grants say.
      if (agent === undefined || agent.revokedAt !== undefined) return []
      return agent.grants[FILES_SERVER_NAME]?.paths ?? []
    },
  }
}

/** The probe only sends `initialize` and `tools/list`: it needs no roots and gives no rights. */
export const PROBE_FILES_BACKEND: FilesBackend = {
  actor: 'probe',
  roots: async () => [],
  rules: async () => [],
}
