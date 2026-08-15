import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runApprovals } from '../../src/cli/approvals-cmd.js'
import { runQuarantine } from '../../src/cli/quarantine-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { INVENTORY_FILE_NAME } from '../../src/policy/inventory.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import {
  ERROR_CODE_APPROVAL,
  ERROR_CODE_POLICY_DENIED,
  ERROR_CODE_QUARANTINED,
} from '../../src/proxy/synthesize.js'
import { EXIT_CODE_JOURNAL_FAILURE, runWrap } from '../../src/proxy/wrap.js'
import {
  FAKE_SERVER_PATH,
  POLICY_SERVER_PATH,
  createClientHarness,
  createCliCapture,
  finishProxySession,
  receivedMessagesOf,
  requestJson,
  requestLine,
  runProxySession,
  startProxySession,
  waitUntil,
  waitUntilAsync,
  type SessionResult,
} from './harness.js'

/**
 * Full-stack (mode B) end-to-end coverage, driven the way an operator
 * actually would: real `runWrap` sessions against a real child process, and
 * operator actions performed through the real CLI entry points
 * (`runApprovals`, `runQuarantine`) rather than by poking the queue/store
 * directly.
 *
 * `wrap-policy.test.ts` already covers each gate mechanism in relative
 * isolation (a lone deny, a lone quarantine, a lone approval round trip) —
 * this file is deliberately not a re-run of that: it composes several
 * mechanisms in one session (a mixed tools/list catalog, an operator
 * approving from the real CLI, a late approval turning into an on-disk
 * grant, two sessions sharing one inventory store) and is the only place
 * that exercises the CLI commands against a live proxy session.
 *
 * Note (see `wrap-policy.test.ts`'s own byte-identity test): a `tools/list`
 * response is the one message mode B always resolves asynchronously (the
 * inventory observe), so a response queued right behind it may legitimately
 * overtake it. The byte-identity scenario below avoids `tools/list`
 * entirely so the relayed order is guaranteed to be the server's own.
 */

const SERVER_NAME = 'testsrv'

function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, ...document })
  if (!result.ok) {
    throw new Error(`test policy is invalid: ${result.error.message}`)
  }
  return result.policy
}

function decisionRecords(records: readonly JournalRecord[]): JournalRecord[] {
  return records.filter((record) => record.kind === 'decision')
}

