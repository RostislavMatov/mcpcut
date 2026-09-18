import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ulid } from 'ulid'
import type { JournalRecord } from '../../src/journal/record.js'
import type { JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import {
  createJournalFailureController,
  type JournalFailureController as JournalFailure,
} from '../../src/proxy/journal-failure.js'
import type { ServerHandle } from '../../src/proxy/spawn.js'
import { wirePolicyRelay } from '../../src/proxy/wire-policy.js'
import { EXIT_CODE_JOURNAL_FAILURE, runWrap, type RunWrapOptions } from '../../src/proxy/wrap.js'
import {
  FAKE_SERVER_PATH,
  createClientHarness,
  readJournalRecords,
  requestLine,
  waitUntil,
  type ClientHarness,
} from './harness.js'

/**
 * Mode B end-to-end: `runWrap` with a policy active, against the same fake
 * server the M1 tests use.
 *
 * The M1 suites (`wrap.test.ts`, `wrap-lifecycle.test.ts`,
 * `integration.test.ts`) are the gate for mode A and are deliberately not
 * touched: a run without a policy must keep behaving exactly as it did
 * before policies existed.
 *
 * Each scenario spawns a real child process, so a scenario is driven once in
 * `beforeAll` and its (immutable) outcome is then asserted from several
 * focused tests — rather than paying for one process per assertion. The
 * tests stay independent: they only read the recorded result.
 */

/** Server identity used by every policy in this file. */
const SERVER_NAME = 'testsrv'

/** JSON-RPC error codes the gate answers with (see `synthesize.ts`). */
const ERROR_CODE_POLICY_DENIED = -32001
const ERROR_CODE_QUARANTINED = -32003

const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 10_000

/** Approval timeout for the approval scenario: far longer than the test needs. */
const TEST_APPROVAL_TIMEOUT_MS = 20_000

/** Parses a policy document, failing the test loudly if it is not valid. */
function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, ...document })
  if (!result.ok) {
    throw new Error(`test policy is invalid: ${result.error.message}`)
  }
  return result.policy
}

/** The client-facing stdio and lifecycle knobs every run here shares. */
function baseOptions(harness: ClientHarness, sessionId: string, journalDir: string): RunWrapOptions {
  return {
    dir: journalDir,
    sessionId,
    stdin: harness.clientOutbox,
    stdout: harness.clientStdout,
    stderr: harness.clientStderr,
    killEscalationMs: 500,
    relayDrainTimeoutMs: 1000,
  }
}

/** Every JSON message the client received, in order. */
function receivedMessages(harness: ClientHarness): Array<Record<string, unknown>> {
  return Buffer.concat(harness.clientInboxChunks)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function decisionRecords(records: readonly JournalRecord[]): JournalRecord[] {
  return records.filter((record) => record.kind === 'decision')
}

function outcomesOf(records: readonly JournalRecord[]): Array<string | undefined> {
  return decisionRecords(records).map((record) => record.decision?.outcome)
}

/** Polls an async predicate; mirrors harness.waitUntil, which only takes a sync one. */
async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('waitUntilAsync: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

interface SessionResult {
  readonly received: Buffer
  readonly messages: Array<Record<string, unknown>>
  readonly records: JournalRecord[]
  readonly stderrText: string
  readonly exitCode: number
}

interface SessionArgs {
  readonly journalDir: string
  readonly lines: readonly string[]
  readonly expectedResponses: number
  readonly policy?: Policy
  /**
   * Waits for each line's response before sending the next one, modelling a
   * client that does not pipeline. Required whenever a later request depends
   * on what an earlier *response* taught the proxy (the tool inventory only
   * learns a tool exists when the `tools/list` response comes back).
   */
  readonly sequential?: boolean
}

/** Drives one full fake-server session and returns everything it produced. */
async function runFakeServerSession(args: SessionArgs): Promise<SessionResult> {
  const sessionId = ulid()
  const harness = createClientHarness()
  const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
    ...baseOptions(harness, sessionId, args.journalDir),
    ...(args.policy !== undefined ? { policy: args.policy, serverName: SERVER_NAME } : {}),
  })

  for (const [index, line] of args.lines.entries()) {
    harness.clientOutbox.write(line)
    if (args.sequential === true) {
      await waitUntil(() => harness.receivedLineCount() >= index + 1)
    }
  }
  await waitUntil(() => harness.receivedLineCount() >= args.expectedResponses)
  harness.clientOutbox.end()
  const exitCode = await runPromise

  return {
    received: Buffer.concat(harness.clientInboxChunks),
    messages: receivedMessages(harness),
    records: await readJournalRecords(args.journalDir, sessionId),
    stderrText: harness.receivedStderrText(),
    exitCode,
  }
}

