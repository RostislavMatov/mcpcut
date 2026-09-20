import type { ZodType } from 'zod'
import {
  BEARER_PREFIX,
  CONSOLE_API_RUN_PATH,
  CONSOLE_API_SETUP_PATH,
  CONSOLE_API_STATE_PATH,
  CONSOLE_API_WHOAMI_PATH,
  CONTENT_TYPE_NDJSON,
  consoleErrorSchema,
  consoleRunFrameSchema,
  consoleSetupRequestSchema,
  consoleSetupResponseSchema,
  consoleStateSchema,
  consoleWhoamiSchema,
  type ConsoleError,
  type ConsoleRunFrame,
  type ConsoleRunRequest,
  type ConsoleSetupRequest,
  type ConsoleSetupResponse,
  type ConsoleState,
  type ConsoleWhoami,
} from '../../console-api/contract.js'
import { messageOf } from '../runtime-terminal.js'
import { FAILED_RUN_EXIT_CODE } from '../run-result.js'

/**
 * The HTTP half of the remote console (ADR-0014, plan wave 2 task 2): the four
 * calls of `src/console-api/contract.ts`, made with an injectable `fetch` and
 * validated on the way back — the client never trusts a response any more
 * than `console-run.ts` trusts a request.
 *
 * Two disciplines the tests hold this module to. First, the token: it travels
 * in exactly one place, the `Authorization` header, and never in a body, a
 * query string or an error message this module builds — a network failure
 * says what went wrong, not what was being sent. Second, no request here EVER
 * carries an `Origin` header: this is a CLI process, not a browser, and the
 * contract's whole CSRF story is that no browser is a caller of this API —
 * adding one by accident would be this module contradicting that story.
 */

/** How long a call waits for a response to START — never for a command to finish. */
export const REMOTE_CONNECT_TIMEOUT_MS = 10_000

const JSON_CONTENT_TYPE = 'application/json'

export type FetchLike = typeof fetch

/**
 * One stream a run writes into: `CliWritable`'s `write`, plus the SAME
 * optional `once('drain')` release `src/tui/run-sink.ts`'s `SinkWritable` and
 * `src/console-api/runner.ts`'s `ConsoleIoWritable` already carry. Optional,
 * so any plain `CliIo` (no backpressure signal at all) is still a `RemoteIo`
 * — this client honours the signal when it is offered and never requires it.
 */
export interface RemoteWritable {
  write(chunk: string): unknown
  once?(event: 'drain', listener: () => void): unknown
}

/** The two streams a run writes to; the same shape `CliIo` gives a dispatched command. */
export interface RemoteIo {
  readonly stdout: RemoteWritable
  readonly stderr: RemoteWritable
}

/**
 * One call's answer: the validated document, or why there is none. `network`
 * covers everything that is not the server's own structured refusal — it
 * could not be reached, it answered with something that is not JSON, or with
 * JSON that does not match the shape this call expects.
 */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: ConsoleError['error'] | 'network'; readonly message: string }

export interface RemoteClientOptions {
  /** Origin only — no trailing slash, no path (`url.ts` already enforced that). */
  readonly baseUrl: string
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  readonly connectTimeoutMs?: number
}

export interface RemoteClient {
  state(): Promise<RemoteOutcome<ConsoleState>>
  whoami(token: string): Promise<RemoteOutcome<ConsoleWhoami>>
  setup(request: ConsoleSetupRequest): Promise<RemoteOutcome<ConsoleSetupResponse>>
  /**
   * Streams a run's two output frames into `io` and answers with the exit
   * code. `onRefusal`, when given, is told the STRUCTURED kind of a non-200
   * answer — `unauthorized`, `forbidden`, and so on — the moment the server's
   * own error document is parsed, and ONLY then: a network failure (no
   * response reached at all) or a response whose body does not match the
   * contract's error shape is not a refusal this call can name a kind for, so
   * it never calls back (ADR-0014 HIGH review — `createRemoteDispatch` uses
   * this to tell an `unauthorized` run apart from a mere network blip without
   * this module changing one byte of what already reaches `io`).
   */
  run(
    request: ConsoleRunRequest,
    token: string,
    io: RemoteIo,
    onRefusal?: (kind: ConsoleError['error']) => void,
  ): Promise<number>
}

/** A failed call, whichever of the several ways that happened. */
interface RemoteFailure {
  readonly kind: ConsoleError['error'] | 'network'
  readonly message: string
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `${BEARER_PREFIX}${token}` }
}

function networkFailure(message: string): RemoteFailure {
  return { kind: 'network', message }
}

function outcomeOf<T>(failure: RemoteFailure): RemoteOutcome<T> {
  return { ok: false, ...failure }
}