function outcomesOf(records: readonly JournalRecord[]): Array<string | undefined> {
  return decisionRecords(records).map((record) => record.decision?.outcome)
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

/** Parses the JSON array `runApprovals(['list', '--json'])` writes to stdout. */
function parsePendingApprovals(jsonOutput: string): Array<Record<string, unknown>> {
  const trimmed = jsonOutput.trim()
  return trimmed.length === 0 ? [] : (JSON.parse(trimmed) as Array<Record<string, unknown>>)
}

// -- 1 + 5: deny, and tools/list filtering (with quarantine as a side effect) ----------

describe('runWrap: deny blocks a call, and tools/list hides only the denied tool', () => {
  const journalDir = useJournalDir('mcp-journal-policy-deny-list-')
  const policy = policyOf({
    defaultDecision: 'allow',
    servers: { [SERVER_NAME]: { tools: { risky_tool: 'deny' } } },
  })
  let session: SessionResult

  beforeAll(async () => {
    session = await runProxySession({
      command: 'node',
      args: [POLICY_SERVER_PATH],
      journalDir: journalDir(),
      policy,
      serverName: SERVER_NAME,
      lines: [
        requestLine(1, 'tools/list'),
        requestLine(2, 'tools/call', { name: 'risky_tool', arguments: {} }),
      ],
      expectedResponses: 2,
      sequential: true,
    })
  })

  test('the denied tool is missing from the catalog the client sees, everything else is untouched', () => {
    const catalog = session.messages.find((message) => message.id === 1)
    const result = catalog?.result as { tools: Array<Record<string, unknown>>; nextCursor?: string }

    const names = result.tools.map((tool) => tool.name)
    expect(names).toEqual(['echo', 'special_tool'])
    // A vendor field this proxy has never heard of survives filtering verbatim.
    expect(result.tools.find((tool) => tool.name === 'special_tool')?.['x-acme-tier']).toBe('gold')
    // Untouched fields of `result` (beyond `tools`) are not dropped by the rewrite.
    expect(result.nextCursor).toBe('page-2')
  })

  test('the server never receives the denied call: it gets a synthetic error with the matching id', () => {
    const blocked = session.messages.find((message) => message.id === 2)

    // The fixture answers every tools/call with a `result`, so a lone `error`
    // for id 2 proves the call never reached it.
    expect(blocked?.result).toBeUndefined()
    expect((blocked?.error as { code: number }).code).toBe(ERROR_CODE_POLICY_DENIED)
  })

  test('the journal names the rule that denied the call', () => {
    const denials = decisionRecords(session.records).filter((r) => r.decision?.outcome === 'deny')

    expect(denials).toHaveLength(1)
    expect(denials[0]?.decision?.rule).toBe(`servers.${SERVER_NAME}.tools.risky_tool`)
    expect(denials[0]?.decision?.toolName).toBe('risky_tool')
  })

  test('the journal holds both the original catalog and the one the client saw', () => {
    const original = decisionRecords(session.records).find((r) => r.decision?.rule === 'toolsList.original')
    const filtered = decisionRecords(session.records).find((r) => r.decision?.rule === 'toolsList.filtered')

    expect(original?.payload).toEqual({ tools: ['echo', 'risky_tool', 'special_tool'] })
    expect(filtered?.payload).toEqual({ tools: ['echo', 'special_tool'] })
  })

  test('new tools are quarantined as a side effect, visible through the real quarantine CLI', async () => {
    const storePath = join(journalDir(), INVENTORY_FILE_NAME)

    await waitUntilAsync(async () => {
      const probe = createCliCapture()
      await runQuarantine(['list', '--json'], probe, { storePath })
      return probe.out().trim().length > 0
    })

    const io = createCliCapture()
    const exitCode = await runQuarantine(['list', '--json'], io, { storePath })
    expect(exitCode).toBe(0)
    const entries = io
      .out()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    // Quarantine bookkeeping observes the whole catalog the server sent,
    // independent of whether a tool is visible or callable: `risky_tool` is
    // both explicitly denied *and* quarantined (it is also new).
    const quarantinedNames = entries.map((entry) => entry.toolName).sort()
    expect(quarantinedNames).toEqual(['echo', 'risky_tool', 'special_tool'])
    expect(entries.every((entry) => entry.serverName === SERVER_NAME)).toBe(true)
    expect(entries.every((entry) => entry.state === 'new')).toBe(true)
  })
})

// -- 2 + 8: allow relay + untouched-stream byte identity -----------------------------

describe('runWrap: an allowed session is relayed byte-for-byte, including odd framing', () => {
  const journalDir = useJournalDir('mcp-journal-policy-identity-')
  // Nothing here is ever gated: allow-all, and quarantine off so a fresh
  // tool is never held for review either.
  const policy = policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } })

  // Deliberately no `tools/list` (see the module doc comment): a `\r\n`
  // terminator, a lone blank line (plain and CRLF), and an unterminated
  // trailing fragment that never becomes a complete JSON-RPC message.
  const lines = [
    `${requestJson(1, 'initialize')}\r\n`,
    '\n',
    `${requestJson(2, 'tools/call', { name: 'echo', arguments: { t: 1 } })}\n`,
    '\r\n',
    `${requestJson(3, 'tools/call', { name: 'echo', arguments: { t: 2 } })}\r\n`,
    '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"echo","argume',
  ]

  let modeA: SessionResult
  let modeB: SessionResult

  beforeAll(async () => {
    modeA = await runProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: journalDir(),
      lines,
      expectedResponses: 3,
    })
    modeB = await runProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: journalDir(),
      policy,
      serverName: SERVER_NAME,
      lines,
      expectedResponses: 3,
    })
  })

  test('mode B delivers exactly what mode A delivers, byte for byte', () => {
    expect(modeB.received).toEqual(modeA.received)
    expect(modeB.exitCode).toBe(modeA.exitCode)
  })

  test('every real request got its response; the unterminated fragment got none', () => {
    expect(modeB.messages).toHaveLength(3)
    expect(modeB.messages.map((m) => m.id).sort()).toEqual([1, 2, 3])
  })

  test('journal has request/response records in both directions plus an allow decision per call', () => {
    expect(
      modeB.records.filter((r) => r.direction === 'client→server' && r.kind === 'request'),
    ).toHaveLength(3)
    expect(
      modeB.records.filter((r) => r.direction === 'server→client' && r.kind === 'response'),
    ).toHaveLength(3)

    const allows = decisionRecords(modeB.records).filter((r) => r.decision?.outcome === 'allow')
    expect(allows).toHaveLength(2) // the two complete tools/call frames; initialize is not gated

    // The unterminated trailing fragment is no longer silently forwarded: under
    // the fail-closed client-direction default it is denied and journaled. It
    // carries no recoverable id, so nothing is written back to the client and
    // the byte-identity guarantee above still holds.
    const denies = decisionRecords(modeB.records).filter((r) => r.decision?.outcome === 'deny')
    expect(denies).toHaveLength(1)
    expect(denies[0]?.decision?.rule).toBe('unparseable-client-frame')
  })
})

