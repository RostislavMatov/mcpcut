import { classify, type ClassifiedResponse } from '../protocol/classify.js'
import {
  INITIALIZE_METHOD,
  parseToolsListResult,
  TOOLS_LIST_METHOD,
  type ToolDescriptor,
} from '../protocol/mcp.js'
import type { ResolveEnvRefsFn } from '../proxy/server-env.js'
import type { ServerRecord } from '../registry/schema.js'
import { clientMessage } from '../transport/message.js'
import {
  UpstreamHttpStatusError,
  UpstreamResponseError,
} from '../transport/http/client.js'
import { prepareUpstream, type ConnectUpstream } from '../upstream/prepare.js'
import { PROBE_TIMEOUT_MS } from './constants.js'

/**
 * The probe engine (M5.5 п.1, Task 1; threat model: ADR-0008). One probe =
 * the registry record turned into a live transport by the SAME
 * `prepareUpstream` path `connect` uses (byte-for-byte the confirmed
 * command line / URL + secret names — the probe adds no parameters of its
 * own), one probe message, one measured answer, unconditional cleanup.
 *
 * Probe message by transport/protocol:
 *  - stdio / sessionful / auto http → `initialize` (O4: the first point
 *    where the server proves it speaks MCP);
 *  - `protocol: 'stateless'` → `tools/list`: ADR-0002's `guardInitialize`
 *    forbids handing a stateless upstream a sessionful handshake, so the
 *    metric honestly becomes "time to a valid `tools/list` answer" and the
 *    result says so via `probedVia` (уточнение O4, показано владельцу).
 *
 * The optional `tools/list` step (O8, feeding the shared inventory) runs
 * AFTER the latency measurement — its cost scales with the tool count and
 * would distort the metric (ADR-0008 §3).
 *
 * Secrets: every message here names secrets, never values — inherited from
 * `formatVaultFailure`, and server-controlled text (error messages, raw
 * output) is summarized structurally, never echoed: an hostile server must
 * not get a channel into operator-facing status text or the journal.
 */

export type ProbedVia = typeof INITIALIZE_METHOD | typeof TOOLS_LIST_METHOD

export type ProbeResult =
  | {
      readonly status: 'alive'
      readonly initializeLatencyMs: number
      readonly probedVia: ProbedVia
      readonly tools?: readonly ToolDescriptor[]
    }
  /** The server answered, but not with valid MCP (garbage, JSON-RPC error, HTTP error status). */
  | { readonly status: 'error'; readonly message: string }
  /** The server did not answer at all (timeout, refused connection, dead child). */
  | { readonly status: 'unreachable'; readonly message: string }
  /** The vault refused BEFORE anything was spawned or connected — "could not even try". */
  | { readonly status: 'vault-refused'; readonly message: string }

export interface ProbeDeps {
  /** The control plane's own environment (allowlist slice reaches a child). */
  readonly processEnv: NodeJS.ProcessEnv
  /** Dereferences `vault:` values; typically `resolveVaultRefs` bound to a store. */
  readonly resolveRefs: ResolveEnvRefsFn
  /** Per-step deadline. Defaults to `PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** Also fetch `tools/list` descriptors (registration / refresh probes — O8). */
  readonly withTools?: boolean
  /** Injectable monotonic clock (ms) for the latency measurement. */
  readonly clock?: () => number
  /** Working directory for a spawned child. */
  readonly cwd?: string
  /** Grace period before SIGTERM after the child's stdin was closed. */
  readonly childExitGraceMs?: number
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killEscalationMs?: number
  /** Upstream-level diagnostic lines (stderr-style). Dropped by default. */
  readonly onDiagnostic?: (line: string) => void
}

/** JSON-RPC ids of the probe's own requests (string ids — no collision space). */
const PROBE_REQUEST_ID = 'plane-probe-1'
const TOOLS_REQUEST_ID = 'plane-probe-tools'

