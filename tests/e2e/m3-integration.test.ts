import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import { startHttpFixture, stopAllHttpFixtures } from '../cli/connect-harness.js'
import { readJournal } from '../cli/serve-harness.js'
import {
  readJournalRecords,
  requestJson,
  requestLine,
  waitUntil,
  waitUntilAsync,
} from '../proxy/harness.js'
import {
  createCliApprover,
  createGrantedAgent,
  createPlane,
  decisionsOf,
  ENV_ECHO_FIXTURE,
  HTTP_STATELESS_FIXTURE,
  POLICY_SERVER_FIXTURE,
  postMcp,
  rpcBody,
  runConnectLines,
  runOnboarding,
  runWrapBaseline,
  startConnect,
  startServe,
  writePolicyFile,
  type Plane,
} from './m3-harness.js'

/**
 * Milestone 3 end-to-end: the whole control plane assembled the way an
 * operator assembles it — **every command through `dispatch()`**, one temp
 * journal directory holding registry, vault, agents, policy, approvals and
 * journal, and no store touched except through the CLI.
 *
 * This file is deliberately NOT a re-run of the unit and command suites. Each
 * mechanism is already covered in isolation, and the cross-references below
 * point at where; what only an e2e can show is that the *composition* holds:
 * that the documented onboarding script produces a working call, that the
 * three milestone gate metrics are demonstrable, and that M2's policy chain
 * still applies on top of M3's agent grants.
 *
 * Scenarios covered elsewhere and intentionally not duplicated here:
 *  - refusal ordering (nothing spawned before authentication), vault-failure
 *    messages, HTTP upstream bridging from `connect`, and the mid-session
 *    revocation of a stdio session: `tests/cli/connect-cmd.test.ts`;
 *  - stateless header↔body validation (`-32020`), ADR-0002 mismatch refusals,
 *    401 shapes, DELETE/TTL session lifecycle, graceful shutdown:
 *    `tests/cli/serve-cmd.test.ts` and `tests/cli/serve-hardening.test.ts`;
 *  - per-carrier redaction of a marker secret: `tests/redact/leak-regression.test.ts`.
 */

const SERVER = 'github-fixture'
const HTTP_SERVER = 'stateless-fixture'
const AGENT = 'research-bot'
const SECRET_NAME = 'fixture-pat'
/** Distinctive enough to grep for, and not shaped like any REDACT_VALUE_PATTERN. */
const SECRET_MARKER = 'VAULT-MARKER-8d31c7f0'

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/**
 * Every byte the plane persisted under `tempDir`, rendered as UTF-8 and as
 * latin1. Since M4.5 the registry, agents and admins documents live in
 * `state.db` -- and, until a checkpoint, their newest pages live only in the
 * `state.db-wal` sidecar -- so a secret scan aimed at named `*.json` paths
 * would silently stop covering them. Sweeping the whole directory covers
 * every store the plane has, present and future, and the two renderings keep
 * a marker from hiding inside a byte run that is not valid UTF-8.
 */
async function persistedBytes(): Promise<readonly string[]> {
  return (await collectPersistedBytes(tempDir)).renderings
}

afterAll(() => {
  stopAllHttpFixtures()
})

/** The permissive policy the HTTP and byte-identity scenarios run under. */
const ALLOW_ALL_POLICY = { defaultDecision: 'allow', quarantine: { enabled: false } }

/** Registers the multi-tool stdio fixture and onboards one agent onto it. */
function onboardPolicyServer(tools?: string): Promise<string> {
  return runOnboarding(plane, {
    serverName: SERVER,
    agentName: AGENT,
    command: process.execPath,
    args: [POLICY_SERVER_FIXTURE],
    ...(tools !== undefined ? { tools } : {}),
  })
}

// ---------------------------------------------------------------------------
// Gate metric 1: onboarding is a short, scripted sequence of commands
// ---------------------------------------------------------------------------

