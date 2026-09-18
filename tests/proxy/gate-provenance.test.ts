import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEffectiveAgentReader } from '../../src/agents/effective-reader.js'
import type { AgentRecord } from '../../src/agents/schema.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type PendingApproval,
} from '../../src/policy/approvals/queue.js'
import { openApprovalsDb } from '../../src/policy/approvals/queue-db.js'
import { createApprovalWaiter, type ApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { grantsHashOf, policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateAgentScope, GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'
import { startAgentWatch } from '../../src/session/agent-watch.js'
import { readJournalRecords } from '../support/journal-rows.js'
import { typecheckSource } from '../support/typecheck.js'

/** A `tsc` spawn is not a 5 s unit test: see the compile assertions below. */
const TYPECHECK_TIMEOUT_MS = 30_000

/**
 * Decision-record provenance at the gate (M5 wave 1). The invariant under
 * test is deliberately broader than any single decision path: *every*
 * decision record the gate can emit carries `policyHash`, because provenance
 * is stamped at the single choke point (`createDecisionWriter`) rather than
 * at the ~20 places a `DecisionInfo` is assembled. `grantsHash` rides along
 * only when the session has an authenticated agent.
 *
 * These are separate from `gate.test.ts` (which pins M2 behaviour) and
 * `gate-message-m3.test.ts` (the message-level core and agent dimension):
 * both are already ~1000+ lines, and this invariant cuts across the paths
 * each of them owns.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-provenance'
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
/** Generous ceiling for "this was never going to happen"; never a delay that is waited out. */
const OBSERVE_TIMEOUT_MS = 5_000

/**
 * Polls for an observed condition with a deadline, rather than sleeping past
 * a guessed wall-clock duration (TS-L4).
 */
async function waitUntil(describeWhat: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${describeWhat}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-gate-provenance-test-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  const text = typeof message === 'string' ? message : JSON.stringify(message)
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: unknown, name: string): Frame {
  return frameOf({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { path: '/tmp/x' } },
  })
}

function toolsListResponse(id: unknown): Frame {
  return frameOf({
    jsonrpc: '2.0',
    id,
    result: { tools: [{ name: 'read_file' }, { name: 'delete_repo' }] },
  })
}

/** A hydrated, trusted inventory whose tools are all known. */
function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: (tools) =>
      Promise.resolve({ known: tools.map((tool) => tool.name), new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

/** An inventory whose `stateOf` throws, driving the gate's fail-closed `gate-error` path. */
function brokenInventory(): GateInventory {
  return {
    ...trustedInventory(),
    stateOf: () => {
      throw new Error('inventory exploded')
    },
  }
}

/** A scope that reports a grants fingerprint, re-read on every record written. */
function scopeWithProvenance(readHash: () => string): GateAgentScope {
  return {
    agentName: 'research-bot',
    isGranted: () => true,
    filterVisible: (tools) => [...tools],
    grantsHash: readHash,
  }
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly inventory?: GateInventory
  readonly agentScope?: GateAgentScope
  readonly approvalWaiter?: ApprovalWaiter
  /** Gate clock; also the clock `checkRecentApproval` reads during the late-approval lookup. */
  readonly clock?: () => number
}

interface GateHarness {
  readonly gate: PolicyGate
  readonly written: Buffer[]
  /**
   * Every record the gate handed the sink, captured BEFORE serialization.
   * Reading provenance back through JSON cannot tell an absent `grantsHash`
   * key from one explicitly set to `undefined` (`JSON.stringify` drops both),
   * so absence assertions have to look at the in-memory record (TS-L1).
   */
  readonly captured: JournalRecord[]
}

function createHarness(opts: HarnessOptions = {}): GateHarness {
  const written: Buffer[] = []
  const captured: JournalRecord[] = []
  const writer: OrderedWriter = {
    writeMessage: (bytes: Buffer) => {
      written.push(bytes)
      return Promise.resolve()
    },
    dispose: () => undefined,
  }
  const capturingSink: GateSink = {
    write: (record: JournalRecord) => {
      captured.push(record)
      sink.write(record)
    },
    flush: () => sink.flush(),
  }
  const gate = createPolicyGate({
    policy: opts.policy ?? policyOf({ defaultDecision: 'allow' }),
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: opts.inventory ?? trustedInventory(),
    ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
    approvalQueue: queue,
    approvalWaiter: opts.approvalWaiter ?? createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink: capturingSink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
    onError: (error: unknown) => errors.push(error),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  })
  return { gate, written, captured }
}

/** In-memory decision records, in write order (see `GateHarness.captured`). */
function capturedDecisions(harness: GateHarness): JournalRecord[] {
  return harness.captured.filter((record) => record.kind === 'decision')
}

async function readDecisions(): Promise<JournalRecord[]> {
  await sink.flush()
  const records = await readJournalRecords(tempDir, SESSION_ID)
  return records.filter((record) => record.kind === 'decision')
}

describe('every decision record carries policyHash', () => {
  /**
   * The invariant that matters most: provenance is stamped by construction,
   * so a decision path nobody thought about still records the rules it ran
   * under. Each case below reaches the writer through a different assembler
   * (`decisionInfoOf`, `bookkeepingDecisionInfo`, `unsafeClientFrameDecision`,
   * and the fail-closed `denyOnGateError`).
   */
  async function expectAllStamped(policy: Policy): Promise<JournalRecord[]> {
    const decisions = await readDecisions()
    expect(decisions.length).toBeGreaterThan(0)
    for (const record of decisions) {
      expect(record.decision?.policyHash).toBe(policyHashOf(policy))
    }
    return decisions
  }

  test('an allowed tools/call records the policy fingerprint', async () => {
    const policy = policyOf({ defaultDecision: 'allow' })
    const { gate } = createHarness({ policy })

    await gate.gateClientMessage(toolCall(1, 'read_file'))

    const decisions = await expectAllStamped(policy)
    expect(decisions[0]!.decision?.outcome).toBe('allow')
    expect(decisions[0]!.decision?.policyHash).toMatch(SHA256_HEX_PATTERN)
  })

  test('a denied tools/call records the policy fingerprint', async () => {
    const policy = policyOf({ defaultDecision: 'deny' })
    const { gate } = createHarness({ policy })

    await gate.gateClientMessage(toolCall(1, 'delete_repo'))

    const decisions = await expectAllStamped(policy)
    expect(decisions[0]!.decision?.outcome).toBe('deny')
  })

  test('the tools/list bookkeeping records carry it too', async () => {
    const policy = policyOf({
      defaultDecision: 'allow',
      servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
    })
    const { gate } = createHarness({ policy })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    await gate.gateServerMessage(toolsListResponse(77))

    const decisions = await expectAllStamped(policy)
    expect(decisions.map((record) => record.decision?.rule)).toEqual([
      'toolsList.original',
      'toolsList.filtered',
    ])
  })

  test('an unparseable client frame denial carries it', async () => {
    const policy = policyOf({ defaultDecision: 'deny' })
    const { gate } = createHarness({ policy })

    await gate.gateClientMessage(frameOf('} not json at all {'))

    const decisions = await expectAllStamped(policy)
    expect(decisions[0]!.decision?.rule).toBe('unparseable-client-frame')
  })

  test('the fail-closed gate-error path carries it, not an empty string', async () => {
    // The hash is computed once at gate construction, so a gate-internal
    // failure -- where nothing about the call was resolved -- still records
    // which rules were in force.
    const policy = policyOf({ defaultDecision: 'allow' })
    const { gate } = createHarness({ policy, inventory: brokenInventory() })

    await gate.gateClientMessage(toolCall(1, 'read_file'))

    const decisions = await expectAllStamped(policy)
    expect(decisions.at(-1)?.decision?.rule).toBe('gate-error')
    expect(errors).toHaveLength(1)
  })

  test('two gates on different policies stamp different fingerprints', async () => {
    const allowing = policyOf({ defaultDecision: 'allow' })
    const { gate } = createHarness({ policy: allowing })

    await gate.gateClientMessage(toolCall(1, 'read_file'))

    const stamped = (await readDecisions())[0]!.decision?.policyHash
    expect(stamped).toBe(policyHashOf(allowing))
    expect(stamped).not.toBe(policyHashOf(policyOf({ defaultDecision: 'deny' })))
  })
})

describe('grantsHash rides only on agent sessions', () => {
  test('a session with no agent scope writes no grantsHash key at all', async () => {
    // The `wrap` path: absent, not null and not undefined -- the same
    // "absent means no agent" convention `agentName` follows.
    //
    // Asserted on the record as the gate BUILT it, not as it reads back:
    // `JSON.stringify` drops `grantsHash: undefined` exactly as it drops an
    // absent key, so a round-tripped record cannot tell the two apart, and
    // wave 3 will hash the in-memory record (TS-L1).
    const harness = createHarness()

    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))

    const decision = capturedDecisions(harness)[0]!.decision!
    expect(Object.hasOwn(decision, 'grantsHash')).toBe(false)
    expect(decision.policyHash).toMatch(SHA256_HEX_PATTERN)
    // And the same holds once it has been through storage.
    expect(Object.hasOwn((await readDecisions())[0]!.decision!, 'grantsHash')).toBe(false)
  })

  test('an agent scope that reports a fingerprint stamps it on the record', async () => {
    const grantsHash = 'b'.repeat(64)
    const { gate } = createHarness({ agentScope: scopeWithProvenance(() => grantsHash) })

    await gate.gateClientMessage(toolCall(1, 'read_file'))

    expect((await readDecisions())[0]!.decision?.grantsHash).toBe(grantsHash)
  })

  test('the fingerprint is read at write time, so a grant edit shows on the next record', async () => {
    // A fixed string captured at session start would freeze provenance for
    // the session's whole life; the scope is re-read per record instead.
    let current = 'c'.repeat(64)
    const { gate } = createHarness({ agentScope: scopeWithProvenance(() => current) })

    await gate.gateClientMessage(toolCall(1, 'read_file'))
    current = 'd'.repeat(64)
    await gate.gateClientMessage(toolCall(2, 'read_file'))

    const stamped = (await readDecisions()).map((record) => record.decision?.grantsHash)
    expect(stamped).toEqual(['c'.repeat(64), 'd'.repeat(64)])
  })

  test('bookkeeping records on an agent session carry the fingerprint too', async () => {
    const grantsHash = 'e'.repeat(64)
    const { gate } = createHarness({ agentScope: scopeWithProvenance(() => grantsHash) })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    await gate.gateServerMessage(toolsListResponse(77))

    const decisions = await readDecisions()
    expect(decisions.length).toBeGreaterThan(0)
    for (const record of decisions) {
      expect(record.decision?.grantsHash).toBe(grantsHash)
    }
  })
})

describe('a live agent-watch drives grantsHash on the next record', () => {
  function agentRecordOf(tools: readonly string[]): AgentRecord {
    return {
      name: 'research-bot',
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-08-01T00:00:00.000Z',
      grants: { [SERVER_NAME]: { tools: [...tools] } },
    }
  }


  test('a grant edit picked up by a poll changes the fingerprint on the following record', async () => {
    // The full path the invariant exists for: `agent grant` edits the store,
    // the watch swaps the scope behind its frozen facade, and the very next
    // decision record names the new matrix -- no session restart, and no
    // record left claiming rules that were already superseded.
    const before = agentRecordOf(['read_*'])
    const after = agentRecordOf(['read_*', 'write_file'])
    let served: AgentRecord = before

    const watch = startAgentWatch({
      record: before,
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.resolve(served) },
      pollIntervalMs: 5,
      onRevoked: () => undefined,
      onError: (error) => errors.push(error),
    })
    const { gate } = createHarness({ agentScope: watch.scope })

    await gate.gateClientMessage(toolCall(1, 'read_file'))
    served = after
    watch.start()
    // Waits for the swap to be OBSERVED rather than sleeping past a guessed
    // duration: a fixed sleep against a 5 ms poll is the kind of race a
    // loaded CI box loses first (TS-L4).
    await waitUntil('the widened grant to reach the scope', () =>
      watch.scope.isGranted('write_file'),
    )
    watch.stop()
    await gate.gateClientMessage(toolCall(2, 'read_file'))

    const stamped = (await readDecisions()).map((record) => record.decision?.grantsHash)
    expect(stamped).toEqual([grantsHashOf(before.grants), grantsHashOf(after.grants)])
    expect(stamped[0]).not.toBe(stamped[1])
    expect(errors).toEqual([])
  })

  test('a grant held through a group is fingerprinted EXPANDED, not as the empty personal matrix', async () => {
    // M5.5 п.2 decision G5: the watch reads through the effective-agent
    // reader, so what the record names is what the agent could actually do at
    // that moment -- an auditor reading `grantsHash` must not have to know
    // whether the access came from a personal grant or a group.
    const personal: AgentRecord = { ...agentRecordOf([]), grants: {} }
    const group: GroupRecord = {
      name: 'analytics',
      createdAt: '2026-08-31T00:00:00.000Z',
      grants: { [SERVER_NAME]: { tools: ['read_file'] } },
      members: [personal.name],
    }
    const reader = createEffectiveAgentReader({
      agents: {
        getAgent: () => Promise.resolve(personal),
        findAgentByToken: () => Promise.resolve(personal),
      },
      groups: { groupsOf: () => Promise.resolve([group]) },
    })

    const watch = startAgentWatch({
      record: (await reader.getAgent(personal.name)) as AgentRecord,
      serverName: SERVER_NAME,
      store: reader,
      pollIntervalMs: 5,
      onRevoked: () => errors.push(new Error('unexpected revocation')),
      onError: (error) => errors.push(error),
    })
    const { gate } = createHarness({ agentScope: watch.scope })

    await gate.gateClientMessage(toolCall(1, 'read_file'))

    const stamped = (await readDecisions()).map((record) => record.decision?.grantsHash)
    expect(stamped).toEqual([grantsHashOf({ [SERVER_NAME]: { tools: ['read_file'] } })])
    expect(stamped[0]).not.toBe(grantsHashOf(personal.grants))
    expect(errors).toEqual([])
  })
})