/** Probes one registry record. Never throws; every failure is a result. */
export async function probe(record: ServerRecord, deps: ProbeDeps): Promise<ProbeResult> {
  const onDiagnostic = deps.onDiagnostic ?? (() => undefined)
  const prepared = await prepareUpstream({
    record,
    processEnv: deps.processEnv,
    resolveRefs: deps.resolveRefs,
    onDiagnostic,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.childExitGraceMs !== undefined ? { childExitGraceMs: deps.childExitGraceMs } : {}),
    ...(deps.killEscalationMs !== undefined ? { killEscalationMs: deps.killEscalationMs } : {}),
  })
  if (prepared.status === 'refused') {
    return { status: 'vault-refused', message: prepared.message.trim() }
  }

  const probedVia: ProbedVia = prepared.upstream.guardInitialize
    ? TOOLS_LIST_METHOD
    : INITIALIZE_METHOD
  const clock = deps.clock ?? (() => performance.now())
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS

  // The measurement starts BEFORE the spawn/connect (ADR-0008 §3) and the
  // handlers must be registered in the same synchronous block as `open()`.
  const startedAt = clock()
  let upstream: ConnectUpstream
  try {
    upstream = prepared.upstream.open()
  } catch (error: unknown) {
    return { status: 'unreachable', message: `the server could not be started: ${describe(error)}` }
  }
  try {
    return await converse(upstream, probedVia, {
      clock,
      startedAt,
      timeoutMs,
      withTools: deps.withTools === true,
    })
  } finally {
    await shutDown(upstream, onDiagnostic)
  }
}

/** Cleanup that must run whatever the probe decided: no leaked children, no open sockets. */
async function shutDown(upstream: ConnectUpstream, onDiagnostic: (line: string) => void): Promise<void> {
  upstream.endpoints.source.dispose()
  try {
    await upstream.finish()
  } catch (error: unknown) {
    onDiagnostic(`[probe] upstream shutdown: ${describe(error)}\n`)
  }
  upstream.dispose()
}

interface ConverseOptions {
  readonly clock: () => number
  readonly startedAt: number
  readonly timeoutMs: number
  readonly withTools: boolean
}

/** The whole probe conversation: measured probe message, optional tools step. */
async function converse(
  upstream: ConnectUpstream,
  probedVia: ProbedVia,
  opts: ConverseOptions,
): Promise<ProbeResult> {
  const conversation = startConversation(upstream)

  const answer = await conversation.request(buildProbeRequest(probedVia), opts.timeoutMs)
  if (answer.kind !== 'answered') {
    return failureOf(answer, probedVia, opts.timeoutMs)
  }
  if (answer.response.isError) {
    return {
      status: 'error',
      message: `the server answered ${probedVia} with JSON-RPC error code ${answer.response.errorCode}`,
    }
  }
  // The latency is sealed here; the tools step below never touches it (O4).
  const initializeLatencyMs = opts.clock() - opts.startedAt

  const tools = opts.withTools
    ? await toolsOf(conversation, probedVia, answer.response, opts.timeoutMs)
    : undefined
  return {
    status: 'alive',
    initializeLatencyMs,
    probedVia,
    ...(tools !== undefined ? { tools } : {}),
  }
}

/**
 * The `tools/list` step (O8). A stateless probe already IS a `tools/list`,
 * so its own answer is parsed; otherwise the sessionful handshake is
 * completed (`notifications/initialized`) and a real `tools/list` is sent.
 * The server is already proven alive — a failed or malformed tools step
 * yields `undefined`, never a failed probe.
 */
async function toolsOf(
  conversation: Conversation,
  probedVia: ProbedVia,
  probeResponse: ClassifiedResponse,
  timeoutMs: number,
): Promise<readonly ToolDescriptor[] | undefined> {
  if (probedVia === TOOLS_LIST_METHOD) {
    return parseToolsListResult(probeResponse)?.tools
  }
  conversation.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const answer = await conversation.request(
    { jsonrpc: '2.0', id: TOOLS_REQUEST_ID, method: TOOLS_LIST_METHOD, params: {} },
    timeoutMs,
  )
  if (answer.kind !== 'answered' || answer.response.isError) {
    return undefined
  }
  return parseToolsListResult(answer.response)?.tools
}

function buildProbeRequest(probedVia: ProbedVia): Record<string, unknown> {
  if (probedVia === TOOLS_LIST_METHOD) {
    return { jsonrpc: '2.0', id: PROBE_REQUEST_ID, method: TOOLS_LIST_METHOD, params: {} }
  }
  return {
    jsonrpc: '2.0',
    id: PROBE_REQUEST_ID,
    method: INITIALIZE_METHOD,
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-control-plane-probe', version: '0' },
    },
  }
}

