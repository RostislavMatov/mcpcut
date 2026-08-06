import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentsStore, type AgentsStore } from '../../../src/agents/store.js'
import {
  serverMessage,
  type MessageSink,
  type MessageSource,
} from '../../../src/transport/message.js'
import {
  createHttpFront,
  type HttpFront,
  type HttpFrontOptions,
} from '../../../src/transport/http/server.js'
import type {
  OpenSession,
  OpenedSession,
  SessionContext,
} from '../../../src/transport/http/session.js'

/**
 * Shared plumbing for the downstream HTTP front tests (Task 10): a fake
 * echo session factory standing in for session-core (Tasks 11/13), the
 * standard semantic test hooks, and a started front bound to an ephemeral
 * port with a real agents store in a temp journal dir.
 */

// ---------------------------------------------------------------------------
// Standard semantic hooks used by the tests (the real ones come from
// session-core; these are deliberately string-marker based).
// ---------------------------------------------------------------------------

/** Body marker that makes `detectInitialize` fire in tests. */
export const INITIALIZE_BODY = '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

/** Marker that makes `expectsResponse` return false (a notification). */
export const NO_RESPONSE_MARKER = 'no-response'

export function testDetectInitialize(bytes: Buffer): boolean {
  return bytes.toString('utf8').includes('"initialize"')
}

export function testExpectsResponse(bytes: Buffer): boolean {
  return !bytes.toString('utf8').includes(NO_RESPONSE_MARKER)
}

// ---------------------------------------------------------------------------
// Fake session factory (echo by default)
// ---------------------------------------------------------------------------

/** Control handle over one fake session the factory opened. */
export interface FakeSessionControl {
  readonly ctx: SessionContext
  /** Bodies the front wrote into the session, in order. */
  readonly written: Buffer[]
  /** Emits a server-initiated message into the source. */
  push(text: string): void
  /** Fires the source's `onError` (transport failure on the upstream side). */
  fail(error: unknown): void
  /** Fires the source's `onEnd` (upstream conversation over). */
  end(): void
  isClosed(): boolean
  isDisposed(): boolean
}

export interface FakeFactoryOptions {
  /** Reply computed per written body; `null` → no reply is emitted. Default: echo. */
  readonly respond?: (bytes: Buffer) => string | null
  /** Refuse every open with `{ error }` instead of a session. */
  readonly refuseWith?: string
  /** Throw from `openSession` (drives the 500 branch). */
  readonly throwError?: Error
}

export interface FakeSessionFactory {
  readonly openSession: OpenSession
  /** Every session opened so far, in creation order. */
  readonly handles: FakeSessionControl[]
}

export function createFakeSessionFactory(options: FakeFactoryOptions = {}): FakeSessionFactory {
  const handles: FakeSessionControl[] = []
  const respond = options.respond ?? ((bytes: Buffer) => bytes.toString('utf8'))

  const openSession: OpenSession = (ctx) => {
    if (options.throwError !== undefined) {
      return Promise.reject(options.throwError)
    }
    if (options.refuseWith !== undefined) {
      return Promise.resolve({ error: options.refuseWith })
    }

    let onMessage: ((message: ReturnType<typeof serverMessage>) => void) | null = null
    let onError: ((error: unknown) => void) | null = null
    let onEnd: (() => void) | null = null
    let isDisposed = false
    let isClosed = false
    const written: Buffer[] = []

    const emit = (text: string): void => {
      if (!isDisposed) {
        onMessage?.(serverMessage(Buffer.from(text, 'utf8')))
      }
    }

    const sink: MessageSink = {
      write: (message) => {
        written.push(message.bytes)
        const reply = respond(message.bytes)
        if (reply !== null) {
          queueMicrotask(() => emit(reply))
        }
        return Promise.resolve()
      },
      dispose: () => undefined,
    }

    const source: MessageSource = {
      onMessage: (handler) => {
        onMessage = handler
      },
      onError: (handler) => {
        onError = handler
      },
      onEnd: (handler) => {
        onEnd = handler
      },
      dispose: () => {
        isDisposed = true
      },
    }

    const control: FakeSessionControl = {
      ctx,
      written,
      push: emit,
      fail: (error: unknown) => {
        if (!isDisposed) onError?.(error)
      },
      end: () => onEnd?.(),
      isClosed: () => isClosed,
      isDisposed: () => isDisposed,
    }
    handles.push(control)

    const opened: OpenedSession = {
      sink,
      source,
      close: () => {
        isClosed = true
        return Promise.resolve()
      },
    }
    return Promise.resolve(opened)
  }

  return { openSession, handles }
}

