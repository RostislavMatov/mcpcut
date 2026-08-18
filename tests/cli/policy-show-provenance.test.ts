import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runPolicyShow } from '../../src/cli/policy-cmd.js'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { Frame } from '../../src/protocol/split.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { loadPolicy } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import type { Policy } from '../../src/policy/schema.js'
import { createPolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * `policy show` and the policy fingerprint (M5 wave 1, task 1.5). Every
 * `decision` record carries a `policyHash`; without a command that prints the
 * same value for a file on disk, that hash is an opaque token no operator or
 * auditor can tie back to a set of rules. These tests pin the two properties
 * that make it usable: it is the hash of the EFFECTIVE policy (so it is
 * reproducible from any file that resolves to the same rules), and it is the
 * SAME value the gate stamps on records.
 *
 * Split out of `policy-cmd.test.ts` (already ~580 lines) because the
 * cross-check against a real decision record needs the gate harness, which
 * has no business in the CLI-argument suite.
 */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-policy-show-provenance'

let cwd: string
let journalDir: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-show-prov-cwd-'))
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-show-prov-home-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const VALID_POLICY = {
  version: 1,
  defaultDecision: 'require-approval',
  servers: {
    github: {
      defaultDecision: 'allow',
      tools: { 'delete_*': 'require-approval', list_issues: 'allow' },
    },
  },
}

async function writePolicyAt(name: string, content: unknown): Promise<string> {
  const path = join(cwd, name)
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

/** The effective (defaults-applied) policy behind a file, loaded exactly the way the command loads it. */
async function loadEffectivePolicy(path: string): Promise<Policy> {
  const result = await loadPolicy({ explicitPath: path })
  if (result.status !== 'loaded') {
    throw new Error(`test policy at ${path} did not load: ${result.status}`)
  }
  return result.policy
}

describe('policy show prints the policy fingerprint', () => {
  test('the readable view prints policyHash directly under the source path', async () => {
    const path = await writePolicyAt('policy.json', VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path], io)

    expect(exitCode).toBe(0)
    const expected = policyHashOf(await loadEffectivePolicy(path))
    expect(expected).toMatch(SHA256_HEX_PATTERN)
    const lines = io.out().split('\n')
    const sourceIndex = lines.findIndex((line) => line === `source: ${path}`)
    expect(sourceIndex).toBeGreaterThanOrEqual(0)
    expect(lines[sourceIndex + 1]).toBe(`policyHash: ${expected}`)
  })

  test('--json carries policyHash without dropping or renaming any existing field', async () => {
    const path = await writePolicyAt('policy.json', VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--json'], io)

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.policyHash).toBe(policyHashOf(await loadEffectivePolicy(path)))
    // Guard against an accidental envelope change: every field this view
    // emitted before task 1.5 must still be there, under the same name.
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['trustClass', 'sourcePath', 'policy']))
    expect(parsed.trustClass).toBe('operator-launched')
    expect(parsed.sourcePath).toBe(path)
    expect(parsed.policy.defaultDecision).toBe('require-approval')
    expect(typeof parsed.policy.approval.timeoutMs).toBe('number')
  })

  test('--entry-point keeps its entryPoint label alongside the new hash', async () => {
    const path = await writePolicyAt('policy.json', VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(
      ['--policy', path, '--entry-point', 'serve', '--json'],
      io,
      { cwd, journalDir, env: {} },
    )

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.entryPoint).toBe('serve')
    expect(parsed.trustClass).toBe('operator-launched')
    expect(parsed.policyHash).toBe(policyHashOf(await loadEffectivePolicy(path)))
  })

  /**
   * The property that makes the printed value reproducible at all: the hash
   * covers the RULES, not the bytes. A file that leaves `quarantine` to the
   * schema's defaults and a file that spells the same defaults out state the
   * same ruleset, so an auditor matching a record's `policyHash` against
   * either file gets the same answer.
   */
  test('the printed hash is the hash of the effective policy, not of the file', async () => {
    const implicit = await writePolicyAt('implicit.json', VALID_POLICY)
    const explicit = await writePolicyAt('explicit.json', {
      ...VALID_POLICY,
      quarantine: { enabled: true, onQuarantined: 'require-approval' },
    })
    const implicitIo = fakeIo()
    const explicitIo = fakeIo()

    await runPolicyShow(['--policy', implicit, '--json'], implicitIo)
    await runPolicyShow(['--policy', explicit, '--json'], explicitIo)

    const implicitHash = JSON.parse(implicitIo.out()).policyHash
    const explicitHash = JSON.parse(explicitIo.out()).policyHash
    expect(implicitHash).toMatch(SHA256_HEX_PATTERN)
    expect(explicitHash).toBe(implicitHash)
  })

  test('a changed rule changes the printed hash', async () => {
    const before = await writePolicyAt('before.json', VALID_POLICY)
    const after = await writePolicyAt('after.json', { ...VALID_POLICY, defaultDecision: 'deny' })
    const beforeIo = fakeIo()
    const afterIo = fakeIo()

    await runPolicyShow(['--policy', before, '--json'], beforeIo)
    await runPolicyShow(['--policy', after, '--json'], afterIo)

    expect(JSON.parse(afterIo.out()).policyHash).not.toBe(JSON.parse(beforeIo.out()).policyHash)
  })
})

/**
 * The reason the command prints the hash at all: an auditor holding an
 * exported decision record must be able to point `policy show` at a file and
 * see the SAME string. Both sides here are production code paths -- the CLI
 * view and the gate's decision writer -- so this fails if either one starts
 * hashing something else.
 */
describe('the printed hash equals the one a gate stamps on a decision record', () => {
  test('an allowed tools/call records exactly what policy show prints', async () => {
    const path = await writePolicyAt('policy.json', { version: 1, defaultDecision: 'allow' })
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--json'], io)
    const printedHash = JSON.parse(io.out()).policyHash

    expect(exitCode).toBe(0)
    const stamped = await stampedPolicyHash(await loadEffectivePolicy(path))
    expect(stamped).toMatch(SHA256_HEX_PATTERN)
    expect(printedHash).toBe(stamped)
  })
})

/** Runs one allowed `tools/call` through a real gate and returns the `policyHash` it wrote. */
async function stampedPolicyHash(policy: Policy): Promise<string | undefined> {
  const sink: JournalSink = createJournalSink(SESSION_ID, { dir: journalDir })
  try {
    const gate = createPolicyGate({
      policy,
      serverName: SERVER_NAME,
      sessionId: SESSION_ID,
      inventory: trustedInventory(),
      approvalQueue: createApprovalQueue({ baseDir: join(journalDir, 'approvals') }),
      approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
      grantRegistry: createGrantRegistry(),
      sink,
      clientWriter: discardingWriter(),
      approvalsBaseDir: join(journalDir, 'approvals'),
      onError: () => undefined,
    })

    await gate.gateClientMessage(toolCallFrame('read_file'))
    await sink.flush()
    const records = await readJournalRecords(journalDir, SESSION_ID)
    const decisions = records.filter((record) => record.kind === 'decision')
    expect(decisions.length).toBeGreaterThan(0)
    return decisions[0]?.decision?.policyHash
  } finally {
    await sink.close()
  }
}

function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: (tools) =>
      Promise.resolve({ known: tools.map((tool) => tool.name), new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

function discardingWriter(): OrderedWriter {
  return { writeMessage: () => Promise.resolve(), dispose: () => undefined }
}

function toolCallFrame(name: string): Frame {
  const text = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: {} },
  })
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}