describe('e2e: the documented onboarding scenario', () => {
  test('vault init → server add → vault set → agent create → agent grant → connect ends in a working call', async () => {
    const sessionId = 'e2e-onboarding'
    const token = await runOnboarding(plane, {
      serverName: SERVER,
      agentName: AGENT,
      command: process.execPath,
      args: [POLICY_SERVER_FIXTURE],
      env: { FIXTURE_TOKEN: `vault:${SECRET_NAME}` },
      secret: { name: SECRET_NAME, value: SECRET_MARKER },
      tools: 'echo,special_*',
    })

    const outcome = await runConnectLines({
      plane,
      token,
      sessionId,
      argv: ['connect', SERVER, '--agent', AGENT],
      lines: [
        requestLine(1, 'tools/list'),
        requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
        requestLine(3, 'tools/call', { name: 'risky_tool', arguments: {} }),
      ],
    })

    expect(outcome.code).toBe(0)
    // The agent sees exactly what it was granted: `risky_tool` is not in the
    // catalog it gets, and calling it anyway never reaches the server.
    const listed = outcome.messages[0]?.['result'] as { tools: Array<{ name: string }> }
    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'special_tool'])
    expect(outcome.messages[1]).not.toHaveProperty('error')
    expect(outcome.messages[2]).toHaveProperty('error')

    const decisions = decisionsOf(await readJournalRecords(tempDir, sessionId))
    // Every decision is journaled against the REGISTRY name, never `auto:<hash>`.
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions.every((record) => record.decision?.serverName === SERVER)).toBe(true)
    expect(
      decisions.some(
        (record) => record.decision?.toolName === 'echo' && record.decision.outcome === 'allow',
      ),
    ).toBe(true)
    expect(
      decisions.find((record) => record.decision?.toolName === 'risky_tool')?.decision,
    ).toMatchObject({ outcome: 'deny', rule: `agent: no grant for ${SERVER}/risky_tool` })
  })
})

// ---------------------------------------------------------------------------
// Gate metric 2: keys live only in the vault
// ---------------------------------------------------------------------------