/** Creates a scenario-scoped temp journal directory, cleaned up afterwards. */
function useJournalDir(prefix: string): () => string {
  let journalDir = ''
  beforeAll(async () => {
    journalDir = await mkdtemp(join(tmpdir(), prefix))
  })
  afterAll(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })
  return () => journalDir
}

describe('createJournalFailureController', () => {
  /** A kill target that records the signals it was sent and exits immediately. */
  function createTarget(): { kills: string[]; target: Parameters<JournalFailure['arm']>[0] } {
    const kills: string[] = []
    return {
      kills,
      target: { kill: (signal) => kills.push(signal ?? 'default'), exitCode: () => Promise.resolve(0) },
    }
  }

  function createDiagnostics(): { writable: Writable; text: () => string } {
    const chunks: Buffer[] = []
    return {
      writable: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk)
          callback()
        },
      }),
      text: () => Buffer.concat(chunks).toString('utf8'),
    }
  }

  test('stops the session on the first unrecoverable write failure', () => {
    const { kills, target } = createTarget()
    const disposals: number[] = []
    const diagnostics = createDiagnostics()
    const controller = createJournalFailureController({
      diagnostics: diagnostics.writable,
      killEscalationMs: 50,
    })
    controller.arm(target, { dispose: () => disposals.push(1) })

    controller.report(new Error('disk is gone'), 1)

    expect(controller.hasFailed()).toBe(true)
    expect(disposals).toHaveLength(1)
    expect(kills).toEqual(['SIGTERM'])
    expect(diagnostics.text()).toContain('disk is gone')
  })

  test('acts on the first failure only: later dropped records do not kill twice', () => {
    const { kills, target } = createTarget()
    const diagnostics = createDiagnostics()
    const controller = createJournalFailureController({
      diagnostics: diagnostics.writable,
      killEscalationMs: 50,
    })
    controller.arm(target, { dispose: () => undefined })

    controller.report(new Error('first'), 1)
    controller.report(new Error('second'), 2)

    expect(kills).toEqual(['SIGTERM'])
    expect(diagnostics.text()).not.toContain('second')
  })

  test('honors a failure reported before it was armed, as soon as it is armed', () => {
    const { kills, target } = createTarget()
    const diagnostics = createDiagnostics()
    const controller = createJournalFailureController({
      diagnostics: diagnostics.writable,
      killEscalationMs: 50,
    })

    // The sink exists before the child does, so it can fail before arming.
    controller.report(new Error('failed early'), 1)
    expect(kills).toEqual([])

    controller.arm(target, { dispose: () => undefined })

    expect(kills).toEqual(['SIGTERM'])
  })

  test('stays silent at exit when the run never failed', () => {
    const diagnostics = createDiagnostics()
    const controller = createJournalFailureController({ diagnostics: diagnostics.writable })

    controller.reportDropped(0)

    expect(controller.hasFailed()).toBe(false)
    expect(diagnostics.text()).toBe('')
  })
})