const APPROVAL_POLICY = {
  defaultDecision: 'require-approval',
  quarantine: { enabled: false },
  approval: { timeoutMs: 10_000, grantTtlMs: 60_000 },
} as const

async function waitForPendingApproval(): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [match] = await queue.list()
    if (match !== undefined) return match
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no approval was enqueued')
}

/** The record exactly as it sits in storage, for absence assertions. */
async function storedPendingDoc(approvalId: string): Promise<Record<string, unknown>> {
  const db = await openApprovalsDb(approvalsDir)
  const row = db.handle.db
    .prepare('SELECT doc FROM approvals WHERE approval_id = ?')
    .get(approvalId) as { doc: string }
  return JSON.parse(row.doc) as Record<string, unknown>
}

describe('a pending approval pins the rules it was requested under', () => {
  /**
   * The point of the task: an operator resolves a request minutes after it
   * was made, so the request itself must name the policy and grant matrix in
   * force AT REQUEST TIME. The pending record and the correlated
   * `require-approval-pending` decision record read the same two sources (the
   * gate's construction-time policy hash and the scope's live getter), so
   * they cannot disagree.
   */
  test('both fingerprints land on the record and match the pending decision record', async () => {
    const policy = policyOf(APPROVAL_POLICY)
    const grantsHash = 'f'.repeat(64)
    const { gate } = createHarness({
      policy,
      agentScope: scopeWithProvenance(() => grantsHash),
    })

    const verdictPromise = gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdictPromise

    expect(pending.policyHash).toBe(policyHashOf(policy))
    expect(pending.grantsHash).toBe(grantsHash)

    // The agreement is the invariant: one source per hash, so the pending
    // record and the decision record can never name different rules.
    const requested = (await readDecisions()).find(
      (record) => record.decision?.approvalId === pending.approvalId,
    )
    expect(requested?.decision?.outcome).toBe('require-approval-pending')
    expect(pending.policyHash).toBe(requested?.decision?.policyHash)
    expect(pending.grantsHash).toBe(requested?.decision?.grantsHash)
  })

  test('a wrap-style request with no agent carries policyHash and no grantsHash key', async () => {
    const policy = policyOf(APPROVAL_POLICY)
    const { gate } = createHarness({ policy })

    const verdictPromise = gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdictPromise

    expect(pending.policyHash).toBe(policyHashOf(policy))
    // Absent in STORAGE, not merely undefined in the listing.
    const stored = await storedPendingDoc(pending.approvalId)
    expect(stored['policyHash']).toBe(policyHashOf(policy))
    expect(Object.hasOwn(stored, 'grantsHash')).toBe(false)
  })
})

