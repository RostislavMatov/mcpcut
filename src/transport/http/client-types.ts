import type { UpstreamGuard } from '../../net/upstream-guard.js'
import type { MessageSink, MessageSource } from '../message.js'

/**
 * Public types of the HTTP upstream client (`./client.ts`). Split out of the
 * factory module purely for the < 400-lines-per-file rule; the public import
 * surface stays `client.ts`, which re-exports everything here.
 */

/** Session model pinned in (or defaulted by) the registry record. */
export type HttpUpstreamProtocol = 'sessionful' | 'stateless' | 'auto'

/**
 * The slice of a registry http-record the client needs. Header values must
 * already be dereferenced by the caller (vault refs resolved) — the client
 * treats them as opaque ready-to-send strings.
 */
export interface HttpUpstreamRecord {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly protocol: HttpUpstreamProtocol
}

export interface HttpUpstreamClientOptions {
  /** Value for `MCP-Protocol-Version` on every request (pass-through; unset → header not sent). */
  readonly protocolVersionHeader?: string
  /** Injected semantic hook: extra headers derived from the outgoing bytes (default: none). */
  readonly perMessageHeaders?: (bytes: Buffer) => Record<string, string>
  /** Injected timer (backoff waits, close drain bound). Default: unref'ed setTimeout. */
  readonly delay?: (ms: number) => Promise<void>
  readonly sseReconnectMaxAttempts?: number
  readonly sseReconnectBaseDelayMs?: number
  readonly sseReconnectMaxDelayMs?: number
  readonly closeDrainTimeoutMs?: number
  readonly maxResponseBytes?: number
  /**
   * Deliver a non-2xx POST's JSON body as a message instead of failing (RV4):
   * 2026-07-28 answers method-level errors with 4xx + JSON-RPC body. Status
   * and `content-type` only, nothing parsed; empty/non-JSON bodies and `404`
   * on a live session fail as before. Only pool children and the probe ask.
   */
  readonly deliverErrorBodies?: boolean
  /**
   * Tenant-mode SSRF guard (ADR-0017 T4): checks the URL before every request
   * (POST, GET stream, session DELETE) and resolves the socket's address, so
   * a refused upstream receives nothing at all. Absent: dial as before. The
   * decision whether to pass one lives in `tenant/settings.ts`
   * (`upstreamGuardFor`), never here.
   */
  readonly guard?: UpstreamGuard
}

export interface HttpUpstreamClient {
  readonly source: MessageSource
  readonly sink: MessageSink
  /** DELETEs the session (if any), stops the GET stream, waits (bounded) for in-flight POSTs. Idempotent. */
  close(): Promise<void>
}
