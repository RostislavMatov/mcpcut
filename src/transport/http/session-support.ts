import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { MessageSink, MessageSource } from '../message.js'
import {
  CONTENT_TYPE_JSON,
  HTTP_STATUS_NOT_FOUND,
  MCP_SESSION_ID_HEADER,
} from './constants.js'
import { BODY_NOT_FOUND, HTTP_STATUS_BAD_REQUEST } from './server-constants.js'

/**
 * Contracts and small pure helpers for the downstream session manager
 * (`session.ts`). Split out purely for the < 400-lines-per-file rule (the
 * same precedent as `client-wire.ts` for Task 9's client) — the public
 * surface stays on `session.ts`, which re-exports everything here.
 */

/** Identity of the (agent, server) pair a request was routed to. */
export interface SessionContext {
  readonly agentName: string
  readonly serverName: string
}

/** A live upstream conversation produced by the injected factory. */
export interface OpenedSession {
  readonly sink: MessageSink
  readonly source: MessageSource
  close(): Promise<void>
}

/** Factory refusal; `error` names the reason (`'unknown-server'`, ...). */
export interface OpenSessionRefusal {
  readonly error: string
}

/** Injected session factory (the real one is wired by Task 13's `serve`). */
export type OpenSession = (ctx: SessionContext) => Promise<OpenedSession | OpenSessionRefusal>

/** Semantic hook: is this body an `initialize` request? Default: never. */
export type DetectInitialize = (bytes: Buffer) => boolean

/** Semantic hook result for stateless header↔body validation. */
export type StatelessValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorBody: Buffer }

/** Semantic hook: stateless header↔body validation (`-32020`). Default: always ok. */
export type ValidateStatelessHeaders = (
  headers: IncomingHttpHeaders,
  bytes: Buffer,
) => StatelessValidation

/** Semantic hook: does this body expect a response (request) or not (notification → 202)? */
export type ExpectsResponse = (bytes: Buffer) => boolean

/** What the server should answer; `body` implies `application/json` unless a header says otherwise. */
export interface ResponsePlan {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Buffer
}

export interface SessionManagerOptions {
  readonly openSession: OpenSession
  readonly detectInitialize?: DetectInitialize
  readonly validateStatelessHeaders?: ValidateStatelessHeaders
  readonly expectsResponse?: ExpectsResponse
  readonly maxSessions?: number
  readonly idleTtlMs?: number
  readonly sweepIntervalMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxBufferedMessages?: number
  /** Session id minting override for tests; default `crypto.randomUUID`. */
  readonly uuid?: () => string
  /** Clock override for TTL tests; default `Date.now`. */
  readonly now?: () => number
  /** Diagnostic sink for session-source errors; never receives bodies or headers. */
  readonly onSessionError?: (sessionId: string) => void
}

export interface SessionManager {
  handlePost(ctx: SessionContext, headers: IncomingHttpHeaders, body: Buffer): Promise<ResponsePlan>
  /** Returns `'attached'` when the response became a live SSE stream. */
  handleGet(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    res: ServerResponse,
  ): ResponsePlan | 'attached'
  handleDelete(ctx: SessionContext, headers: IncomingHttpHeaders): Promise<ResponsePlan>
  activeSessionCount(): number
  /** Tears every session down (upstream close, streams ended) and stops the sweeper. */
  close(): Promise<void>
}

/** Signals that a session died while a request waited on its response. */
export class SessionTornDownError extends Error {
  constructor() {
    super('session torn down while a request was in flight')
    this.name = 'SessionTornDownError'
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** First `Mcp-Session-Id` value, if any. Node lowercases header names, so lookup is case-insensitive. */
export function sessionIdOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers[MCP_SESSION_ID_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function jsonPlan(
  status: number,
  body: Buffer,
  headers?: Record<string, string>,
): ResponsePlan {
  return Object.freeze({
    status,
    body,
    headers: Object.freeze({ 'content-type': CONTENT_TYPE_JSON, ...headers }),
  })
}

/** Maps a factory refusal to a plan: unknown server → 404, anything else → 400. */
export function refusalPlan(refusal: OpenSessionRefusal): ResponsePlan {
  if (refusal.error === 'unknown-server') {
    return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_NOT_FOUND)
  }
  return jsonPlan(HTTP_STATUS_BAD_REQUEST, Buffer.from(JSON.stringify({ error: refusal.error })))
}