// -- 3: require-approval, approved through the real approvals CLI --------------------

describe('runWrap: require-approval forwards the call once the real CLI approves it', () => {
  const journalDir = useJournalDir('mcp-journal-policy-approve-cli-')
  const policy = policyOf({
    defaultDecision: 'allow',
    approval: { timeoutMs: 20_000 },
    servers: { [SERVER_NAME]: { tools: { echo: 'require-approval' } } },
  })
  const approvalsBaseDir = () => join(journalDir(), 'approvals')
  let session: SessionResult

  beforeAll(async () => {
    const started = startProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: journalDir(),
      policy,
      serverName: SERVER_NAME,
    })

    started.harness.clientOutbox.write(requestLine(1, 'tools/call', { name: 'echo', arguments: { marker: 'A' } }))

    let approvalId = ''
    await waitUntilAsync(async () => {
      const listIo = createCliCapture()
      await runApprovals(['list', '--json'], listIo, { baseDir: approvalsBaseDir() })
      const pending = parsePendingApprovals(listIo.out())
      if (pending.length === 0) return false
      approvalId = pending[0]?.approvalId as string
      return true
    })
    expect(approvalId).not.toBe('')

    const approveIo = createCliCapture()
    const approveExit = await runApprovals(['approve', approvalId], approveIo, {
      baseDir: approvalsBaseDir(),
    })
    expect(approveExit).toBe(0)
    expect(approveIo.out()).toContain('Approved')

    await waitUntil(() => started.harness.receivedLineCount() >= 1)
    session = await finishProxySession(started, journalDir())
  })

  test('the approved call is forwarded to the server and its response reaches the client', () => {
    const answer = session.messages.find((message) => message.id === 1)

    expect(answer?.error).toBeUndefined()
    expect(answer?.result).toBeDefined()
  })

  test('the journal shows pending, then approved, with a recorded latency', () => {
    expect(outcomesOf(session.records)).toEqual(
      expect.arrayContaining(['require-approval-pending', 'approved']),
    )
    const approved = decisionRecords(session.records).find((r) => r.decision?.outcome === 'approved')
    expect(typeof approved?.decision?.latencyMs).toBe('number')
    expect(approved?.decision?.approvalId).toBeTruthy()
  })
})

// -- 4: timeout, then a late CLI approval turns into a grant for the retry -----------

describe('runWrap: a late CLI approval after a timeout grants the identical retry', () => {
  const journalDir = useJournalDir('mcp-journal-policy-late-grant-')
  // Short enough that the wait reliably times out inside the test's own budget.
  const policy = policyOf({
    defaultDecision: 'allow',
    approval: { timeoutMs: 500 },
    servers: { [SERVER_NAME]: { tools: { echo: 'require-approval' } } },
  })
  const approvalsBaseDir = () => join(journalDir(), 'approvals')
  let session: SessionResult
  let firstApprovalId: string

  beforeAll(async () => {
    const started = startProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: journalDir(),
      policy,
      serverName: SERVER_NAME,
    })

    started.harness.clientOutbox.write(requestLine(1, 'tools/call', { name: 'echo', arguments: {} }))

    await waitUntil(() => receivedMessagesOf(started.harness).some((m) => m.id === 1))
    const timedOut = receivedMessagesOf(started.harness).find((m) => m.id === 1)
    firstApprovalId = ((timedOut?.error as { data: { approvalId: string } }).data).approvalId

    const approveIo = createCliCapture()
    const approveExit = await runApprovals(['approve', firstApprovalId], approveIo, {
      baseDir: approvalsBaseDir(),
    })
    expect(approveExit).toBe(0)

    // Same tool, same (empty) arguments: the retry the on-disk grant must match.
    started.harness.clientOutbox.write(requestLine(2, 'tools/call', { name: 'echo', arguments: {} }))
    await waitUntil(() => receivedMessagesOf(started.harness).some((m) => m.id === 2))

    session = await finishProxySession(started, journalDir())
  })

  test('the first call times out with an error that names the approval id', () => {
    const timedOut = session.messages.find((message) => message.id === 1)

    expect((timedOut?.error as { code: number }).code).toBe(ERROR_CODE_APPROVAL)
    expect((timedOut?.error as { message: string }).message).toContain(firstApprovalId)
  })

  test('the retry is forwarded and answered, without a second pending approval', () => {
    const retried = session.messages.find((message) => message.id === 2)

    expect(retried?.error).toBeUndefined()
    expect(retried?.result).toBeDefined()

    const pendingRecords = decisionRecords(session.records).filter(
      (r) => r.decision?.outcome === 'require-approval-pending',
    )
    expect(pendingRecords).toHaveLength(1) // only the first call ever enqueued
  })

  test('the journal shows timeout for the first call, then an allow-by-grant for the retry', () => {
    expect(outcomesOf(session.records)).toEqual(
      expect.arrayContaining(['require-approval-pending', 'timeout', 'allow']),
    )
    const granted = decisionRecords(session.records).find((r) => r.decision?.rule === 'grant')
    expect(granted?.decision?.outcome).toBe('allow')
  })
})

