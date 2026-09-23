import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { EXIT_CODE_BRIDGE_LOST } from '../../src/bridge/constants.js'
import { createConnectStdio, type ConnectStdio } from '../cli/connect-harness.js'
import { readJournalRecords, requestLine, waitUntil } from '../proxy/harness.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import {
  asOwner,
  createPlane,
  decisionsOf,
  POLICY_SERVER_FIXTURE,
  runOnboarding,
  startServe,
  writePolicyFile,
  type CliRun,
  type Plane,
} from './m3-harness.js'

/**
 * `connect --url` end to end (plan task 7): a REAL `serve` front on one side,
 * the bridge on the other, and between them the client stdio an agent's own
 * process would give it.
 *
 * The claim under test is PRD phase 2's success signal: a machine with no
 * install reaches a registered server through a remote service and calls a
 * tool on it. So the bridge's seams carry **no `journalDir` at all** — not a
 * temp one, none — and its environment holds nothing but the agent token.
 * Everything the plane knows is on the other end of the HTTP front.
 */

const SERVER = 'policy-fixture'
const AGENT = 'bridge-agent'

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-bridge-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Registers the stdio fixture, onboards one agent, and allows every tool. */
async function onboard(tools?: string): Promise<string> {
  await writePolicyFile(plane, { defaultDecision: 'allow', quarantine: { enabled: false } })
  return runOnboarding(plane, {
    serverName: SERVER,
    agentName: AGENT,
    command: process.execPath,
    args: [POLICY_SERVER_FIXTURE],
    ...(tools !== undefined ? { tools } : {}),
  })
}

interface BridgeDriver {
  readonly stdio: ConnectStdio
  readonly done: Promise<CliRun>
}

/**
 * Starts the bridge through `dispatch()` — the same route the `mcpcut` binary
 * takes — against an injected stdio pair.
 */
function startBridge(url: string, token: string): BridgeDriver {
  const stdio = createConnectStdio()
  const done = plane.run(['connect', '--url', url], {
    connectBridge: {
      // The assertion this whole file exists for: no data directory, no
      // config, nothing but the token.
      env: { MCP_AGENT_TOKEN: token },
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      clientOptions: { sseReconnectMaxAttempts: 1, delay: () => Promise.resolve() },
    },
  })
  return { stdio, done }
}

/** Writes each line only once the previous one has been answered, then hangs up. */
async function runLines(
  driver: BridgeDriver,
  lines: readonly string[],
): Promise<CliRun & { messages: Array<Record<string, unknown>> }> {
  for (const [index, line] of lines.entries()) {
    driver.stdio.clientOutbox.write(line)
    await waitUntil(() => driver.stdio.lineCount() >= index + 1)
  }
  driver.stdio.clientOutbox.end()
  const run = await driver.done
  return { ...run, messages: driver.stdio.messages() }
}

describe('e2e: a machine with no install reaches a server through a remote service', () => {
  test('initialize → tools/list → tools/call, then a clean hang-up', async () => {
    const token = await onboard('echo,special_*')
    const serve = await startServe(plane)

    try {
      const driver = startBridge(serve.endpoint(AGENT, SERVER), token)
      const outcome = await runLines(driver, [
        requestLine(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
        }),
        requestLine(2, 'tools/list'),
        requestLine(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
      ])

      expect(outcome.code).toBe(0)
      expect(outcome.messages).toHaveLength(3)
      expect(outcome.messages[0]).toHaveProperty('result')
      // The grants the SERVICE holds are what shapes the catalog; the bridge
      // filtered nothing and knows nothing about them.
      const listed = outcome.messages[1]?.['result'] as { tools: Array<{ name: string }> }
      expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'special_tool'])
      expect(outcome.messages[2]).not.toHaveProperty('error')
    } finally {
      await serve.shutdown()
    }
  })

  test('the service journaled the call, and the agent token is nowhere on its disk', async () => {
    const token = await onboard()
    const serve = await startServe(plane)

    try {
      const driver = startBridge(serve.endpoint(AGENT, SERVER), token)
      await runLines(driver, [
        requestLine(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
        }),
        requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
      ])
    } finally {
      await serve.shutdown()
    }

    // The bridge journals nothing — the SERVICE does, and it knows who called.
    const sessions = await readJournalRecords(tempDir)
    const decisions = decisionsOf(sessions)
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions.every((record) => record.decision?.agentName === AGENT)).toBe(true)

    const renderings = (await collectPersistedBytes(tempDir)).renderings
    for (const rendering of renderings) expect(rendering).not.toContain(token)
  })

  test('a policy that denies the tool reaches the agent through the bridge unchanged', async () => {
    const token = await onboard()
    await writePolicyFile(plane, {
      defaultDecision: 'allow',
      quarantine: { enabled: false },
      servers: { [SERVER]: { tools: { echo: 'deny' } } },
    })
    const serve = await startServe(plane)

    try {
      const driver = startBridge(serve.endpoint(AGENT, SERVER), token)
      const outcome = await runLines(driver, [
        requestLine(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
        }),
        requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
      ])

      expect(outcome.code).toBe(0)
      expect(outcome.messages[1]).toHaveProperty('error')
    } finally {
      await serve.shutdown()
    }
  })
})