describe('wirePolicyRelay stream lifecycle', () => {
  interface FakeSession {
    readonly handle: ServerHandle
    readonly clientStdin: PassThrough
    readonly clientStdout: PassThrough
    readonly errors: Array<{ channel: string; origin: string }>
    readonly relay: ReturnType<typeof wirePolicyRelay>
  }

  /** A sink that accepts everything and writes nowhere: this suite is about streams. */
  function createSilentSink(): JournalSink {
    return {
      write: () => undefined,
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
      droppedRecordCount: () => 0,
    }
  }

  function wireFakeSession(journalDir: string): FakeSession {
    const childStdin = new PassThrough()
    const handle: ServerHandle = {
      stdin: childStdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 1,
      exitCode: () => Promise.resolve(0),
      kill: () => undefined,
    }
    const clientStdin = new PassThrough()
    const clientStdout = new PassThrough()
    const errors: Array<{ channel: string; origin: string }> = []

    const relay = wirePolicyRelay({
      policy: policyOf({ defaultDecision: 'allow' }),
      serverName: SERVER_NAME,
      sessionId: ulid(),
      handle,
      clientStdin,
      clientStdout,
      clientStderr: new PassThrough(),
      sink: createSilentSink(),
      tapLine: () => undefined,
      tapStderrLine: () => undefined,
      reportError: (channel, _error, origin) => errors.push({ channel, origin }),
      journalDir,
    })

    return { handle, clientStdin, clientStdout, errors, relay }
  }

  const journalDir = useJournalDir('mcpcut-wire-policy-')

  test('ends the child stdin once the client stdin ends, as splice does in mode A', async () => {
    const session = wireFakeSession(journalDir())

    session.clientStdin.end()
    await waitUntil(() => session.handle.stdin.writableEnded)

    expect(session.handle.stdin.writableEnded).toBe(true)
    session.relay.dispose()
  })

  test('reports a failing client stdout as a destination error on the server→client channel', async () => {
    const session = wireFakeSession(journalDir())

    session.clientStdout.destroy(Object.assign(new Error('client went away'), { code: 'EPIPE' }))
    await waitUntil(() => session.errors.length > 0)

    expect(session.errors[0]).toEqual({ channel: 'server→client', origin: 'destination' })
    session.relay.dispose()
  })

  test('reports a failing child stdout as a source error on the server→client channel', async () => {
    const session = wireFakeSession(journalDir())

    session.handle.stdout.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }))
    await waitUntil(() => session.errors.length > 0)

    expect(session.errors[0]).toEqual({ channel: 'server→client', origin: 'source' })
    session.relay.dispose()
  })

  test('reports a failing child stdin as a destination error on the client→server channel', async () => {
    const session = wireFakeSession(journalDir())

    session.handle.stdin.destroy(Object.assign(new Error('child is gone'), { code: 'EPIPE' }))
    await waitUntil(() => session.errors.length > 0)

    expect(session.errors[0]).toEqual({ channel: 'client→server', origin: 'destination' })
    session.relay.dispose()
  })

  test('reports a failing client stdin as a source error on the client→server channel', async () => {
    const session = wireFakeSession(journalDir())

    session.clientStdin.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }))
    await waitUntil(() => session.errors.length > 0)

    expect(session.errors[0]).toEqual({ channel: 'client→server', origin: 'source' })
    session.relay.dispose()
  })
})

describe('runWrap relays an untouched session identically in both modes', () => {
  const journalDir = useJournalDir('mcpcut-wrap-identity-')
  // Nothing here is ever gated: allow-all, and quarantine off so the
  // tools/call after tools/list is not held for review.
  const policy = policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } })
  // `tools/list` goes last on purpose: its response is the one message mode
  // B always handles asynchronously (the inventory observes it), and an
  // async verdict deliberately does not hold up the frames behind it — so a
  // response queued after it may legitimately overtake it. Nothing follows
  // it here, so the relayed order is the server's own.
  const lines = [
    requestLine(1, 'initialize'),
    requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
    requestLine(3, 'tools/list'),
  ]
  let modeA: SessionResult
  let modeB: SessionResult

  beforeAll(async () => {
    modeA = await runFakeServerSession({ journalDir: journalDir(), lines, expectedResponses: 3 })
    modeB = await runFakeServerSession({
      journalDir: journalDir(),
      lines,
      expectedResponses: 3,
      policy,
    })
  })

  test('mode B delivers byte-for-byte what mode A delivers', () => {
    expect(modeB.received).toEqual(modeA.received)
    expect(modeB.exitCode).toBe(modeA.exitCode)
  })

  test('mode B journals ordinary traffic in both directions, as the splice tap does', () => {
    expect(
      modeB.records.filter((r) => r.direction === 'client→server' && r.kind === 'request'),
    ).toHaveLength(3)
    expect(
      modeB.records.filter((r) => r.direction === 'server→client' && r.kind === 'response'),
    ).toHaveLength(3)
    expect(modeB.records.some((r) => r.direction === 'server-stderr')).toBe(true)
  })

  test('mode B records no denial for a session the policy never blocks', () => {
    expect(outcomesOf(modeB.records)).not.toContain('deny')
    expect(outcomesOf(modeB.records)).not.toContain('quarantined')
  })

  test('mode A decides nothing at all: without a policy there is no gate', () => {
    expect(decisionRecords(modeA.records)).toEqual([])
    // The call reached the server, which answers every tools/call with a result.
    expect(modeA.messages.at(-1)?.result).toBeDefined()
  })
})