/** A `fetch` bounded by `timeoutMs`, reporting a network failure rather than throwing. */
async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly response: Response } | { readonly ok: false; readonly failure: RemoteFailure }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    return { ok: true, response }
  } catch (error: unknown) {
    return { ok: false, failure: networkFailure(`could not reach the remote console: ${messageOf(error)}`) }
  } finally {
    clearTimeout(timer)
  }
}

/** The body of a non-200 response, as the contract's own error document. */
async function refusalOf(response: Response): Promise<RemoteFailure> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return networkFailure(`the remote console refused (HTTP ${response.status}) without a readable reason`)
  }
  const parsed = consoleErrorSchema.safeParse(body)
  return parsed.success
    ? { kind: parsed.data.error, message: parsed.data.message }
    : networkFailure(`the remote console refused (HTTP ${response.status}) without a readable reason`)
}

/** One call whose success answer is a single JSON document, validated by `schema`. */
async function callJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  schema: ZodType<T>,
): Promise<RemoteOutcome<T>> {
  const attempt = await timedFetch(fetchImpl, url, init, timeoutMs)
  if (!attempt.ok) return outcomeOf(attempt.failure)
  const { response } = attempt
  if (response.status !== 200) return outcomeOf(await refusalOf(response))

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return outcomeOf(networkFailure('the remote console answered with something other than JSON'))
  }
  const parsed = schema.safeParse(body)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : outcomeOf(networkFailure('the remote console answered with an unexpected document'))
}

export function createRemoteClient(opts: RemoteClientOptions): RemoteClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.connectTimeoutMs ?? REMOTE_CONNECT_TIMEOUT_MS
  const urlOf = (path: string): string => `${opts.baseUrl}${path}`

  return {
    state: () =>
      callJson(fetchImpl, urlOf(CONSOLE_API_STATE_PATH), { method: 'GET' }, timeoutMs, consoleStateSchema),

    whoami: (token) =>
      callJson(
        fetchImpl,
        urlOf(CONSOLE_API_WHOAMI_PATH),
        { method: 'POST', headers: authHeaders(token) },
        timeoutMs,
        consoleWhoamiSchema,
      ),

    setup: (request) =>
      callJson(
        fetchImpl,
        urlOf(CONSOLE_API_SETUP_PATH),
        {
          method: 'POST',
          headers: { 'content-type': JSON_CONTENT_TYPE },
          body: JSON.stringify(consoleSetupRequestSchema.parse(request)),
        },
        timeoutMs,
        consoleSetupResponseSchema,
      ),

    run: (request, token, io, onRefusal) =>
      runRemote(fetchImpl, urlOf(CONSOLE_API_RUN_PATH), request, token, io, timeoutMs, onRefusal),
  }
}

/** Writes one failure line and answers with the run's fixed failure code — never 0. */
function failedRun(io: RemoteIo, message: string): number {
  io.stderr.write(`${message}\n`)
  return FAILED_RUN_EXIT_CODE
}

async function runRemote(
  fetchImpl: FetchLike,
  url: string,
  request: ConsoleRunRequest,
  token: string,
  io: RemoteIo,
  timeoutMs: number,
  onRefusal?: (kind: ConsoleError['error']) => void,
): Promise<number> {
  const attempt = await timedFetch(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: { 'content-type': JSON_CONTENT_TYPE, accept: CONTENT_TYPE_NDJSON, ...authHeaders(token) },
      body: JSON.stringify(request),
    },
    timeoutMs,
  )
  if (!attempt.ok) return failedRun(io, attempt.failure.message)
  const { response } = attempt
  if (response.status !== 200) {
    const refusal = await refusalOf(response)
    // Only a refusal this call could actually PLACE gets reported: `network`
    // here means the body did not match the contract's error shape at all, so
    // there is no real `ConsoleError['error']` kind to hand back.
    if (refusal.kind !== 'network') onRefusal?.(refusal.kind)
    return failedRun(io, refusal.message)
  }

  return streamFrames(response, io)
}

/** What draining the lines found so far in `text` came to. */
interface DrainOutcome {
  /** What is left after the last complete line — a partial line, or nothing. */
  readonly rest: string
  readonly exitCode?: number
  readonly failure?: string
}

const MALFORMED_FRAME_MESSAGE = 'remote run: a malformed line arrived in the response'

/**
 * Cap on one NDJSON line still awaiting its terminating `\n`, in UTF-16 code
 * units (review finding 5). The contract puts no bound on a frame's `d`
 * field (`contract.ts`'s `consoleRunFrameSchema` — a command's own stdout can
 * be long), so this is not derived from a contract constant but is the same
 * kind of round, generous "nothing a real command produces before its next
 * newline" ceiling `MAX_RUN_STDIN_LENGTH` is for a request body. Past it, a
 * line that never terminates is treated exactly like one that never parses:
 * the run fails and the body is cancelled, rather than the buffer growing
 * without bound for as long as a hostile or broken server keeps the
 * connection open.
 */
