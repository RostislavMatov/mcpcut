import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { GateAgentScope } from '../../src/proxy/gate.js'
import { ERROR_CODE_POLICY_DENIED } from '../../src/proxy/synthesize.js'
import { runWrap, type RunWrapOptions } from '../../src/proxy/wrap.js'
import {
  FAKE_SERVER_PATH,
  createClientHarness,
  readJournalRecords,
  receivedMessagesOf,
  requestLine,
  waitUntil,
  type ClientHarness,
  type SessionResult,
} from './harness.js'
import { grantsHashOf } from '../../src/policy/provenance.js'

/**
 * M3 plumbing through the existing stdio wiring (`wrap` -> `relay` ->
 * `wire-policy` -> gate): the optional `agentScope` reaches the gate, and —
 * the explicit parity gate of Task 11 — a `RunWrapOptions` without any of
 * the new fields behaves exactly as M2. The M1/M2 suites remain the
 * authoritative pins and are untouched; this file adds the delta only.
 */

const SERVER_NAME = 'testsrv'

function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...document })
  if (!result.ok) throw new Error(`test policy is invalid: ${result.error.message}`)
  return result.policy
}

function scopeOf(granted: readonly string[]): GateAgentScope {
  const isGranted = (tool: string): boolean =>
    granted.some((pattern) =>
      pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern,
    )
  return {
    agentName: 'research-bot',
    isGranted,
    filterVisible: (tools) => tools.filter(isGranted),
    grantsHash: () => grantsHashOf({ github: { tools: [...granted] } }),
  }
}

interface RunArgs {
  readonly journalDir: string
  readonly sessionId: string
  readonly lines: readonly string[]
  readonly expectedResponses: number
  readonly extraOptions?: Partial<RunWrapOptions>
}

/** One full wrap run against the fake server with injected client streams. */
async function runSession(args: RunArgs): Promise<SessionResult> {
  const harness: ClientHarness = createClientHarness()
  const runPromise = runWrap(process.execPath, [FAKE_SERVER_PATH], {
    dir: args.journalDir,
    sessionId: args.sessionId,
    stdin: harness.clientOutbox,
    stdout: harness.clientStdout,
    stderr: harness.clientStderr,
    killEscalationMs: 500,
    relayDrainTimeoutMs: 1000,
    serverName: SERVER_NAME,
    approvalsBaseDir: join(args.journalDir, 'approvals'),
    inventoryStorePath: join(args.journalDir, `inventory-${args.sessionId}.json`),
    ...args.extraOptions,
  })
  for (const line of args.lines) {
    harness.clientOutbox.write(line)
  }
  await waitUntil(() => harness.receivedLineCount() >= args.expectedResponses)
  harness.clientOutbox.end()
  const exitCode = await runPromise
  return {
    received: Buffer.concat(harness.clientInboxChunks),
    messages: receivedMessagesOf(harness),
    records: await readJournalRecords(args.journalDir, args.sessionId),
    stderrText: harness.receivedStderrText(),
    exitCode,
  }
}

let journalDir: string

beforeAll(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-wrap-agent-m3-'))
})

afterAll(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('runWrap: RunWrapOptions without the new M3 fields ≡ M2', () => {
  test('a policy run with no agentScope relays and journals exactly as M2', async () => {
    const result = await runSession({
      journalDir,
      sessionId: 'wrap-m3-parity',
      lines: [requestLine(1, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })],
      expectedResponses: 1,
      extraOptions: { policy: policyOf({ defaultDecision: 'allow' }) },
    })

    expect(result.exitCode).toBe(0)
    // The call reached the fake server and its real response came back.
    expect(result.messages[0]).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(result.messages[0]).not.toHaveProperty('error')
    // Journal shape is the M2 shape: message records plus one allow decision.
    const decisions = result.records.filter((record) => record.kind === 'decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toMatchObject({
      outcome: 'allow',
      serverName: SERVER_NAME,
      toolName: 'echo',
    })
  })
})

describe('runWrap: agentScope reaches the gate through relay/wire-policy', () => {
  test('a non-granted tool is denied with the agent rule and never reaches the server', async () => {
    const result = await runSession({
      journalDir,
      sessionId: 'wrap-m3-agent-deny',
      lines: [requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })],
      expectedResponses: 1,
      extraOptions: {
        policy: policyOf({ defaultDecision: 'allow' }),
        agentScope: scopeOf(['read_*']),
      },
    })

    expect(result.exitCode).toBe(0)
    const answer = result.messages[0]!
    expect(answer['id']).toBe(2)
    expect((answer['error'] as Record<string, any>).code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(String((answer['error'] as Record<string, any>).data.rule)).toBe(
      `agent: no grant for ${SERVER_NAME}/echo`,
    )
    const decisions = result.records.filter((record) => record.kind === 'decision')
    expect(decisions.at(-1)?.decision?.rule).toBe(`agent: no grant for ${SERVER_NAME}/echo`)
  })

  test('a granted tool passes the agent gate and the M2 chain unchanged', async () => {
    const result = await runSession({
      journalDir,
      sessionId: 'wrap-m3-agent-allow',
      lines: [requestLine(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })],
      expectedResponses: 1,
      extraOptions: {
        policy: policyOf({ defaultDecision: 'allow' }),
        agentScope: scopeOf(['echo']),
      },
    })

    expect(result.messages[0]).not.toHaveProperty('error')
    const decisions = result.records.filter((record) => record.kind === 'decision')
    expect(decisions.at(-1)?.decision).toMatchObject({ outcome: 'allow', toolName: 'echo' })
  })

  test('tools/list through wrap is filtered down to the agent grants', async () => {
    const result = await runSession({
      journalDir,
      sessionId: 'wrap-m3-agent-list',
      lines: [requestLine(4, 'tools/list')],
      expectedResponses: 1,
      extraOptions: {
        policy: policyOf({ defaultDecision: 'allow' }),
        agentScope: scopeOf(['read_*']), // fake server only advertises `echo`
      },
    })

    const listResponse = result.messages[0]!
    expect((listResponse['result'] as Record<string, any>).tools).toEqual([])
  })
})
