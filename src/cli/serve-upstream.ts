import type { Readable } from 'node:stream'
import { createFrameSplitter } from '../protocol/split.js'
import { perMessageHeadersOptionOf } from '../session/per-message-headers.js'
import { buildServerEnv, type ResolveEnvRefsFn } from '../proxy/server-env.js'
import { killWithEscalation, spawnServer, type ServerHandle } from '../proxy/spawn.js'
import { createOrderedWriter } from '../proxy/writer.js'
import type { ServerRecord } from '../registry/schema.js'
import { createHttpUpstreamClient } from '../transport/http/client.js'
import { frameToMessage, createStdioMessageSink } from '../transport/stdio-adapter.js'
import type { McpMessage, MessageSink, MessageSource } from '../transport/message.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import {
  protocolMismatchRefusal,
  REFUSAL_INVALID_VAULT_REFS,
  REFUSAL_MISSING_SECRETS,
  REFUSAL_VAULT_ERROR,
  type DownstreamModel,
} from './serve-constants.js'

/**
 * Upstream side of one `serve` session (M3 Task 13): turns a registry record
 * into the `MessageSource`/`MessageSink` pair `session/core.ts` relays
 * through, for both transports.
 *
 * - **stdio**: the child's environment is assembled by `proxy/server-env.ts`
 *   (system allowlist + declared env + dereferenced vault refs) and handed to
 *   `spawnServer` as an explicit record — a registry server never inherits
 *   the plane's environment. Framing reuses the M1/M2 blocks unchanged
 *   (`protocol/split.ts` + `proxy/writer.ts` + `transport/stdio-adapter.ts`),
 *   so the bytes on the child's pipes are exactly what `wrap` would produce.
 * - **http**: `transport/http/client.ts`, with the per-message header mirror
 *   (`Mcp-Method`/`Mcp-Name`, SEP-2243) injected for every model except a
 *   pinned `sessionful` one, which predates those headers.
 *
 * Two deliberate departures from the stdio pipeline's frame handling, both
 * because the destination here is HTTP rather than another stdio wire:
 *  - blank frames are dropped instead of forwarded — a blank line has no
 *    HTTP representation, and letting one through would resolve an agent's
 *    in-flight POST with an empty body;
 *  - `'overflow'` frames are dropped and reported, never converted (C1) —
 *    the same fail-closed rule `proxy/pipeline.ts` applies.
 *
 * Nothing here logs env values, header values or bodies: the vault-resolved
 * material exists only in the child's `env` record and the client's header
 * map. Failure reports carry secret NAMES (never values) and go to the
 * plane's stderr only — the agent gets a bare refusal code.
 */

/** The upstream half of a session, plus its own teardown. */
export interface UpstreamEndpoints {
  readonly source: MessageSource
  readonly sink: MessageSink
  /** Stops the transport (kills the child / closes the HTTP client). Idempotent. */
  close(): Promise<void>
}

export type OpenUpstreamResult =
  | { readonly status: 'opened'; readonly upstream: UpstreamEndpoints }
  /** `error` is the factory refusal code the agent sees; `detail` is stderr-only. */
  | { readonly status: 'refused'; readonly error: string; readonly detail?: string }

export interface OpenUpstreamDeps {
  /** The plane's own environment; only the allowlisted slice is passed on. */
  readonly processEnv: NodeJS.ProcessEnv
  readonly envAllowlist: readonly string[]
  /** `vault:` dereferencing, bound to the vault store by the caller. */
  readonly resolveRefs: ResolveEnvRefsFn
  /** Receives one redacted stderr line from a stdio child (journaling is the caller's). */
  readonly onServerStderr: (line: string) => void
  /** Reports a transport-level failure of a live upstream (never bodies). */
  readonly onError: (error: unknown) => void
  /** SIGKILL grace period for a child that ignores SIGTERM. */
  readonly killEscalationMs?: number
}

/**
 * ADR-0002 mismatch matrix, downstream model × upstream record. `auto` is
 * compatible with both downstream models (the client pins the real one from
 * the first response). Returns the refusal text, or `null` when the pair is
 * transportable.
 */
export function checkModelCompatibility(
  model: DownstreamModel,
  record: ServerRecord,
): string | null {
  if (model === 'sessionful') {
    if (record.transport === 'http' && record.protocol === 'stateless') {
      return protocolMismatchRefusal(
        model,
        record.name,
        'registered as a stateless (2026-07-28) HTTP server',
      )
    }
    return null
  }
  if (record.transport === 'stdio') {
    return protocolMismatchRefusal(
      model,
      record.name,
      'a stdio server that expects the sessionful initialize handshake',
    )
  }
  if (record.protocol === 'sessionful') {
    return protocolMismatchRefusal(model, record.name, 'registered as a sessionful HTTP server')
  }
  return null
}

/** Maps a vault/env resolution failure to a refusal code + a stderr-only detail. */
function refuseEnvFailure(
  failure: Exclude<ResolveVaultRefsResult, { status: 'resolved' }>,
): OpenUpstreamResult {
  if (failure.status === 'missing-secrets') {
    return {
      status: 'refused',
      error: REFUSAL_MISSING_SECRETS,
      detail: `vault secrets are missing: ${failure.missing.join(', ')}`,
    }
  }
  if (failure.status === 'invalid-refs') {
    return {
      status: 'refused',
      error: REFUSAL_INVALID_VAULT_REFS,
      detail: `invalid vault references: ${failure.refs.join(', ')}`,
    }
  }
  return {
    status: 'refused',
    error: REFUSAL_VAULT_ERROR,
    detail: `vault unavailable: ${failure.failure.status}`,
  }
}