describe('runWrap blocks a denied tools/call', () => {
  const journalDir = useJournalDir('mcpcut-wrap-deny-')
  const policy = policyOf({
    defaultDecision: 'allow',
    servers: { [SERVER_NAME]: { tools: { echo: 'deny' } } },
  })
  let session: SessionResult

  beforeAll(async () => {
    session = await runFakeServerSession({
      journalDir: journalDir(),
      lines: [
        requestLine(1, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
        requestLine(2, 'initialize'),
      ],
      expectedResponses: 2,
      policy,
    })
  })

  test('answers the blocked id locally; the server never sees the call', () => {
    const blocked = session.messages.find((message) => message.id === 1)

    // The fake server answers every tools/call with a `result`, so a lone
    // `error` for that id proves the call never reached it.
    expect(blocked?.result).toBeUndefined()
    expect((blocked?.error as { code: number }).code).toBe(ERROR_CODE_POLICY_DENIED)
  })

  test('blocks exactly one id: unrelated traffic keeps flowing to the server', () => {
    expect(session.messages).toHaveLength(2)
    expect(session.messages.find((message) => message.id === 2)?.result).toBeDefined()
  })

  test('journals the denial as a decision record naming the rule that fired', () => {
    const denials = decisionRecords(session.records).filter(
      (record) => record.decision?.outcome === 'deny',
    )

    expect(denials).toHaveLength(1)
    expect(denials[0]?.decision?.rule).toBe(`servers.${SERVER_NAME}.tools.echo`)
    expect(denials[0]?.decision?.toolName).toBe('echo')
    expect(denials[0]?.decision?.serverName).toBe(SERVER_NAME)
  })
})

describe('runWrap blocks an id-less tools/call notification (C2/N1)', () => {
  const journalDir = useJournalDir('mcpcut-wrap-idless-')
  const policy = policyOf({ defaultDecision: 'deny' })
  let session: SessionResult

  beforeAll(async () => {
    session = await runFakeServerSession({
      journalDir: journalDir(),
      lines: [
        // Spec-violating: a `tools/call` with no "id" key at all.
        `${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })}\n`,
        requestLine(2, 'initialize'),
      ],
      expectedResponses: 1,
      policy,
    })
  })

  test('never reaches the server: only the unrelated call after it gets a response', () => {
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]?.id).toBe(2)
  })

  test('is journaled as a denied tools/call, not silently dropped without a trace', () => {
    const denials = decisionRecords(session.records).filter(
      (record) => record.decision?.outcome === 'deny' && record.decision?.toolName === 'echo',
    )
    expect(denials).toHaveLength(1)
  })
})

describe('runWrap quarantines a tool it has never seen approved', () => {
  const journalDir = useJournalDir('mcpcut-wrap-quarantine-')
  const policy = policyOf({
    defaultDecision: 'allow',
    quarantine: { enabled: true, onQuarantined: 'deny' },
  })
  let session: SessionResult

  beforeAll(async () => {
    // tools/list first, and awaited: the inventory only learns `echo` exists
    // when that *response* comes back, and that is what quarantines it. A
    // call issued before then is decided on an empty inventory.
    session = await runFakeServerSession({
      journalDir: journalDir(),
      lines: [
        requestLine(1, 'tools/list'),
        requestLine(2, 'tools/call', { name: 'echo', arguments: {} }),
      ],
      expectedResponses: 2,
      sequential: true,
      policy,
    })
  })

  test('hides the quarantined tool from the catalog the client sees', () => {
    const catalog = session.messages.find((message) => message.id === 1)

    expect((catalog?.result as { tools: unknown[] }).tools).toEqual([])
  })

  test('answers a call to the quarantined tool with the quarantine error', () => {
    const blocked = session.messages.find((message) => message.id === 2)

    expect((blocked?.error as { code: number }).code).toBe(ERROR_CODE_QUARANTINED)
  })

  test('journals both the catalog the server sent and the one the client saw', () => {
    const rules = decisionRecords(session.records).map((record) => record.decision?.rule)

    expect(rules).toContain('toolsList.original')
    expect(rules).toContain('toolsList.filtered')
    expect(outcomesOf(session.records)).toContain('quarantined')
  })
})