/** How one awaited request ended. Only `answered` carries server content. */
type Answer =
  | { readonly kind: 'answered'; readonly response: ClassifiedResponse }
  /** The server produced bytes that are not JSON-RPC. */
  | { readonly kind: 'invalid' }
  /** Stream/process ended before an answer. */
  | { readonly kind: 'closed' }
  | { readonly kind: 'transport-error'; readonly error: unknown }
  | { readonly kind: 'timeout' }

function failureOf(answer: Exclude<Answer, { kind: 'answered' }>, probedVia: ProbedVia, timeoutMs: number): ProbeResult {
  if (answer.kind === 'invalid') {
    // The raw bytes are server-controlled and are deliberately NOT echoed.
    return { status: 'error', message: `the server produced output that is not valid JSON-RPC` }
  }
  if (answer.kind === 'timeout') {
    return { status: 'unreachable', message: `no answer to ${probedVia} within ${timeoutMs}ms` }
  }
  if (answer.kind === 'closed') {
    return { status: 'unreachable', message: `the server ended before answering ${probedVia}` }
  }
  // HTTP-level "answered wrongly" (status/содержимое) is an error; anything
  // else (refused connection, DNS, broken pipe) is unreachable. Both error
  // families are documented to carry status + host only — never header
  // values or bodies (`transport/http/client-errors.ts`).
  if (
    answer.error instanceof UpstreamHttpStatusError ||
    answer.error instanceof UpstreamResponseError
  ) {
    return { status: 'error', message: describe(answer.error) }
  }
  return { status: 'unreachable', message: describe(answer.error) }
}

interface Conversation {
  request(payload: Record<string, unknown>, timeoutMs: number): Promise<Answer>
  notify(payload: Record<string, unknown>): void
}

/**
 * Wires the upstream's source ONCE (one handler per channel — the
 * `MessageSource` contract) and routes responses to awaiting requests by
 * id. Notifications and server-initiated requests are ignored; any
 * non-JSON-RPC output, transport error or stream end settles EVERY pending
 * request — after such an event nothing further can be believed.
 */
function startConversation(upstream: ConnectUpstream): Conversation {
  const pending = new Map<string, (answer: Answer) => void>()
  let terminal: Answer | null = null

  function settleAll(answer: Answer): void {
    if (terminal !== null) return
    terminal = answer
    const waiting = [...pending.values()]
    pending.clear()
    for (const resolve of waiting) {
      resolve(answer)
    }
  }

  upstream.endpoints.source.onMessage((message) => {
    const classified = classify(message.bytes.toString('utf8'))
    if (classified.kind === 'invalid') {
      settleAll({ kind: 'invalid' })
      return
    }
    if (classified.kind !== 'response' || typeof classified.id !== 'string') {
      return
    }
    const resolve = pending.get(classified.id)
    if (resolve !== undefined) {
      pending.delete(classified.id)
      resolve({ kind: 'answered', response: classified })
    }
  })
  upstream.endpoints.source.onError((error) => settleAll({ kind: 'transport-error', error }))
  upstream.endpoints.source.onEnd(() => settleAll({ kind: 'closed' }))
  void upstream.gone.then(() => settleAll({ kind: 'closed' }))

  function request(payload: Record<string, unknown>, timeoutMs: number): Promise<Answer> {
    if (terminal !== null) {
      return Promise.resolve(terminal)
    }
    const id = payload['id'] as string
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ kind: 'timeout' })
      }, timeoutMs)
      timer.unref()
      pending.set(id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      upstream.endpoints.sink
        .write(clientMessage(Buffer.from(JSON.stringify(payload), 'utf8')))
        .catch((error: unknown) => {
          if (pending.delete(id)) {
            clearTimeout(timer)
            resolve({ kind: 'transport-error', error })
          }
        })
    })
  }

  function notify(payload: Record<string, unknown>): void {
    void upstream.endpoints.sink
      .write(clientMessage(Buffer.from(JSON.stringify(payload), 'utf8')))
      .catch(() => undefined)
  }

  return Object.freeze({ request, notify })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