describe('e2e: gate metric — server keys exist only inside the vault', () => {
  test('the marker reaches the child environment and no plane file or CLI stream ever holds it', async () => {
    const sessionId = 'e2e-vault-marker'
    const token = await runOnboarding(plane, {
      serverName: SERVER,
      agentName: AGENT,
      command: process.execPath,
      args: [ENV_ECHO_FIXTURE],
      env: { FIXTURE_TOKEN: `vault:${SECRET_NAME}` },
      secret: { name: SECRET_NAME, value: SECRET_MARKER },
    })

    // The fixture prints its whole environment as one line and exits.
    const outcome = await runConnectLines({
      plane,
      token,
      sessionId,
      argv: ['connect', SERVER, '--agent', AGENT],
      lines: [],
      expectedResponses: 1,
    })

    const childEnv = outcome.messages[0] as unknown as Record<string, string>
    expect(childEnv['FIXTURE_TOKEN']).toBe(SECRET_MARKER)
    // The plane's own secret-bearing variables stay on its side of the spawn.
    expect(childEnv['MCP_AGENT_TOKEN']).toBeUndefined()

    const read = (name: string): Promise<string> => readFile(join(tempDir, name), 'utf8')
    const vaultFile = await read('vault.enc')
    // Present, and unreadable: the vault holds the secret as ciphertext only.
    expect(vaultFile.length).toBeGreaterThan(0)
    expect(vaultFile).not.toContain(SECRET_MARKER)
    // The child's env dump did reach the journal — with the value redacted,
    // which is the only reason the marker is absent from it. Swept across
    // every persisted rendering: a committed record may still live only in
    // journal.db's -wal sidecar until a checkpoint runs.
    const journalBytes = await persistedBytes()
    expect(journalBytes.some((rendering) => rendering.includes('FIXTURE_TOKEN'))).toBe(true)
    expect(journalBytes.some((rendering) => rendering.includes('[REDACTED]'))).toBe(true)

    // Now every byte on disk, stores included. The registry's vault REFERENCE
    // and the agents document's `tokenHash` are asserted PRESENT first, so
    // this sweep can never pass by looking at bytes that do not hold the
    // stores at all.
    const persisted = await persistedBytes()
    expect(persisted.some((rendering) => rendering.includes(`vault:${SECRET_NAME}`))).toBe(true)
    expect(persisted.some((rendering) => rendering.includes('tokenHash'))).toBe(true)
    for (const rendering of persisted) {
      expect(rendering).not.toContain(SECRET_MARKER)
    }
    // Every command this plane ran, stdout and stderr both.
    expect(plane.allOut()).not.toContain(SECRET_MARKER)
    expect(plane.allErr()).not.toContain(SECRET_MARKER)
  })

  test('an agent token is not recoverable from the store that authenticates it', async () => {
    const token = await onboardPolicyServer()

    const persisted = await persistedBytes()

    expect(token.length).toBeGreaterThan(0)
    // The hash IS on disk — it is what authenticates — which proves the sweep
    // is reading the agents document and not empty bytes...
    expect(persisted.some((rendering) => rendering.includes('tokenHash'))).toBe(true)
    // ...and the plaintext token survives in none of it, in either rendering.
    for (const rendering of persisted) {
      expect(rendering).not.toContain(token)
    }
    // `agent list` renders the store, so it cannot leak what the store lacks.
    const listed = await plane.run(['agent', 'list'])
    expect(listed.out).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// Gate metric 3: revocation is one action
// ---------------------------------------------------------------------------

describe('e2e: gate metric — revoking an agent is a single command', () => {
  test('`agent revoke` ends the live session and the next connect is refused', async () => {
    const sessionId = 'e2e-revoke'
    const token = await onboardPolicyServer()

    const live = startConnect({
      plane,
      token,
      sessionId,
      argv: ['connect', SERVER, '--agent', AGENT],
    })
    live.stdio.clientOutbox.write(requestLine(1, 'tools/call', { name: 'echo', arguments: {} }))
    await waitUntil(() => live.stdio.lineCount() >= 1)

    const revoke = await plane.run(['agent', 'revoke', AGENT])
    expect(revoke.code).toBe(0)

    // Nobody closed the client's pipe: the session ends because the plane
    // polled `agents.json` and saw the revocation.
    const ended = await live.done
    expect(ended.code).not.toBe(0)
    expect(ended.err).toContain('revoked')
    const records = await readJournalRecords(tempDir, sessionId)
    expect(records.some((record) => record.decision?.rule === 'agent-revoked')).toBe(true)
    // No answer arrived after the revocation.
    expect(live.stdio.messages()).toHaveLength(1)

    const retry = await runConnectLines({
      plane,
      token,
      sessionId: `${sessionId}-retry`,
      argv: ['connect', SERVER, '--agent', AGENT],
      lines: [],
    })
    expect(retry.code).not.toBe(0)
    expect(retry.err).toContain('authentication failed')
  })
})

// ---------------------------------------------------------------------------
// Both HTTP session models, driven through `serve`
// ---------------------------------------------------------------------------

describe('e2e: both HTTP session models reach the journal through `serve`', () => {
  test('a sessionful HTTP agent over a stdio server: initialize, session id, call, decisions', async () => {
    const token = await onboardPolicyServer()
    const policyPath = await writePolicyFile(plane, ALLOW_ALL_POLICY)
    const serve = await startServe(plane, ['--policy', policyPath])
    const url = serve.endpoint(AGENT, SERVER)

    const init = await postMcp({ url, token, body: rpcBody(1, 'initialize') })
    expect(init.status).toBe(200)
    const sessionId = init.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()

    const call = await postMcp({
      url,
      token,
      body: rpcBody(2, 'tools/call', { name: 'echo', arguments: {} }),
      headers: { 'mcp-session-id': sessionId ?? '' },
    })
    expect(call.status).toBe(200)
    expect(await call.json()).toMatchObject({ id: 2, result: {} })

    expect((await serve.shutdown()).code).toBe(0)
    const decisions = decisionsOf(await readJournal(tempDir))
    expect(
      decisions.some(
        (record) =>
          record.decision?.toolName === 'echo' &&
          record.decision.outcome === 'allow' &&
          record.decision.serverName === SERVER,
      ),
    ).toBe(true)
  })

  test('a stateless HTTP agent over a stateless HTTP server: mirrored headers, call, decisions', async () => {
    const fixture = await startHttpFixture(HTTP_STATELESS_FIXTURE)
    const added = await plane.run([
      'server', 'add', HTTP_SERVER,
      '--transport', 'http',
      '--url', fixture.url,
      '--protocol', 'stateless',
    ])
    expect(added.code).toBe(0)
    const token = await createGrantedAgent(plane, AGENT, HTTP_SERVER)
    const policyPath = await writePolicyFile(plane, ALLOW_ALL_POLICY)
    const serve = await startServe(plane, ['--policy', policyPath])

    const response = await postMcp({
      url: serve.endpoint(AGENT, HTTP_SERVER),
      token,
      body: rpcBody(7, 'tools/call', { name: 'echo', arguments: {} }),
      headers: { 'mcp-method': 'tools/call', 'mcp-name': 'echo' },
    })

    expect(response.status).toBe(200)
    // The fixture answers -32020 unless the plane mirrored Mcp-Method upstream.
    expect(await response.json()).toMatchObject({ id: 7, result: { echo: 'tools/call' } })

    expect((await serve.shutdown()).code).toBe(0)
    const decisions = decisionsOf(await readJournal(tempDir))
    expect(
      decisions.some(
        (record) =>
          record.decision?.toolName === 'echo' && record.decision.serverName === HTTP_SERVER,
      ),
    ).toBe(true)
    fixture.stop()
  })
})

// ---------------------------------------------------------------------------
// M2's policy chain on top of M3's grants
// ---------------------------------------------------------------------------

describe('e2e: the M2 policy chain applies on top of agent grants', () => {
  test('a deny rule outranks the grant that made the tool visible', async () => {
    const sessionId = 'e2e-deny-over-grant'
    const token = await onboardPolicyServer('echo')
    // Into the plane's own directory — `connect` takes its policy from there
    // and nowhere else (`--policy` is refused: the agent launches the command).
    await writePolicyFile(plane, {
      ...ALLOW_ALL_POLICY,
      servers: { [SERVER]: { tools: { echo: 'deny' } } },
    })

    const outcome = await runConnectLines({
      plane,
      token,
      sessionId,
      argv: ['connect', SERVER, '--agent', AGENT],
      lines: [
        requestLine(1, 'tools/list'),
        requestLine(2, 'tools/call', { name: 'echo', arguments: {} }),
      ],
    })

    // Granted, therefore visible to the grant filter — and then removed again
    // by the policy's own hide-denied filtering.
    const listed = outcome.messages[0]?.['result'] as { tools: Array<{ name: string }> }
    expect(listed.tools).toEqual([])
    expect(outcome.messages[1]).toHaveProperty('error')

    const deny = decisionsOf(await readJournalRecords(tempDir, sessionId)).find(
      (record) => record.decision?.toolName === 'echo',
    )
    expect(deny?.decision).toMatchObject({
      outcome: 'deny',
      rule: `servers.${SERVER}.tools.echo`,
    })
  })

  test('a require-approval class sends a granted write tool to the approvals queue', async () => {
    const sessionId = 'e2e-approval-over-grant'
    const token = await onboardPolicyServer()
    await writePolicyFile(plane, {
      ...ALLOW_ALL_POLICY,
      classDefaults: { write: 'require-approval' },
      approval: { timeoutMs: 20_000 },
    })

    const live = startConnect({
      plane,
      token,
      sessionId,
      argv: ['connect', SERVER, '--agent', AGENT],
    })
    // The catalog first, so `risky_tool` is a known tool of a known class.
    live.stdio.clientOutbox.write(requestLine(1, 'tools/list'))
    await waitUntil(() => live.stdio.lineCount() >= 1)
    live.stdio.clientOutbox.write(
      requestLine(2, 'tools/call', { name: 'risky_tool', arguments: { marker: 'e2e' } }),
    )

    let approvalId = ''
    await waitUntilAsync(async () => {
      const listed = await plane.run(['approvals', 'list', '--json'])
      // `approvals list --json` emits one unconditional envelope, so a poller
      // never has to branch on whether the read happened to be truncated.
      const trimmed = listed.out.trim()
      const pending =
        trimmed === ''
          ? []
          : (JSON.parse(trimmed) as { approvals: Array<Record<string, unknown>> }).approvals
      approvalId = (pending[0]?.['approvalId'] as string | undefined) ?? ''
      return approvalId !== ''
    })

    // The resolution must name a human, so the operator onboards themselves
    // first (M5 wave 2): `approvals approve` from the shell needs a personal
    // admin token and records `actor: cli:<adminName>`.
    const approver = await createCliApprover(plane, 'e2e-operator')
    const approved = await plane.run(['approvals', 'approve', approvalId], approver)
    expect(approved.code).toBe(0)
    await waitUntil(() => live.stdio.lineCount() >= 2)
    live.stdio.clientOutbox.end()
    await live.done

    // The call the operator approved was forwarded and answered normally.
    const answer = live.stdio.messages().find((message) => message['id'] === 2)
    expect(answer).not.toHaveProperty('error')
    const outcomes = decisionsOf(await readJournalRecords(tempDir, sessionId)).map(
      (record) => record.decision?.outcome,
    )
    expect(outcomes).toEqual(expect.arrayContaining(['require-approval-pending', 'approved']))
  })
})

// ---------------------------------------------------------------------------
// Byte identity of an untouched stdio session
// ---------------------------------------------------------------------------

describe('e2e: a connect session nothing gated is byte-identical to a plain relay', () => {
  test('connect delivers exactly what ad-hoc `wrap` delivers, odd framing included', async () => {
    const token = await onboardPolicyServer()

    // No `tools/list`: its response is the one message the plane resolves
    // asynchronously (the inventory observe), so a response queued behind it
    // may legitimately overtake it (see tests/proxy/policy-integration.test.ts).
    const lines = [
      `${requestJson(1, 'initialize')}\r\n`,
      '\n',
      `${requestJson(2, 'tools/call', { name: 'echo', arguments: { t: 1 } })}\n`,
      '\r\n',
      `${requestJson(3, 'tools/call', { name: 'echo', arguments: { t: 2 } })}\r\n`,
      '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"echo","argume',
    ]

    const baseline = await runWrapBaseline({
      plane,
      sessionId: 'e2e-identity-wrap',
      command: process.execPath,
      args: [POLICY_SERVER_FIXTURE],
      lines,
      expectedResponses: 3,
    })

    const connected = await runConnectLines({
      plane,
      token,
      sessionId: 'e2e-identity-connect',
      argv: ['connect', SERVER, '--agent', AGENT],
      lines,
      expectedResponses: 3,
    })

    expect(connected.code).toBe(0)
    expect(connected.stdio.stdoutText()).toBe(baseline.stdoutText())
  })
})