// ---------------------------------------------------------------------------
// Minimal ServerResponse stand-in (good enough for `openSseStream`)
// ---------------------------------------------------------------------------

export interface FakeRes {
  readonly res: ServerResponse
  readonly chunks: string[]
  writtenText(): string
  emitClose(): void
  isEnded(): boolean
}

export function createFakeRes(): FakeRes {
  const emitter = new EventEmitter()
  const chunks: string[] = []
  let ended = false
  const res = {
    writeHead: (_status: number, _headers: Record<string, string>) => res,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: () => {
      ended = true
      emitter.emit('close')
      return res
    },
    on: (event: string, handler: () => void) => {
      emitter.on(event, handler)
      return res
    },
    once: (event: string, handler: () => void) => {
      emitter.once(event, handler)
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    chunks,
    writtenText: () => chunks.join(''),
    emitClose: () => emitter.emit('close'),
    isEnded: () => ended,
  }
}

// ---------------------------------------------------------------------------
// Started front
// ---------------------------------------------------------------------------

export interface StartedFront {
  readonly front: HttpFront
  readonly port: number
  readonly baseUrl: string
  readonly agentsStore: AgentsStore
  readonly agentName: string
  readonly token: string
  readonly factory: FakeSessionFactory
  /** `/agents/<agent>/servers/<server>` path for the default identities. */
  path(agent?: string, server?: string): string
  /** Fetch against the front with the Bearer token attached by default. */
  call(
    method: string,
    path: string,
    init?: { body?: string; headers?: Record<string, string>; noAuth?: boolean },
  ): Promise<Response>
  dispose(): Promise<void>
}

export const DEFAULT_AGENT = 'bot'
export const DEFAULT_SERVER = 'github'

/** Starts a front on an ephemeral port with an agent `bot` already created. */
export async function startFront(
  overrides: Partial<HttpFrontOptions> = {},
  factory: FakeSessionFactory = createFakeSessionFactory(),
): Promise<StartedFront> {
  const journalDir = mkdtempSync(join(tmpdir(), 'http-front-test-'))
  const agentsStore = createAgentsStore({ journalDir })
  const { token } = await agentsStore.createAgent(DEFAULT_AGENT)

  const front = createHttpFront({
    agentsStore,
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    ...overrides,
  })
  const { port } = await front.listen(0)
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    front,
    port,
    baseUrl,
    agentsStore,
    agentName: DEFAULT_AGENT,
    token,
    factory,
    path: (agent = DEFAULT_AGENT, server = DEFAULT_SERVER) => `/agents/${agent}/servers/${server}`,
    call: (method, path, init = {}) =>
      fetch(`${baseUrl}${path}`, {
        method,
        body: init.body,
        headers: {
          ...(init.noAuth === true ? {} : { authorization: `Bearer ${token}` }),
          ...init.headers,
        },
      }),
    dispose: async () => {
      await front.close()
      rmSync(journalDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// SSE reading helper
// ---------------------------------------------------------------------------

export interface SseCapture {
  readonly status: number
  readonly contentType: string
  /** Complete `data:` events decoded so far (multi-line data joined with \n). */
  readonly events: string[]
  /** Everything received so far, verbatim (comments/heartbeats included). */
  raw(): string
  close(): void
}

/** Opens a GET stream on the front and incrementally decodes its events. */
export async function openSseCapture(
  started: StartedFront,
  path: string,
  headers: Record<string, string>,
): Promise<SseCapture> {
  const controller = new AbortController()
  const response = await fetch(`${started.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${started.token}`, ...headers },
    signal: controller.signal,
  })

  const events: string[] = []
  let text = ''

  const pump = async (): Promise<void> => {
    if (response.body === null) {
      return
    }
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      text += decoder.decode(chunk as Uint8Array, { stream: true })
      // Re-derive events from the full text each time (test-grade parser).
      const blocks = text.split('\n\n')
      events.length = 0
      for (const block of blocks.slice(0, -1)) {
        const dataLines = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data: ?/, ''))
        if (dataLines.length > 0) {
          events.push(dataLines.join('\n'))
        }
      }
    }
  }
  void pump().catch(() => undefined)

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    events,
    raw: () => text,
    close: () => controller.abort(),
  }
}
