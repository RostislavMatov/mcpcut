import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { POLICY_RECHECK_MIN_MS } from '../../src/policy/constants.js'
import { createPolicyProvider, type PolicyProvider } from '../../src/policy/reload.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * Hot reload at the gate (policy-tool-rules-ui plan, wave 2). The gate is
 * built on a `PolicyProvider` whose file is a fake; each test edits the fake
 * and checks that the VERY NEXT decision — no warm-up call, nothing awaited
 * on the provider — runs under the new rules and that its record names the
 * new `policyHash` (the point where the fingerprint used to be computed once
 * and would have gone stale). The plain-`Policy` path is pinned by every
 * other gate test. The clock is injected so one edit = one lapsed cooldown.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-reload'
const SOURCE_PATH = '/plane/policy.json'

let tempDir: string
let sink: JournalSink
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-gate-reload-test-'))
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...document })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: number, name: string): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { path: '/tmp/x' } } })
}

function toolsListRequest(id: number): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
}

function toolsListResponse(id: number, names: readonly string[]): Frame {
  return frameOf({ jsonrpc: '2.0', id, result: { tools: names.map((name) => ({ name })) } })
}

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

/** A provider over a fake file the test can edit between calls. Editing lets one cooldown lapse. */
interface EditablePolicy {
  readonly provider: PolicyProvider
  edit(document: Record<string, unknown> | string, opts?: EditOptions): void
  /** Advances the injected clock past `POLICY_RECHECK_MIN_MS`, so the next call checks the file. */
  lapseCooldown(): void
  readonly reloads: number
}

interface EditOptions {
  /** `false` leaves the clock where it is, so the next call is still inside the cooldown window. */
  readonly lapseCooldown?: boolean
}

function editablePolicy(initialDocument: Record<string, unknown>): EditablePolicy {
  const initial = policyOf(initialDocument)
  let text = JSON.stringify({ version: 1, quarantine: { enabled: false }, ...initialDocument })
  let version = 1
  let clock = 1_000_000
  const state = { reloads: 0 }
  const provider = createPolicyProvider({
    initial,
    sourcePath: SOURCE_PATH,
    loadOptions: { explicitPath: SOURCE_PATH, readFile: () => Promise.resolve(text) },
    stat: () => Promise.resolve({ mtimeMs: version, size: text.length }),
    statSync: () => ({ mtimeMs: version, size: text.length }),
    readFileSync: () => text,
    now: () => clock,
    onReload: () => {
      state.reloads += 1
    },
    onError: (failure) => errors.push(new Error(failure.errors.join('; '))),
  })
  const lapseCooldown = (): void => {
    clock += POLICY_RECHECK_MIN_MS
  }
  return {
    provider,
    edit: (document, opts) => {
      text =
        typeof document === 'string'
          ? document
          : JSON.stringify({ version: 1, quarantine: { enabled: false }, ...document })
      version += 1
      if (opts?.lapseCooldown !== false) lapseCooldown()
    },
    lapseCooldown,
    get reloads() {
      return state.reloads
    },
  }
}

interface GateHarness {
  readonly gate: PolicyGate
  readonly written: Buffer[]
  readonly captured: JournalRecord[]
}

function createHarness(policy: Policy | PolicyProvider): GateHarness {
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
    policy,
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: trustedInventory(),
    approvalQueue: createApprovalQueue({ baseDir: join(tempDir, 'approvals') }),
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink: capturingSink,
    clientWriter: writer,
    approvalsBaseDir: join(tempDir, 'approvals'),
    onError: (error: unknown) => errors.push(error),
  })
  return { gate, written, captured }
}

function decisionsOf(harness: GateHarness): JournalRecord[] {
  return harness.captured.filter((record) => record.kind === 'decision')
}

function lastDecision(harness: GateHarness): Record<string, unknown> {
  const record = decisionsOf(harness).at(-1)
  if (record === undefined || record.kind !== 'decision') throw new Error('no decision record written')
  return record.decision as unknown as Record<string, unknown>
}

function catalogNamesOf(bytes: Buffer): string[] {
  const parsed = JSON.parse(bytes.toString('utf8')) as { result: { tools: Array<{ name: string }> } }
  return parsed.result.tools.map((tool) => tool.name)
}