const MAX_PENDING_LINE_CHARS = 1024 * 1024

function parseFrameLine(line: string): { readonly ok: true; readonly frame: ConsoleRunFrame } | { readonly ok: false } {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false }
  }
  const parsed = consoleRunFrameSchema.safeParse(json)
  return parsed.success ? { ok: true, frame: parsed.data } : { ok: false }
}

/** Resolves on the writable's next `'drain'`; a writable without `once` resolves at once. */
function drained(writable: RemoteWritable): Promise<void> {
  const once = writable.once
  if (typeof once !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    once.call(writable, 'drain', () => resolve())
  })
}

/**
 * Consumes every COMPLETE line of `text` (terminated by `\n`), writing `out`
 * and `err` frames to `io` as they are found, and stops at the first `exit`
 * frame or the first line that will not parse — exactly one of `rest`
 * continuing, `exitCode` or `failure` answers.
 *
 * Backpressure of the LOCAL sink is honoured the same way `export-cmd.ts`'s
 * `writeDocs` honours a real file stream's (review finding 4): a `write()`
 * that answers exactly `false` means the sink's own buffer is full — an
 * `export` piped to a slow disk is the case that matters — and this function
 * pauses on that sink's `'drain'` before writing the NEXT frame, or reading
 * another byte off the network. A sink with no `once` (a plain in-memory
 * pane, `CaptureWritable`) never signals backpressure and this never waits.
 */
async function drainLines(text: string, io: RemoteIo): Promise<DrainOutcome> {
  let rest = text
  for (;;) {
    const newlineIndex = rest.indexOf('\n')
    if (newlineIndex === -1) {
      // No complete line yet: if this pending fragment alone is already past
      // the cap, no amount of further waiting will make it a well-formed
      // frame — fail now rather than buffering it (and everything the server
      // sends after it) forever.
      if (rest.length > MAX_PENDING_LINE_CHARS) return { rest: '', failure: MALFORMED_FRAME_MESSAGE }
      return { rest }
    }

    const line = rest.slice(0, newlineIndex)
    rest = rest.slice(newlineIndex + 1)
    if (line.trim() === '') continue

    const parsed = parseFrameLine(line)
    if (!parsed.ok) return { rest: '', failure: MALFORMED_FRAME_MESSAGE }
    if (parsed.frame.t === 'exit') return { rest: '', exitCode: parsed.frame.code }

    const target = parsed.frame.t === 'out' ? io.stdout : io.stderr
    if (target.write(parsed.frame.d) === false) await drained(target)
  }
}

/** Releases the stream without waiting for it or throwing over a body that cannot cancel. */
function cancelQuietly(body: ReadableStream<Uint8Array>): void {
  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // A body that cannot be cancelled is not this function's problem.
  }
}

/**
 * The NDJSON body of a 200 answer, frame by frame. `TextDecoder` is fed one
 * chunk at a time with `{ stream: true }`, so a multi-byte character split
 * across two chunks decodes correctly instead of becoming U+FFFD twice.
 */
async function streamFrames(response: Response, io: RemoteIo): Promise<number> {
  const body = response.body
  if (body === null) return failedRun(io, 'remote run: the response carried no body')

  const decoder = new TextDecoder()
  let buffer = ''
  try {
    // The cast is for the TYPE, not the runtime: `lib.dom`'s `ReadableStream`
    // (what `Response.body` is typed as here) declares no `Symbol.asyncIterator`
    // at all, but Node's own `fetch` hands back a body that really does
    // implement one — `for await` below works today on every runtime this
    // project targets; only the ambient DOM lib type is behind.
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const outcome = await drainLines(buffer, io)
      buffer = outcome.rest
      if (outcome.failure !== undefined) {
        cancelQuietly(body)
        return failedRun(io, outcome.failure)
      }
      if (outcome.exitCode !== undefined) {
        cancelQuietly(body)
        return outcome.exitCode
      }
    }
  } catch (error: unknown) {
    return failedRun(io, `remote run: connection lost (${messageOf(error)})`)
  }

  // The stream ended: flush the decoder and give a trailing, non-newline-
  // terminated line one last chance to parse before giving up on it.
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    const outcome = await drainLines(`${buffer}\n`, io)
    if (outcome.failure !== undefined) return failedRun(io, outcome.failure)
    if (outcome.exitCode !== undefined) return outcome.exitCode
  }

  return failedRun(io, 'remote run: the connection ended before the command finished')
}