describe('an agent session can never look like an agentless one', () => {
  /**
   * `grantsHash` absent on a decision record MEANS "there was no agent" — the
   * same "absent, not null" convention `agentName` follows. A scope that has
   * an `agentName` but no fingerprint getter produced exactly that record:
   * an agent session that reads back as agentless. A silent evidence
   * downgrade, in the layer waves 3-5 will chain and sign, that the compiler
   * would never flag. So the getter is REQUIRED on `GateAgentScope` — the one
   * production implementer (`session/agent-watch.ts`) already provides it.
   */
  // Each of these spawns a full `tsc` pass; under a loaded full-suite run
  // (coverage on, other suites in flight) it exceeded the default 5 s once
  // (2026-09-02) while passing alone in ~1 s — so the budget is explicit.
  test('a scope without a grants fingerprint does not compile', { timeout: TYPECHECK_TIMEOUT_MS }, () => {
    const diagnostics = typecheckSource(`
      import type { GateAgentScope } from '../../src/proxy/gate-helpers.js'

      export const scope: GateAgentScope = {
        agentName: 'research-bot',
        isGranted: () => true,
        filterVisible: (tools) => [...tools],
      }
    `)

    expect(diagnostics).toMatch(/grantsHash/)
  })

  test('a scope with one compiles', { timeout: TYPECHECK_TIMEOUT_MS }, () => {
    const diagnostics = typecheckSource(`
      import type { GateAgentScope } from '../../src/proxy/gate-helpers.js'

      export const scope: GateAgentScope = {
        agentName: 'research-bot',
        isGranted: () => true,
        filterVisible: (tools) => [...tools],
        grantsHash: () => 'a'.repeat(64),
      }
    `)

    expect(diagnostics).toBe('')
  })

  test('every record of an agent session carries a fingerprint, agentless ones none', () => {
    // The runtime half of the same statement, asserted on the IN-MEMORY
    // record: `JSON.stringify` drops `grantsHash: undefined` exactly as it
    // drops an absent key, so a serialized record cannot tell the two apart.
    const withAgent = createHarness({ agentScope: scopeWithProvenance(() => 'a'.repeat(64)) })
    const withoutAgent = createHarness()

    return Promise.all([
      withAgent.gate.gateClientMessage(toolCall(1, 'read_file')),
      withoutAgent.gate.gateClientMessage(toolCall(2, 'read_file')),
    ]).then(() => {
      for (const record of capturedDecisions(withAgent)) {
        expect(Object.hasOwn(record.decision as object, 'grantsHash')).toBe(true)
      }
      for (const record of capturedDecisions(withoutAgent)) {
        expect(Object.hasOwn(record.decision as object, 'grantsHash')).toBe(false)
      }
    })
  })
})