describe('hot reload at the gate', () => {
  test('a rule edited on disk applies to the NEXT call, and its record carries the NEW policyHash', async () => {
    const file = editablePolicy({ defaultDecision: 'allow' })
    const harness = createHarness(file.provider)
    const hashBefore = policyHashOf(file.provider.current())

    expect(await harness.gate.gateClientMessage(toolCall(1, 'read_file'))).toEqual({ action: 'forward' })
    expect(lastDecision(harness)).toMatchObject({ outcome: 'allow', policyHash: hashBefore })

    file.edit({ defaultDecision: 'allow', servers: { [SERVER_NAME]: { tools: { read_file: 'deny' } } } })

    // The FIRST call after the edit — nothing primed the provider.
    expect(await harness.gate.gateClientMessage(toolCall(2, 'read_file'))).toEqual({ action: 'drop' })
    const hashAfter = policyHashOf(file.provider.current())
    expect(hashAfter).not.toBe(hashBefore)
    expect(lastDecision(harness)).toMatchObject({
      outcome: 'deny',
      rule: `servers.${SERVER_NAME}.tools.read_file`,
      policyHash: hashAfter,
    })
    expect(errors).toEqual([])
  })

  test('a newly deny-ed tool disappears from the next tools/list', async () => {
    const file = editablePolicy({ defaultDecision: 'allow' })
    const harness = createHarness(file.provider)

    // The gate recognises a catalog response by the request id it tracked.
    await harness.gate.gateClientMessage(toolsListRequest(1))
    const before = await harness.gate.gateServerMessage(toolsListResponse(1, ['read_file', 'write_file']))
    expect(before).toEqual({ action: 'forward' })

    file.edit({ defaultDecision: 'allow', servers: { [SERVER_NAME]: { tools: { write_file: 'deny' } } } })

    // The FIRST tools/list after the edit hides the tool.
    await harness.gate.gateClientMessage(toolsListRequest(2))
    const after = await harness.gate.gateServerMessage(toolsListResponse(2, ['read_file', 'write_file']))
    expect(after.action).toBe('emit')
    if (after.action !== 'emit') throw new Error('unreachable')
    expect(catalogNamesOf(after.bytes)).toEqual(['read_file'])
    expect(errors).toEqual([])
  })

  test('classOverrides reload too: the next record classifies the tool under the new override', async () => {
    const file = editablePolicy({ defaultDecision: 'allow' })
    const harness = createHarness(file.provider)

    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))
    expect(lastDecision(harness)).toMatchObject({ toolClass: 'write' })

    file.edit({
      defaultDecision: 'allow',
      servers: { [SERVER_NAME]: { classOverrides: { read_file: 'destructive' } } },
    })

    await harness.gate.gateClientMessage(toolCall(2, 'read_file'))
    expect(lastDecision(harness)).toMatchObject({ toolClass: 'destructive' })
  })

  test('a broken edit changes nothing: the last valid rules and hash stay in force', async () => {
    const file = editablePolicy({ defaultDecision: 'allow' })
    const harness = createHarness(file.provider)
    const hash = policyHashOf(file.provider.current())

    file.edit({ defaultDecision: 'no-such-outcome' })

    expect(await harness.gate.gateClientMessage(toolCall(1, 'read_file'))).toEqual({ action: 'forward' })
    expect(lastDecision(harness)).toMatchObject({ outcome: 'allow', policyHash: hash })
    expect(errors).toHaveLength(1)
    expect(file.reloads).toBe(0)
  })

  test('within the cooldown the check is skipped; once it lapses the next call sees the edit', async () => {
    const file = editablePolicy({ defaultDecision: 'allow' })
    const harness = createHarness(file.provider)

    // The first call performs the baseline check and opens the cooldown window.
    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))
    file.edit({ defaultDecision: 'deny' }, { lapseCooldown: false })

    // Still inside the window: the file is not stat'ed, so the edit is not seen yet.
    expect(await harness.gate.gateClientMessage(toolCall(2, 'read_file'))).toEqual({ action: 'forward' })
    expect(file.reloads).toBe(0)

    // The moment it lapses, the very next call is decided under the new rules.
    file.lapseCooldown()
    expect(await harness.gate.gateClientMessage(toolCall(3, 'read_file'))).toEqual({ action: 'drop' })
    expect(file.reloads).toBe(1)
  })

  test('a plain Policy value behaves exactly as before', async () => {
    const harness = createHarness(policyOf({ defaultDecision: 'deny' }))
    expect(await harness.gate.gateClientMessage(toolCall(1, 'read_file'))).toEqual({ action: 'drop' })
    expect(lastDecision(harness)).toMatchObject({
      outcome: 'deny',
      policyHash: policyHashOf(policyOf({ defaultDecision: 'deny' })),
    })
  })
})