describe('runWrap fail-closed journaling', () => {
  const journalDir = useJournalDir('mcpcut-wrap-failclosed-')
  let failed: { exitCode: number; stderrText: string }

  beforeAll(async () => {
    const harness = createClientHarness()
    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      ...baseOptions(harness, ulid(), journalDir()),
      policy: policyOf({ defaultDecision: 'allow' }),
      serverName: SERVER_NAME,
      failClosed: true,
      // A journal batch commit that can never succeed, however often it is retried.
      journalCommitBatchImpl: () =>
        Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
        ),
    })
    harness.clientOutbox.write(requestLine(1, 'initialize'))
    const exitCode = await runPromise
    failed = { exitCode, stderrText: harness.receivedStderrText() }
  })

  test('kills the child and exits with the journal-failure code', () => {
    expect(failed.exitCode).toBe(EXIT_CODE_JOURNAL_FAILURE)
  })

  test('says why on stderr, and counts the records it lost', () => {
    expect(failed.stderrText).toContain('fail-closed')
    expect(failed.stderrText).toMatch(/journal records dropped this session: [1-9]/)
  })

  test('leaves a healthy fail-closed session alone: it exits with the child\'s own code', async () => {
    const session = await runFakeServerSession({
      journalDir: journalDir(),
      lines: [requestLine(1, 'initialize')],
      expectedResponses: 1,
      policy: policyOf({ defaultDecision: 'allow', journal: { failClosed: true } }),
    })

    expect(session.exitCode).toBe(0)
    expect(session.stderrText).not.toContain('fail-closed')
  })
})

describe('runWrap mode B trailing output', () => {
  const journalDir = useJournalDir('mcpcut-wrap-tail-')

  test('delivers a final line the server wrote without a trailing newline before dying', async () => {
    const harness = createClientHarness()

    const exitCode = await runWrap('node', ['-e', 'process.stdout.write("no trailing newline")'], {
      ...baseOptions(harness, ulid(), journalDir()),
      policy: policyOf({ defaultDecision: 'allow' }),
      serverName: SERVER_NAME,
    })

    expect(Buffer.concat(harness.clientInboxChunks).toString('utf8')).toBe('no trailing newline')
    expect(exitCode).toBe(0)
  })
})

describe('runWrap require-approval flow', () => {
  const journalDir = useJournalDir('mcpcut-wrap-approval-')
  const policy = policyOf({
    defaultDecision: 'allow',
    approval: { timeoutMs: TEST_APPROVAL_TIMEOUT_MS },
    servers: { [SERVER_NAME]: { tools: { echo: 'require-approval' } } },
  })
  let messages: Array<Record<string, unknown>>
  let records: JournalRecord[]

  /** Finds the queued approval for the call whose `t` argument is `marker`. */
  function approvalFor(pending: readonly PendingApproval[], marker: number): PendingApproval {
    const match = pending.find(
      (entry) => (entry.argsRedacted as { t?: number } | null)?.t === marker,
    )
    if (match === undefined) {
      throw new Error(`no queued approval found for marker ${marker}`)
    }
    return match
  }

  beforeAll(async () => {
    const sessionId = ulid()
    const approvalsBaseDir = join(journalDir(), 'approvals')
    const harness = createClientHarness()
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      ...baseOptions(harness, sessionId, journalDir()),
      policy,
      serverName: SERVER_NAME,
      approvalsBaseDir,
    })
    // Both calls wait for a human at the same time: an approval must never
    // block the frames behind it (head-of-line blocking is rejected).
    harness.clientOutbox.write(requestLine(5, 'tools/call', { name: 'echo', arguments: { t: 5 } }))
    harness.clientOutbox.write(requestLine(6, 'tools/call', { name: 'echo', arguments: { t: 6 } }))

    await waitUntilAsync(async () => (await queue.list()).length === 2)
    const pending = await queue.list()
    await queue.resolve(approvalFor(pending, 5).approvalId, {
      outcome: 'approved',
      actor: 'test-operator',
    })
    await queue.resolve(approvalFor(pending, 6).approvalId, {
      outcome: 'denied',
      actor: 'test-operator',
    })

    await waitUntil(() => harness.receivedLineCount() >= 2)
    harness.clientOutbox.end()
    await runPromise

    messages = receivedMessages(harness)
    records = await readJournalRecords(journalDir(), sessionId)
  })

  test('forwards the approved call to the server', () => {
    const answer = messages.find((message) => message.id === 5)

    // The fake server echoes the call params back, so a `result` here means
    // the approved call really did reach it.
    expect(answer?.result).toBeDefined()
    expect(answer?.error).toBeUndefined()
  })

  test('answers the denied call locally, without ever reaching the server', () => {
    const answer = messages.find((message) => message.id === 6)

    expect(answer?.error).toBeDefined()
    expect(answer?.result).toBeUndefined()
  })

  test('journals the pending request and both of its outcomes', () => {
    expect(outcomesOf(records)).toContain('require-approval-pending')
    expect(outcomesOf(records)).toContain('approved')
    expect(outcomesOf(records)).toContain('denied-by-operator')
  })
})