describe('a deferred decision names the rules it was DECIDED under, not written under', () => {
  /**
   * The provenance-shear defect (M5 wave-1 review, HIGH). The gate waits up
   * to `approval.timeoutMs` for an operator while `agent-watch` re-polls the
   * grant matrix every few seconds. Reading the live fingerprint when the
   * TERMINAL record is written therefore names a matrix that may never have
   * authorized the call — and in the approve-then-narrow direction it erases
   * the evidence that the agent held a broad matrix during a destructive
   * call. The pair is captured ONCE, before the enqueue, and carried through
   * every record about that one decided call.
   */
  const REQUEST_TIME_HASH = '1'.repeat(64)
  const EDITED_HASH = '2'.repeat(64)

  interface DeferredRun {
    readonly decisions: JournalRecord[]
    readonly pending: PendingApproval
    readonly policy: Policy
  }

  /**
   * Runs one require-approval call to its terminal record, swapping the
   * agent's grant fingerprint while the operator is still deciding.
   * `settle` is handed the enqueued approval id and the waiter's clock knob.
   */
  async function runWithGrantEditMidFlight(
    settle: (approvalId: string, advanceMs: (ms: number) => void) => Promise<void>,
  ): Promise<DeferredRun> {
    let nowMs = Date.parse('2026-08-18T00:00:00.000Z')
    const waiter = createApprovalWaiter({ pollIntervalMs: 5, clock: () => nowMs })
    const policy = policyOf(APPROVAL_POLICY)
    let currentHash = REQUEST_TIME_HASH
    const { gate, captured } = createHarness({
      policy,
      agentScope: scopeWithProvenance(() => currentHash),
      approvalWaiter: waiter,
    })

    const verdictPromise = gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    // `agent grant`/`agent ungrant` lands while the request is still pending.
    currentHash = EDITED_HASH
    await settle(pending.approvalId, (ms) => {
      nowMs += ms
    })
    await verdictPromise

    return {
      decisions: captured.filter((record) => record.kind === 'decision'),
      pending,
      policy,
    }
  }

  test('an approved call records the request-time grant fingerprint', async () => {
    const run = await runWithGrantEditMidFlight(async (approvalId) => {
      await queue.resolve(approvalId, { outcome: 'approved', actor: 'operator' })
    })

    const terminal = run.decisions.at(-1)?.decision
    expect(terminal?.outcome).toBe('approved')
    expect(terminal?.grantsHash).toBe(REQUEST_TIME_HASH)
    expect(terminal?.policyHash).toBe(policyHashOf(run.policy))
  })

  test('an operator denial records the request-time grant fingerprint', async () => {
    const run = await runWithGrantEditMidFlight(async (approvalId) => {
      await queue.resolve(approvalId, { outcome: 'denied', actor: 'operator' })
    })

    const terminal = run.decisions.at(-1)?.decision
    expect(terminal?.outcome).toBe('denied-by-operator')
    expect(terminal?.grantsHash).toBe(REQUEST_TIME_HASH)
  })

  test('a timed-out call records the request-time grant fingerprint', async () => {
    const run = await runWithGrantEditMidFlight((_approvalId, advanceMs) => {
      // The waiter's own clock is injected, so the deadline is crossed
      // deterministically rather than by sleeping past a wall-clock timeout.
      advanceMs(APPROVAL_POLICY.approval.timeoutMs + 1)
      return Promise.resolve()
    })

    const terminal = run.decisions.at(-1)?.decision
    expect(terminal?.outcome).toBe('timeout')
    expect(terminal?.grantsHash).toBe(REQUEST_TIME_HASH)
  })

  test('every record about one deferred call names the same rules', async () => {
    const run = await runWithGrantEditMidFlight(async (approvalId) => {
      await queue.resolve(approvalId, { outcome: 'approved', actor: 'operator' })
    })

    // Pending file, pending decision record and terminal record: three
    // artefacts, one captured pair -- agreement by construction, not by luck.
    expect(run.pending.grantsHash).toBe(REQUEST_TIME_HASH)
    const fingerprints = run.decisions.map((record) => record.decision?.grantsHash)
    expect(fingerprints).toEqual([REQUEST_TIME_HASH, REQUEST_TIME_HASH])
    expect(run.decisions.map((record) => record.decision?.outcome)).toEqual([
      'require-approval-pending',
      'approved',
    ])
  })

  test('an undeferred call still snapshots at write time, so a later edit shows up', async () => {
    // The captured snapshot is scoped to ONE decided call: it must not turn
    // the gate's live provenance into a session-start freeze.
    let current = 'c'.repeat(64)
    const { gate, captured } = createHarness({ agentScope: scopeWithProvenance(() => current) })

    await gate.gateClientMessage(toolCall(1, 'read_file'))
    current = 'd'.repeat(64)
    await gate.gateClientMessage(toolCall(2, 'read_file'))

    const stamped = captured
      .filter((record) => record.kind === 'decision')
      .map((record) => record.decision?.grantsHash)
    expect(stamped).toEqual(['c'.repeat(64), 'd'.repeat(64)])
  })
})

