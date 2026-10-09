import type { IncomingHttpHeaders } from 'node:http'
import { clientMessage, type MessageSource } from '../message.js'
import { HTTP_STATUS_ACCEPTED } from './constants.js'
import { HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_OK } from './server-constants.js'
import {
  abandonedRequestPlan,
  createDeferred,
  RequestAbortedError,
  UpstreamTimeoutError,
  jsonPlan,
  refusalPlan,
  SessionTornDownError,
  type ExpectsResponse,
  type OpenSession,
  type PostOptions,
  type ResponsePlan,
  type SessionContext,
  type ValidateStatelessHeaders,
} from './session-support.js'

/**
 * The stateless half of the session manager (ADR-0002): a POST with no
 * session id that is not an `initialize` gets a session of its own, whose
 * whole life is that one request.
 *
 * Split out of `session.ts` for the < 400-lines rule, but the boundary is
 * a real one: a one-shot exchange has no id, no GET stream, no idle TTL
 * and no place in the sessions map — which is exactly why it needs its own
 * bounds. Nothing here may wait forever:
 *
 *  - the source ENDING without an answer rejects the wait (the upstream
 *    died, or the plane ended the session) → 404, same as a sessionful
 *    session terminated under an in-flight request (matrix §1.5);
 *  - `timeoutMs` bounds a silent upstream → 504;
 *  - the request's `signal` bounds an agent that hung up → 504 nobody reads;
 *  - `terminateAll()` (manager shutdown) ends every exchange still running
 *    and resolves only once their upstreams have actually been closed.
 *
 * In all five exits the upstream is closed and its source disposed in the
 * same `finally`, so no path can leak a child process or a journal sink.
 */

export interface StatelessDeps {
  readonly openSession: OpenSession
  readonly validateStatelessHeaders: ValidateStatelessHeaders
  readonly expectsResponse: ExpectsResponse
  /** How long the single owed message is waited for. */
  readonly timeoutMs: number
  /** Called when the hooks ran but no session will be opened after all. */
  readonly onOpenAbandoned?: (() => void) | undefined
}

export interface StatelessRunner {
  handle(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
    options: PostOptions | undefined,
  ): Promise<ResponsePlan>
  /** Ends every exchange still running; resolves once their upstreams are closed. */
  terminateAll(): Promise<void>
}

/** One exchange still running, reachable from the manager's `close()`. */
interface PendingExchange {
  fail(error: unknown): void
  readonly finished: Promise<void>
}

export function createStatelessRunner(deps: StatelessDeps): StatelessRunner {
  const pending = new Set<PendingExchange>()

  async function handle(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
    options: PostOptions | undefined,
  ): Promise<ResponsePlan> {
    const validation = deps.validateStatelessHeaders(headers, body)
    if (!validation.ok) {
      // The hooks ran but no session will be opened: let the injector drop
      // whatever per-request state it prepared for `openSession`.
      deps.onOpenAbandoned?.()
      return jsonPlan(HTTP_STATUS_BAD_REQUEST, validation.errorBody)
    }
    const opened = await deps.openSession(ctx)
    if ('error' in opened) {
      return refusalPlan(opened)
    }

    // Registered BEFORE the write, so a message that comes back
    // synchronously is still this request's response.
    const wait = awaitFirstMessage(opened.source, {
      timeoutMs: deps.timeoutMs,
      signal: options?.signal,
    })
    const finished = createDeferred<void>()
    const exchange: PendingExchange = { fail: wait.fail, finished: finished.promise }
    pending.add(exchange)
    try {
      await opened.sink.write(clientMessage(body))
      if (!deps.expectsResponse(body)) {
        return Object.freeze({ status: HTTP_STATUS_ACCEPTED })
      }
      return jsonPlan(HTTP_STATUS_OK, await wait.promise)
    } catch (error: unknown) {
      return abandonedRequestPlan(error)
    } finally {
      wait.cancel()
      pending.delete(exchange)
      opened.source.dispose()
      await opened.close().catch(() => undefined)
      finished.resolve()
    }
  }

  async function terminateAll(): Promise<void> {
    const running = [...pending]
    for (const exchange of running) {
      exchange.fail(new SessionTornDownError())
    }
    await Promise.all(running.map((exchange) => exchange.finished))
  }

  return Object.freeze({ handle, terminateAll })
}

/** A pending wait for the single message a one-shot session owes a request. */
export interface FirstMessageWait {
  readonly promise: Promise<Buffer>
  /** Ends the wait with `error` unless it already settled. */
  fail(error: unknown): void
  /** Releases the timer and the abort listener. Idempotent. */
  cancel(): void
}

export interface FirstMessageOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

/**
 * Waits for the first message `source` produces, bounded on every side a
 * one-shot exchange can fail on: an error, the source ending without an
 * answer, the timeout, and the agent going away. The timer is unref'ed —
 * a pending stateless request must not keep the process alive.
 */
export function awaitFirstMessage(
  source: MessageSource,
  opts: FirstMessageOptions,
): FirstMessageWait {
  const deferred = createDeferred<Buffer>()
  // Marks the promise handled the moment it exists: it may reject before
  // the caller awaits it (an already-dead upstream ends synchronously),
  // and an unhandled rejection would take the process down.
  void deferred.promise.catch(() => undefined)

  source.onMessage((message) => deferred.resolve(message.bytes))
  source.onError((error: unknown) => deferred.reject(error))
  source.onEnd(() => deferred.reject(new SessionTornDownError()))

  const timer = setTimeout(() => deferred.reject(new UpstreamTimeoutError()), opts.timeoutMs)
  timer.unref()
  const onAbort = (): void => deferred.reject(new RequestAbortedError())
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted === true) {
    onAbort()
  }

  let isCancelled = false
  return Object.freeze({
    promise: deferred.promise,
    fail: (error: unknown) => deferred.reject(error),
    cancel: (): void => {
      if (isCancelled) return
      isCancelled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    },
  })
}