describe('e2e: what the bridge does when the service says no', () => {
  test("another agent's token gets one refusal and an empty protocol channel", async () => {
    const token = await onboard()
    const serve = await startServe(plane)

    try {
      const driver = startBridge(serve.endpoint(AGENT, SERVER), `${token}-not-really`)
      driver.stdio.clientOutbox.write(requestLine(1, 'tools/list'))
      const run = await driver.done

      expect(run.code).toBe(1)
      expect(run.err).toContain('did not accept the agent token')
      expect(driver.stdio.stdoutText()).toBe('')
    } finally {
      await serve.shutdown()
    }
  })

  test('a pool address now reaches the pool this service serves (phase 3)', async () => {
    // This test used to assert the opposite: until phase 3 the base address
    // honestly answered 404 and the bridge said so. The pool endpoint exists
    // now, so the same invocation gets a live session — and the bridge needed
    // no change at all to get it, which is the point of PE5's "the path is an
    // internal detail".
    const token = await onboard('echo,special_*')
    const serve = await startServe(plane)

    try {
      const driver = startBridge(`http://127.0.0.1:${serve.port}`, token)
      const outcome = await runLines(driver, [
        requestLine(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
        }),
        requestLine(2, 'tools/list'),
      ])

      expect(outcome.code).toBe(0)
      const handshake = outcome.messages[0]?.['result'] as { serverInfo: { name: string } }
      // The plane answered for itself: at a pool address it IS the server.
      expect(handshake.serverInfo.name).toBe('mcpcut')
      const listed = outcome.messages[1]?.['result'] as { tools: Array<{ name: string }> }
      // The stdio fixture this suite registers answers `initialize` with the
      // revision that has no handshake, so the pool's own handshake cannot
      // negotiate with it and opens without it (PE6). An empty catalog is the
      // honest result, not an error.
      expect(Array.isArray(listed.tools)).toBe(true)
    } finally {
      await serve.shutdown()
    }
  }, 30_000)

  test('the service going away mid-session ends the bridge with exit 4, not a hang', async () => {
    const token = await onboard()
    const serve = await startServe(plane)

    const driver = startBridge(serve.endpoint(AGENT, SERVER), token)
    driver.stdio.clientOutbox.write(
      requestLine(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
      }),
    )
    await waitUntil(() => driver.stdio.lineCount() >= 1)

    await serve.shutdown()
    const run = await driver.done

    // The front answered `initialize` with a session id, so the client holds
    // a server-initiated stream and a session. When the service goes away,
    // WHICH of the two notices first is a race — the stream exhausting its
    // reconnect budget, or the session turning out to be gone — and both are
    // true. What is not a race, and is the whole claim, is that the bridge
    // ends rather than hangs, with the exit code that tells an MCP client to
    // start a fresh bridge rather than to give up on the server the way exit
    // 1 would, and with a line saying so.
    // A merely TRANSIENT failure, where the stream survives, costs one
    // request instead: `tests/bridge/pump.test.ts` pins that deterministically.
    expect(run.code).toBe(EXIT_CODE_BRIDGE_LOST)
    expect(run.err).toContain('Reconnect the MCP server in your client')
    // Whatever went wrong, it did not end up on the protocol channel.
    expect(driver.stdio.messages().every((message) => message['jsonrpc'] === '2.0')).toBe(true)
  })

  test('revoking the agent mid-session ends the bridge rather than hanging it', async () => {
    const token = await onboard()
    const serve = await startServe(plane)
    const owner = await asOwner(plane)

    try {
      const driver = startBridge(serve.endpoint(AGENT, SERVER), token)
      driver.stdio.clientOutbox.write(
        requestLine(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-bridge', version: '0.0.1' },
        }),
      )
      await waitUntil(() => driver.stdio.lineCount() >= 1)

      await plane.run(['agent', 'revoke', AGENT], owner)

      driver.stdio.clientOutbox.write(requestLine(2, 'tools/list'))
      const run = await driver.done

      // Whatever the front chooses to answer, the bridge does not sit there:
      // it exits, and says which case it was.
      expect(run.code).not.toBe(0)
      expect(run.err.length).toBeGreaterThan(0)
    } finally {
      await serve.shutdown()
    }
  })
})
