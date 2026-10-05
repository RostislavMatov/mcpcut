import type { EffectiveAgentReader } from '../agents/effective-reader.js'
import type { MessageSink, MessageSource, McpMessage } from '../transport/message.js'
import { serverMessage } from '../transport/message.js'
import { FILES_SERVER_NAME } from './constants.js'
import { JOURNAL_DIR } from '../config.js'
import { rootsOutsideDataDir } from './data-overlap.js'
import { createRootsStore } from './roots-store.js'
import { createIndexRulesStore } from './search/index-rules-store.js'
import { createSearchBackend, type SearchBackend, type SearchSeams } from './search/search-backend.js'
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
  /** True when an index rule is on, so `search_files` is listed; absent means not listed. */
  readonly searchListed?: () => Promise<boolean>
  /** The search by meaning behind `search_files`. */
  readonly search?: SearchBackend
  /** Releases what the backend holds (the search pool and model) when the file server closes. */
  readonly dispose?: () => Promise<void>
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

  async function close(): Promise<void> {
    isClosed = true
    await queue
    try {
      await backend.dispose?.()
    } catch (error: unknown) {
      onError(error)
    }
  }

  return { source, sink, close }
}

/** Where the rules of one agent come from: its effective grant for `files`, read fresh each call. */
export interface AgentFilesBackendArgs {
  readonly agentName: string
  readonly agents: Pick<EffectiveAgentReader, 'getAgent'>
  readonly journalDir?: string
  /** The CLI prefix for the commands inside search problems; `mcpcut` by default. */
  readonly cli?: string
  readonly env?: NodeJS.ProcessEnv
  /** A search backend shared by many sessions (`serve`): its owner closes it, not this backend. */
  readonly search?: SearchBackend
  /** Test seams for the search backend this one builds when none is shared. */
  readonly searchSeams?: SearchSeams
}

/** True when at least one index rule is on; a store that cannot be read means not listed. */
async function hasEnabledIndexRule(journalDir: string | undefined): Promise<boolean> {
  try {
    const rules = await createIndexRulesStore(journalDir !== undefined ? { journalDir } : {}).list()
    return rules.some((rule) => rule.enabled)
  } catch {
    return false
  }
}

/** The shared search backend, or one of its own (closed with the file server). */
function searchOf(args: AgentFilesBackendArgs): { readonly search: SearchBackend; readonly dispose?: () => Promise<void> } {
  if (args.search !== undefined) return { search: args.search }
  const own = createSearchBackend({
    journalDir: args.journalDir ?? JOURNAL_DIR,
    cli: args.cli ?? 'mcpcut',
    ...(args.env !== undefined ? { env: args.env } : {}),
    ...args.searchSeams,
  })
  return { search: own, dispose: () => own.close() }
}

export function createAgentFilesBackend(args: AgentFilesBackendArgs): FilesBackend {
  const roots = createRootsStore(args.journalDir !== undefined ? { journalDir: args.journalDir } : {})
  const { search, dispose } = searchOf(args)
  return {
    search,
    searchListed: () => hasEnabledIndexRule(args.journalDir),
    ...(dispose !== undefined ? { dispose } : {}),
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
  // The probe lists every tool, so that "Create policy" sees `search_files` too.
  searchListed: async () => true,
  roots: async () => [],
  rules: async () => [],
}