// -- 6: quarantine blocks a new tool; approval via the real CLI unblocks the next session --

describe('runWrap: a quarantined tool is blocked, then unblocked in a later session', () => {
  const firstJournalDir = useJournalDir('mcp-journal-policy-quarantine-1-')
  const secondJournalDir = useJournalDir('mcp-journal-policy-quarantine-2-')
  const policy = policyOf({
    defaultDecision: 'allow',
    quarantine: { enabled: true, onQuarantined: 'deny' },
  })
  let inventoryStorePath: string
  let firstSession: SessionResult
  let secondSession: SessionResult

  beforeAll(async () => {
    inventoryStorePath = join(firstJournalDir(), 'shared-tool-inventory.json')

    firstSession = await runProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: firstJournalDir(),
      policy,
      serverName: SERVER_NAME,
      inventoryStorePath,
      lines: [requestLine(1, 'tools/list'), requestLine(2, 'tools/call', { name: 'echo', arguments: {} })],
      expectedResponses: 2,
      sequential: true,
    })

    const approveIo = createCliCapture()
    const approveExit = await runQuarantine(['approve', SERVER_NAME, 'echo'], approveIo, {
      storePath: inventoryStorePath,
    })
    expect(approveExit).toBe(0)

    secondSession = await runProxySession({
      command: 'node',
      args: [FAKE_SERVER_PATH],
      journalDir: secondJournalDir(),
      policy,
      serverName: SERVER_NAME,
      inventoryStorePath,
      lines: [requestLine(1, 'tools/list'), requestLine(2, 'tools/call', { name: 'echo', arguments: {} })],
      expectedResponses: 2,
      sequential: true,
    })
  })

  test('the first session denies the call to the never-approved tool with a quarantine error', () => {
    const blocked = firstSession.messages.find((message) => message.id === 2)

    expect(blocked?.result).toBeUndefined()
    expect((blocked?.error as { code: number }).code).toBe(ERROR_CODE_QUARANTINED)
    expect(outcomesOf(firstSession.records)).toContain('quarantined')
  })

  test('the second session, sharing the same inventory store, allows the now-approved tool', () => {
    const answer = secondSession.messages.find((message) => message.id === 2)

    expect(answer?.error).toBeUndefined()
    expect(answer?.result).toBeDefined()
    expect(outcomesOf(secondSession.records)).not.toContain('quarantined')
  })
})

// -- 7: fail-closed sourced from the policy file itself, not the --fail-closed flag --

describe('runWrap: policy-driven fail-closed journaling', () => {
  const journalDir = useJournalDir('mcp-journal-policy-failclosed-')

  test('a journal that cannot be written kills the child and exits with the journal-failure code', async () => {
    const harness = createClientHarness()

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      dir: journalDir(),
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
      killEscalationMs: 500,
      relayDrainTimeoutMs: 1000,
      // `failClosed` sourced from the policy document itself: no `--fail-closed` flag.
      policy: policyOf({ defaultDecision: 'allow', journal: { failClosed: true } }),
      serverName: SERVER_NAME,
      journalCommitBatchImpl: () =>
        Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
    })
    harness.clientOutbox.write(requestLine(1, 'initialize'))

    const exitCode = await runPromise

    expect(exitCode).toBe(EXIT_CODE_JOURNAL_FAILURE)
    const stderrText = harness.receivedStderrText()
    expect(stderrText).toContain('fail-closed')
    expect(stderrText).toMatch(/journal records dropped this session: [1-9]/)
  })
})