export async function openUpstream(
  record: ServerRecord,
  deps: OpenUpstreamDeps,
): Promise<OpenUpstreamResult> {
  if (record.transport === 'stdio') {
    return openStdioUpstream(record, deps)
  }
  return openHttpUpstream(record, deps)
}

async function openStdioUpstream(
  record: Extract<ServerRecord, { transport: 'stdio' }>,
  deps: OpenUpstreamDeps,
): Promise<OpenUpstreamResult> {
  const built = await buildServerEnv({
    processEnv: deps.processEnv,
    allowlist: deps.envAllowlist,
    declaredEnv: record.env ?? {},
    resolveRefs: deps.resolveRefs,
  })
  if (built.status !== 'built') {
    return refuseEnvFailure(built)
  }

  const handle = spawnServer(record.command, record.args ?? [], { env: built.env })
  return { status: 'opened', upstream: wrapStdioHandle(handle, deps) }
}

/** Wires a spawned child's three pipes into the message contract. */
function wrapStdioHandle(handle: ServerHandle, deps: OpenUpstreamDeps): UpstreamEndpoints {
  const source = createChildMessageSource(handle.stdout, deps)
  const writer = createOrderedWriter(handle.stdin, { onError: deps.onError })
  const sink = createStdioMessageSink(writer)
  const stderrLines = createLineReader(deps.onServerStderr)
  handle.stderr.on('data', (chunk: Buffer) => stderrLines.push(chunk))

  // A child that dies (or never started) ends the conversation; the session
  // core reacts to `onEnd` exactly as it would to a closed socket.
  handle.exitCode().then(
    () => source.end(),
    (error: unknown) => {
      deps.onError(error)
      source.end()
    },
  )

  let closePromise: Promise<void> | null = null
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      source.dispose()
      sink.dispose()
      killWithEscalation(handle, 'SIGTERM', deps.killEscalationMs)
      await handle.exitCode().catch(() => undefined)
    })()
    return closePromise
  }

  return Object.freeze({ source: source.source, sink, close })
}

/** A `MessageSource` over a child's stdout, plus the end signal its owner fires. */
interface ChildSource {
  readonly source: MessageSource
  end(): void
  dispose(): void
}

function createChildMessageSource(stdout: Readable, deps: OpenUpstreamDeps): ChildSource {
  const splitter = createFrameSplitter()
  let onMessage: ((message: McpMessage) => void) | null = null
  let onEnd: (() => void) | null = null
  let isDisposed = false
  let hasEnded = false

  function deliver(chunk: Buffer | null): void {
    if (isDisposed) return
    const frames = chunk === null ? splitter.flush() : splitter.push(chunk)
    for (const frame of frames) {
      if (isDisposed) return
      if (frame.reason === 'overflow') {
        deps.onError(new Error(`dropped an oversized unterminated upstream fragment (${frame.bytes.length} bytes)`))
        continue
      }
      if (frame.isBlank) continue
      onMessage?.(frameToMessage(frame, 'server'))
    }
  }

  const onData = (chunk: Buffer): void => deliver(chunk)
  const onStreamError = (error: unknown): void => deps.onError(error)
  stdout.on('data', onData)
  stdout.on('error', onStreamError)

  function end(): void {
    if (hasEnded || isDisposed) return
    hasEnded = true
    deliver(null)
    onEnd?.()
  }

  const source: MessageSource = Object.freeze({
    onMessage: (handler: (message: McpMessage) => void) => {
      onMessage = handler
    },
    onError: () => {
      // Upstream transport failures are reported through `deps.onError`, not
      // as a source error: a stdio child's own death arrives as `onEnd`.
    },
    onEnd: (handler: () => void) => {
      onEnd = handler
    },
    dispose: () => {
      isDisposed = true
      stdout.removeListener('data', onData)
      stdout.removeListener('error', onStreamError)
    },
  })

  return { source, end, dispose: () => source.dispose() }
}

/** Splits a stream of chunks into text lines for the stderr journal tap. */
function createLineReader(onLine: (line: string) => void): { push(chunk: Buffer): void } {
  let buffered = ''
  return {
    push: (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length > 0) onLine(line)
      }
    },
  }
}

async function openHttpUpstream(
  record: Extract<ServerRecord, { transport: 'http' }>,
  deps: OpenUpstreamDeps,
): Promise<OpenUpstreamResult> {
  const resolved = await deps.resolveRefs({ ...record.headers })
  if (resolved.status !== 'resolved') {
    return refuseEnvFailure(resolved)
  }

  const client = createHttpUpstreamClient(
    { url: record.url, headers: resolved.values, protocol: record.protocol },
    // Shared with connect — session/per-message-headers.ts is the single
    // owner of the "who gets the SEP-2243 header mirror" decision.
    perMessageHeadersOptionOf(record.protocol),
  )
  // The source's error/end handlers belong to the session core (one handler
  // per channel — `transport/message.ts`); it ends the session on either.

  return { status: 'opened', upstream: Object.freeze({ source: client.source, sink: client.sink, close: client.close }) }
}
