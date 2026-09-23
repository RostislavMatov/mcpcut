import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import type { JournalRecord } from '../../src/journal/record.js'
import type { Policy } from '../../src/policy/schema.js'
import { runWrap, type RunWrapOptions } from '../../src/proxy/wrap.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Shared test harness for the proxy lifecycle tests: fixture paths, polling,
 * journal reading, and the injected client-facing streams used to drive
 * runWrap without touching the real process stdio.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

export const FAKE_SERVER_PATH = join(__dirname, '../fixtures/fake-server.mjs')
export const BURST_SERVER_PATH = join(__dirname, '../fixtures/burst-server.mjs')
export const DYING_SERVER_PATH = join(__dirname, '../fixtures/dying-server.mjs')
/** Multi-tool fixture (see the file itself): tools/list filtering and quarantine scenarios. */
export const POLICY_SERVER_PATH = join(__dirname, '../fixtures/policy-server.mjs')

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 5000

/** Polls an async predicate until it is true or the timeout elapses; mirrors `waitUntil`. */
export async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('waitUntilAsync: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * Polls until `predicate` is true or the timeout elapses.
 *
 * The predicate may be async. A version that only accepted `boolean` silently
 * returned at once when handed an `async` one — a Promise is always truthy —
 * so every assertion after it raced the thing it was waiting for. Awaiting is
 * a no-op for a sync predicate.
 */
export async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export { readJournalRecords }

export interface ClientHarness {
  readonly clientOutbox: PassThrough
  readonly clientInboxChunks: Buffer[]
  readonly clientStdout: PassThrough
  readonly clientStderr: PassThrough
  readonly clientStderrChunks: Buffer[]
  /** Number of complete newline-terminated lines received so far on clientStdout. */
  receivedLineCount(): number
  /** Everything written to clientStderr so far (server stderr passthrough plus any diagnostics). */
  receivedStderrText(): string
}

/** Builds the injected client-facing streams used to drive runWrap in tests. */
export function createClientHarness(): ClientHarness {
  const clientOutbox = new PassThrough()
  const clientStdout = new PassThrough()
  const clientInboxChunks: Buffer[] = []
  clientStdout.on('data', (chunk: Buffer) => clientInboxChunks.push(chunk))
  const clientStderr = new PassThrough()
  const clientStderrChunks: Buffer[] = []
  clientStderr.on('data', (chunk: Buffer) => clientStderrChunks.push(chunk))
  clientStderr.resume()

  function receivedLineCount(): number {
    const text = Buffer.concat(clientInboxChunks).toString('utf8')
    return text.split('\n').filter((line) => line.length > 0).length
  }

  function receivedStderrText(): string {
    return Buffer.concat(clientStderrChunks).toString('utf8')
  }

  return {
    clientOutbox,
    clientInboxChunks,
    clientStdout,
    clientStderr,
    clientStderrChunks,
    receivedLineCount,
    receivedStderrText,
  }
}

export interface SlowWritable {
  readonly writable: Writable
  readonly chunks: Buffer[]
  /** Number of complete newline-terminated lines acknowledged so far. */
  receivedLineCount(): number
}

/**
 * A destination that acknowledges each write only after `delayMs`, modelling a
 * client that reads slowly. A chunk counts as "received" only once the slow
 * consumer has actually taken it, which is what the drain guarantee is about.
 */
export function createSlowWritable(delayMs: number, highWaterMark = 1): SlowWritable {
  const chunks: Buffer[] = []
  const writable = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      setTimeout(() => {
        chunks.push(chunk)
        callback()
      }, delayMs)
    },
  })

  function receivedLineCount(): number {
    return Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0).length
  }

  return { writable, chunks, receivedLineCount }
}

