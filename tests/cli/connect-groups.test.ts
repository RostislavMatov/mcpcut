import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { runConnect, type ConnectDeps } from '../../src/cli/connect-cmd.js'
import { GROUPS_FILE_NAME } from '../../src/groups/constants.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { requestLine, waitUntil } from '../proxy/harness.js'
import {
  POLICY_SERVER_FIXTURE,
  addServerRecord,
  createCliCapture,
  createConnectStdio,
  stopAllHttpFixtures,
  type CliCapture,
  type ConnectStdio,
} from './connect-harness.js'

/**
 * `connect` admitting an agent whose ONLY path to the server is a group
 * membership (M5.5 п.2, decisions G2/G5).
 *
 * The whole command runs against real stores in a temp directory: the point
 * of the wave is that `connect-cmd.ts` reads agents through the
 * effective-agent reader, and only an end-to-end run proves the reader is
 * actually installed there — the two pre-traffic `Object.hasOwn(agent.grants,
 * …)` checks in `connect-resolve.ts` were deliberately left untouched.
 */

const AGENT = 'research-bot'
const SERVER = 'fixture'
const GROUP = 'analytics'
const SESSION_ID = 'connect-groups-session'

let tempDir: string
let io: CliCapture
let stdio: ConnectStdio

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-connect-groups-'))
  io = createCliCapture()
  stdio = createConnectStdio()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  stopAllHttpFixtures()
})

function depsOf(overrides: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    journalDir: tempDir,
    env: {},
    cwd: tempDir,
    stdin: stdio.clientOutbox,
    stdout: stdio.clientStdout,
    stderr: stdio.clientStderr,
    sessionId: SESSION_ID,
    revocationPollIntervalMs: 25,
    childExitGraceMs: 1000,
    killEscalationMs: 500,
    ...overrides,
  }
}

/** An agent with NO personal grant, holding `SERVER` only through `GROUP`. */
async function seedGroupOnlyAgent(tools: readonly string[] | '*'): Promise<string> {
  const agents = createAgentsStore({ journalDir: tempDir })
  const groups = createGroupsStore({ journalDir: tempDir })
  const created = await agents.createAgent(AGENT)
  await groups.createGroup(GROUP)
  await groups.grantServer(GROUP, SERVER, tools)
  await groups.addMember(GROUP, AGENT)
  return created.token
}

async function addPolicyServer(): Promise<void> {
  await addServerRecord(tempDir, {
    name: SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [POLICY_SERVER_FIXTURE],
  })
}

/** Drives one full session: send each line, wait for its answer, then close the client. */
async function runLines(token: string, lines: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const runPromise = runConnect(
    [SERVER, '--agent', AGENT],
    io,
    depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
  )
  for (const [index, line] of lines.entries()) {
    stdio.clientOutbox.write(line)
    await waitUntil(() => stdio.lineCount() >= index + 1)
  }
  stdio.clientOutbox.end()
  expect(await runPromise).toBe(0)
  return stdio.messages()
}

describe('connect: grants inherited from a group', () => {
  test('an agent granted only through a group is admitted and its tools work', async () => {
    // Arrange
    await addPolicyServer()
    const token = await seedGroupOnlyAgent(['echo'])

    // Act
    const messages = await runLines(token, [
      requestLine(1, 'tools/list'),
      requestLine(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
    ])

    // Assert
    const tools = (messages[0]?.['result'] as { tools: Array<{ name: string }> }).tools
    expect(tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(messages[1]).not.toHaveProperty('error')
  })

  test('the group grant is a grant, not a bypass: a tool outside it is still denied', async () => {
    // Arrange
    await addPolicyServer()
    const token = await seedGroupOnlyAgent(['echo'])

    // Act
    const messages = await runLines(token, [
      requestLine(1, 'tools/call', { name: 'risky_tool', arguments: {} }),
    ])

    // Assert
    const denied = messages[0] as { error?: { data?: { rule?: string } } }
    expect(denied.error?.data?.rule).toBe(`agent: no grant for ${SERVER}/risky_tool`)
  })

  test('a non-member of the granting group is refused exactly as before', async () => {
    // Arrange — the group grants the server, this agent is simply not in it
    await addPolicyServer()
    const agents = createAgentsStore({ journalDir: tempDir })
    const groups = createGroupsStore({ journalDir: tempDir })
    const created = await agents.createAgent(AGENT)
    await groups.createGroup(GROUP)
    await groups.grantServer(GROUP, SERVER, '*')
    await groups.addMember(GROUP, 'someone-else')

    // Act
    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: created.token } }),
    )

    // Assert — the unchanged `no-grant` refusal, and nothing was spawned
    expect(exitCode).toBe(1)
    expect(io.err()).toContain(`agent "${AGENT}" has no grant for server "${SERVER}"`)
    expect(stdio.stdoutText()).toBe('')
  })
})

describe('connect — an unreadable group store', () => {
  test('refuses naming BOTH stores, since either one can be the failure', async () => {
    // Arrange — a groups document that cannot be parsed; the agent itself is
    // perfectly readable, so a message blaming only the agent store would
    // send the operator to the wrong file.
    const agents = createAgentsStore({ journalDir: tempDir })
    const created = await agents.createAgent(AGENT)
    await agents.grantServer(AGENT, SERVER, '*')
    await addPolicyServer()
    await writeFile(join(tempDir, GROUPS_FILE_NAME), '{ not json', 'utf8')

    // Act
    const code = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: created.token, PATH: process.env['PATH'] ?? '' } }),
    )

    // Assert
    expect(code).toBe(1)
    expect(io.err()).toContain('cannot read the agent or group store')
  })
})