describe('the snapshot is taken where the decision is MADE, not inside the approval flow', () => {
  /**
   * The residue of the wave-1 shear defect (M5 wave-2 review, finding 2).
   * `requestApproval` used to snapshot provenance itself — but only AFTER
   * awaiting `resolveLateApproval`, a storage read. An `agent-watch` poll
   * landing in that window stamped the pending row and every record about the
   * call with a matrix that did not produce the decision. The window was one
   * read rather than the 60s wave 1 closed, but it is the same defect, and it
   * left the invariant resting on statement order inside the approval flow.
   *
   * The seam is the gate clock, which `checkRecentApproval` reads as part of
   * that very lookup (`grants.ts`: `const nowMs = clock()`), so flipping the
   * fingerprint there IS "a grant edit landing during the late-approval read"
   * — deterministically, with no sleeping or racing.
   */
  const DECISION_TIME_HASH = '7'.repeat(64)
  const MID_READ_HASH = '8'.repeat(64)

  test('a grant edit during the late-approval read reaches neither the pending row nor any record', async () => {
    let currentHash = DECISION_TIME_HASH
    let nowMs = Date.parse('2026-08-18T00:00:00.000Z')
    let flipped = false
    const clock = (): number => {
      // The FIRST clock read on this path is the one inside
      // `checkRecentApproval`, i.e. strictly after `decide()` and strictly
      // before the approval flow used to sample provenance.
      if (!flipped) {
        flipped = true
        currentHash = MID_READ_HASH
      }
      return nowMs
    }
    const policy = policyOf(APPROVAL_POLICY)
    const { gate, captured } = createHarness({
      policy,
      agentScope: scopeWithProvenance(() => currentHash),
      approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5, clock: () => nowMs }),
      clock,
    })

    const verdictPromise = gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    await verdictPromise

    // The read that flipped it really did run: otherwise this test proves
    // nothing about the window it claims to close.
    expect(flipped).toBe(true)
    expect(currentHash).toBe(MID_READ_HASH)

    expect(pending.grantsHash).toBe(DECISION_TIME_HASH)
    const decisions = captured.filter((record) => record.kind === 'decision')
    expect(decisions.map((record) => record.decision?.outcome)).toEqual([
      'require-approval-pending',
      'approved',
    ])
    for (const record of decisions) {
      expect(record.decision?.grantsHash).toBe(DECISION_TIME_HASH)
      expect(record.decision?.policyHash).toBe(policyHashOf(policy))
    }
  })
})