/** Builds one newline-terminated JSON-RPC request line. */
export function requestLine(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

/**
 * Builds the JSON text of one JSON-RPC request, with no line terminator at
 * all. For tests that need to control framing themselves (a `\r\n`
 * terminator, a blank line, an unterminated trailing fragment) rather than
 * always getting `requestLine`'s plain `\n`.
 */
export function requestJson(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

/** Every JSON message a `ClientHarness` has received on `clientStdout`, in order. */
export function receivedMessagesOf(harness: ClientHarness): Array<Record<string, unknown>> {
  return Buffer.concat(harness.clientInboxChunks)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export interface StartedSession {
  readonly sessionId: string
  readonly harness: ClientHarness
  readonly runPromise: Promise<number>
}

export interface StartProxySessionArgs {
  readonly command: string
  readonly args?: readonly string[]
  readonly journalDir: string
  readonly sessionId?: string
  readonly policy?: Policy
  readonly serverName?: string
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  readonly failClosed?: boolean
  readonly journalCommitBatchImpl?: RunWrapOptions['journalCommitBatchImpl']
}

/** Grace periods short enough for tests, long enough not to be flaky under load. */
const SESSION_KILL_ESCALATION_MS = 500
const SESSION_RELAY_DRAIN_TIMEOUT_MS = 1000

/**
 * Starts one `runWrap` session against injected client-facing streams,
 * without writing or ending anything on them yet. Pairs with
 * `finishProxySession`; a test that needs to interleave writes with other
 * work (an operator CLI action, a wait for a specific message) drives the
 * harness directly in between the two.
 */
export function startProxySession(args: StartProxySessionArgs): StartedSession {
  const sessionId = args.sessionId ?? ulid()
  const harness = createClientHarness()
  const runPromise = runWrap(args.command, args.args ?? [], {
    dir: args.journalDir,
    sessionId,
    stdin: harness.clientOutbox,
    stdout: harness.clientStdout,
    stderr: harness.clientStderr,
    killEscalationMs: SESSION_KILL_ESCALATION_MS,
    relayDrainTimeoutMs: SESSION_RELAY_DRAIN_TIMEOUT_MS,
    ...(args.policy !== undefined ? { policy: args.policy } : {}),
    ...(args.serverName !== undefined ? { serverName: args.serverName } : {}),
    ...(args.approvalsBaseDir !== undefined ? { approvalsBaseDir: args.approvalsBaseDir } : {}),
    ...(args.inventoryStorePath !== undefined ? { inventoryStorePath: args.inventoryStorePath } : {}),
    ...(args.failClosed !== undefined ? { failClosed: args.failClosed } : {}),
    ...(args.journalCommitBatchImpl !== undefined
      ? { journalCommitBatchImpl: args.journalCommitBatchImpl }
      : {}),
  })
  return { sessionId, harness, runPromise }
}

export interface SessionResult {
  readonly received: Buffer
  readonly messages: Array<Record<string, unknown>>
  readonly records: JournalRecord[]
  readonly stderrText: string
  readonly exitCode: number
}

/** Ends the session's client input, awaits completion, and collects everything it produced. */
export async function finishProxySession(
  started: StartedSession,
  journalDir: string,
): Promise<SessionResult> {
  started.harness.clientOutbox.end()
  const exitCode = await started.runPromise

  return {
    received: Buffer.concat(started.harness.clientInboxChunks),
    messages: receivedMessagesOf(started.harness),
    records: await readJournalRecords(journalDir, started.sessionId),
    stderrText: started.harness.receivedStderrText(),
    exitCode,
  }
}

export interface RunProxySessionArgs extends StartProxySessionArgs {
  readonly lines: readonly string[]
  /**
   * Waits for each line's response before sending the next one. Required
   * whenever a later request depends on what an earlier *response* taught
   * the proxy (e.g. the tool inventory only learns a tool exists once the
   * `tools/list` response comes back).
   */
  readonly sequential?: boolean
  readonly expectedResponses: number
}

/**
 * Convenience wrapper around `startProxySession`/`finishProxySession` for the
 * common case: write a fixed list of lines, wait for the expected number of
 * responses, then close the session. Tests that must act (an operator CLI
 * call, a targeted wait) between two writes use the two halves directly.
 */
export async function runProxySession(args: RunProxySessionArgs): Promise<SessionResult> {
  const started = startProxySession(args)

  for (const [index, line] of args.lines.entries()) {
    started.harness.clientOutbox.write(line)
    if (args.sequential === true) {
      await waitUntil(() => started.harness.receivedLineCount() >= index + 1)
    }
  }
  await waitUntil(() => started.harness.receivedLineCount() >= args.expectedResponses)

  return finishProxySession(started, args.journalDir)
}

/** Minimal writable shape the `approvals`/`quarantine` CLI entry points need from stdout/stderr. */
export interface CliCaptureIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
}

/** Captures everything an operator CLI command (`runApprovals`, `runQuarantine`) writes, for assertions. */
export function createCliCapture(): CliCaptureIo & { out(): string; err(): string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}
