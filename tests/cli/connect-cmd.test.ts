import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { runConnect, type ConnectDeps } from '../../src/cli/connect-cmd.js'
import { formatVaultFailure } from '../../src/cli/connect-upstream.js'
import { journalDbPathFor } from '../../src/journal/db.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { EXIT_CODE_JOURNAL_FAILURE } from '../../src/proxy/wrap.js'
import { readJournalRecords, requestLine, waitUntil } from '../proxy/harness.js'
import { writeCorruptDatabase } from '../support/corrupt-db.js'
import {
  ENV_ECHO_FIXTURE,
  HTTP_SESSIONFUL_FIXTURE,
  POLICY_SERVER_FIXTURE,
  addServerRecord,
  createCliCapture,
  createConnectStdio,
  createGrantedAgent,
  seedVault,
  startHttpFixture,
  stopAllHttpFixtures,
  type CliCapture,
  type ConnectStdio,
} from './connect-harness.js'

/**
 * `mcp-journal connect` (M3 Task 12). Two properties carry most of this file:
 *
 *  1. **Nothing happens before authentication.** Every refusal test asserts
 *     not just the exit code and message, but that no journal file was
 *     created and not one byte reached the protocol channel — i.e. no server
 *     was spawned and no upstream request was made.
 *  2. **The agent only ever sees what it was granted**, with the vault secret
 *     reaching the server and nothing else.
 */

const AGENT = 'research-bot'
const SERVER = 'fixture'
const SESSION_ID = 'connect-test-session'
const VAULT_SECRET_NAME = 'fixture-secret'
const VAULT_MARKER = 'vault-marker-9f2c41e7'

let tempDir: string
let io: CliCapture
let stdio: ConnectStdio

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-connect-'))
  io = createCliCapture()
  stdio = createConnectStdio()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  stopAllHttpFixtures()
})

/**
 * Deps every run shares: temp state and injected stdio. Policy discovery is
 * NOT configurable here on purpose — `connect` resolves it from `journalDir`
 * alone (see the "policy source" describe block); `cwd` points at the temp
 * directory so no policy file of the repo's own can influence a run.
 */
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

/** Writes the operator-zone policy: `<journalDir>/policy.json`. */
async function writeJournalPolicy(document: Record<string, unknown>): Promise<string> {
  const path = join(tempDir, 'policy.json')
  await writeFile(path, JSON.stringify(document), 'utf8')
  return path
}

/** A policy that denies `echo` on the fixture server — visible in one call. */
const DENY_ECHO_POLICY = {
  version: 1,
  quarantine: { enabled: false },
  defaultDecision: 'allow',
  servers: { [SERVER]: { tools: { echo: 'deny' } } },
} as const

/** A policy that allows everything, used as the bait an agent-controlled source would supply. */
const ALLOW_ALL_POLICY = {
  version: 1,
  quarantine: { enabled: false },
  defaultDecision: 'allow',
} as const

/** `journal.db`'s path: existence is the "did this run ever journal anything" mechanism check. */
function journalPath(): string {
  return journalDbPathFor(tempDir)
}

/** Registers the multi-tool stdio fixture under `SERVER`. */
async function addPolicyServer(env?: Record<string, string>): Promise<void> {
  await addServerRecord(tempDir, {
    name: SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [POLICY_SERVER_FIXTURE],
    ...(env !== undefined ? { env } : {}),
  })
}

interface RunOutcome {
  readonly exitCode: number
  readonly messages: Array<Record<string, unknown>>
  readonly records: JournalRecord[]
}

/** Drives one full session: send each line, wait for its answer, then close the client. */
async function runLines(args: {
  readonly token: string
  readonly lines: readonly string[]
  readonly deps?: Partial<ConnectDeps>
  readonly argv?: readonly string[]
}): Promise<RunOutcome> {
  const deps = depsOf({
    env: { MCP_AGENT_TOKEN: args.token, PATH: process.env['PATH'] ?? '' },
    ...args.deps,
  })
  const runPromise = runConnect(args.argv ?? [SERVER, '--agent', AGENT], io, deps)

  for (const [index, line] of args.lines.entries()) {
    stdio.clientOutbox.write(line)
    await waitUntil(() => stdio.lineCount() >= index + 1)
  }
  stdio.clientOutbox.end()
  const exitCode = await runPromise

  return {
    exitCode,
    messages: stdio.messages(),
    records: existsSync(journalPath()) ? await readJournalRecords(tempDir, SESSION_ID) : [],
  }
}

// ---------------------------------------------------------------------------
// Refusals — every one of them before any upstream traffic
// ---------------------------------------------------------------------------

describe('connect: argument handling', () => {
  test('a missing --agent prints usage and refuses', async () => {
    const exitCode = await runConnect([SERVER], io, depsOf())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage:')
    expect(stdio.stdoutText()).toBe('')
  })

  test('a missing server positional prints usage and refuses', async () => {
    const exitCode = await runConnect(['--agent', AGENT], io, depsOf())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage:')
  })
})

describe('connect: startup integrity preflight', () => {
  test('a damaged state.db refuses the run before the token is even looked at', async () => {
    await writeCorruptDatabase(join(tempDir, 'state.db'))

    const exitCode = await runConnect([SERVER, '--agent', AGENT], io, depsOf({ env: {} }))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('state.db failed PRAGMA integrity_check')
    expect(io.err()).toContain('Refusing to start.')
    // The refusal that WOULD have come next: its absence proves the preflight
    // runs ahead of authentication, and so ahead of any spawn.
    expect(io.err()).not.toContain('MCP_AGENT_TOKEN')
    expect(stdio.stdoutText()).toBe('')
  })
})

describe('connect: authentication happens before any traffic', () => {
  test('refuses when MCP_AGENT_TOKEN is unset, without spawning anything', async () => {
    await addPolicyServer()
    await createGrantedAgent({ journalDir: tempDir, agentName: AGENT, serverName: SERVER, tools: '*' })

    const exitCode = await runConnect([SERVER, '--agent', AGENT], io, depsOf({ env: {} }))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('MCP_AGENT_TOKEN is not set')
    expect(stdio.stdoutText()).toBe('')
    expect(existsSync(journalPath())).toBe(false)
  })

  test('an unknown token, a revoked token and another agent\'s token are indistinguishable', async () => {
    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })
    const otherToken = await createGrantedAgent({
      journalDir: tempDir,
      agentName: 'other-bot',
      serverName: SERVER,
      tools: '*',
    })

    const unknown = createCliCapture()
    expect(
      await runConnect([SERVER, '--agent', AGENT], unknown, depsOf({ env: { MCP_AGENT_TOKEN: 'nope' } })),
    ).toBe(1)

    // A valid token that belongs to a different agent than --agent names.
    const wrongOwner = createCliCapture()
    expect(
      await runConnect(
        [SERVER, '--agent', AGENT],
        wrongOwner,
        depsOf({ env: { MCP_AGENT_TOKEN: otherToken } }),
      ),
    ).toBe(1)

    await createAgentsStore({ journalDir: tempDir }).revokeAgent(AGENT)
    const revoked = createCliCapture()
    expect(
      await runConnect([SERVER, '--agent', AGENT], revoked, depsOf({ env: { MCP_AGENT_TOKEN: token } })),
    ).toBe(1)

    expect(unknown.err()).toContain('authentication failed')
    expect(wrongOwner.err()).toBe(unknown.err())
    expect(revoked.err()).toBe(unknown.err())
    expect(existsSync(journalPath())).toBe(false)
    expect(stdio.stdoutText()).toBe('')
  })

  test('an authenticated agent without a grant for the server is refused', async () => {
    await addPolicyServer()
    const store = createAgentsStore({ journalDir: tempDir })
    const created = await store.createAgent(AGENT)
    await store.grantServer(AGENT, 'other-server', '*')

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: created.token } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(`agent "${AGENT}" has no grant for server "${SERVER}"`)
    expect(existsSync(journalPath())).toBe(false)
  })

  test('a granted-but-unregistered server reports only servers the agent already holds', async () => {
    await addServerRecord(tempDir, {
      name: 'registered-elsewhere',
      transport: 'stdio',
      command: process.execPath,
      args: [POLICY_SERVER_FIXTURE],
    })
    await addServerRecord(tempDir, {
      name: 'granted-and-registered',
      transport: 'stdio',
      command: process.execPath,
      args: [POLICY_SERVER_FIXTURE],
    })
    const store = createAgentsStore({ journalDir: tempDir })
    const created = await store.createAgent(AGENT)
    await store.grantServer(AGENT, SERVER, '*')
    await store.grantServer(AGENT, 'granted-and-registered', '*')

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: created.token } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(`unknown server "${SERVER}"`)
    expect(io.err()).toContain('granted-and-registered')
    // The registry is never enumerated: a server this agent has no grant for
    // must not appear in the hint.
    expect(io.err()).not.toContain('registered-elsewhere')
  })

  test('an unreadable store refuses instead of connecting', async () => {
    const broken = { message: 'agents.json is corrupt' }

    const agentsFailed = createCliCapture()
    expect(
      await runConnect(
        [SERVER, '--agent', AGENT],
        agentsFailed,
        depsOf({
          env: { MCP_AGENT_TOKEN: 'whatever' },
          agentsStore: {
            findAgentByToken: () => Promise.reject(new Error(broken.message)),
            getAgent: () => Promise.resolve(undefined),
          },
        }),
      ),
    ).toBe(1)
    expect(agentsFailed.err()).toContain(broken.message)

    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })
    const registryFailed = createCliCapture()
    expect(
      await runConnect(
        [SERVER, '--agent', AGENT],
        registryFailed,
        depsOf({
          env: { MCP_AGENT_TOKEN: token },
          registryStore: {
            getServer: () => Promise.reject(new Error('registry.json is corrupt')),
            listServers: () => Promise.resolve([]),
          },
        }),
      ),
    ).toBe(1)
    expect(registryFailed.err()).toContain('registry.json is corrupt')
    expect(existsSync(journalPath())).toBe(false)
  })

  test('every missing vault secret is reported at once, before the server is spawned', async () => {
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [ENV_ECHO_FIXTURE],
      env: { FIRST_TOKEN: 'vault:absent-one', SECOND_TOKEN: 'vault:absent-two' },
    })
    await seedVault(tempDir, VAULT_SECRET_NAME, VAULT_MARKER)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('absent-one')
    expect(io.err()).toContain('absent-two')
    expect(stdio.stdoutText()).toBe('')
    expect(existsSync(journalPath())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// stdio upstream
// ---------------------------------------------------------------------------

describe('connect: stdio upstream', () => {
  test('the child gets the allowlist slice plus its own env, and no plane variable', async () => {
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [ENV_ECHO_FIXTURE],
      env: { FIXTURE_TOKEN: `vault:${VAULT_SECRET_NAME}`, FIXTURE_PLAIN: 'plain-value' },
    })
    await seedVault(tempDir, VAULT_SECRET_NAME, VAULT_MARKER)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const runPromise = runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({
        env: {
          MCP_AGENT_TOKEN: token,
          PATH: process.env['PATH'] ?? '',
          MCP_PLANE_ONLY: 'must-not-cross',
        },
      }),
    )
    // The fixture prints its whole environment as one line and exits.
    await waitUntil(() => stdio.lineCount() >= 1)
    stdio.clientOutbox.end()
    await runPromise

    const childEnv = stdio.messages()[0] as Record<string, string>
    expect(childEnv['FIXTURE_TOKEN']).toBe(VAULT_MARKER)
    expect(childEnv['FIXTURE_PLAIN']).toBe('plain-value')
    expect(childEnv['PATH']).toBe(process.env['PATH'] ?? '')
    expect(childEnv['MCP_PLANE_ONLY']).toBeUndefined()
    expect(childEnv['MCP_AGENT_TOKEN']).toBeUndefined()
    // The plane never writes the secret itself.
    expect(io.err()).not.toContain(VAULT_MARKER)
    expect(stdio.stderrText()).not.toContain(VAULT_MARKER)
  })

  test('tools/list shows only granted tools and a non-granted call never reaches the server', async () => {
    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: ['echo'],
    })

    const outcome = await runLines({
      token,
      lines: [
        requestLine(1, 'tools/list'),
        requestLine(2, 'tools/call', { name: 'risky_tool', arguments: {} }),
        requestLine(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }),
      ],
    })

    expect(outcome.exitCode).toBe(0)
    const tools = (outcome.messages[0]?.['result'] as { tools: Array<{ name: string }> }).tools
    expect(tools.map((tool) => tool.name)).toEqual(['echo'])

    const denied = outcome.messages[1] as { error?: { data?: { rule?: string } } }
    expect(denied.error?.data?.rule).toBe(`agent: no grant for ${SERVER}/risky_tool`)
    expect(outcome.messages[2]).not.toHaveProperty('error')

    // The denial is journaled against the REGISTRY name, not an auto: hash.
    const decisions = outcome.records.filter((record) => record.kind === 'decision')
    const denialRecord = decisions.find((record) => record.decision?.toolName === 'risky_tool')
    expect(denialRecord?.decision).toMatchObject({ outcome: 'deny', serverName: SERVER })
    expect(decisions.every((record) => !record.decision?.serverName.startsWith('auto:'))).toBe(true)
  })

  test('without a policy file the run is journaling-only and says so', async () => {
    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const outcome = await runLines({
      token,
      lines: [requestLine(1, 'tools/call', { name: 'echo', arguments: {} })],
    })

    expect(io.err()).toContain('policy: none found')
    expect(outcome.messages[0]).not.toHaveProperty('error')
  })

  test('the journal-directory policy applies on top of the grants', async () => {
    await addPolicyServer()
    const policyPath = await writeJournalPolicy(DENY_ECHO_POLICY)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const outcome = await runLines({
      token,
      lines: [requestLine(1, 'tools/call', { name: 'echo', arguments: {} })],
    })

    expect(io.err()).toContain(`policy: loaded from ${policyPath}`)
    expect(outcome.messages[0]).toHaveProperty('error')
  })

  test('a broken policy file stops the run instead of falling back to allow-all', async () => {
    await addPolicyServer()
    await writeFile(join(tempDir, 'policy.json'), '{ this is not json', 'utf8')
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('invalid JSON')
    expect(stdio.stdoutText()).toBe('')
    expect(existsSync(journalPath())).toBe(false)
  })

  test('a vault secret never appears in the journal, the diagnostics or the protocol channel', async () => {
    await addPolicyServer({ FIXTURE_TOKEN: `vault:${VAULT_SECRET_NAME}` })
    await seedVault(tempDir, VAULT_SECRET_NAME, VAULT_MARKER)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const outcome = await runLines({
      token,
      lines: [requestLine(1, 'tools/call', { name: 'echo', arguments: {} })],
    })

    expect(outcome.exitCode).toBe(0)
    expect(await readFile(journalPath(), 'utf8')).not.toContain(VAULT_MARKER)
    expect(stdio.stdoutText()).not.toContain(VAULT_MARKER)
    expect(stdio.stderrText()).not.toContain(VAULT_MARKER)
    expect(io.err()).not.toContain(VAULT_MARKER)
  })

  test('a server that cannot be spawned ends the run instead of hanging', async () => {
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'stdio',
      command: join(tempDir, 'no-such-binary'),
    })
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    expect(exitCode).not.toBe(0)
    expect(io.err()).toContain('Failed to spawn')
  })

  test('--fail-closed ends the session and reports code 3 when a record cannot be written', async () => {
    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const runPromise = runConnect(
      [SERVER, '--agent', AGENT, '--fail-closed'],
      io,
      depsOf({
        env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' },
        journalCommitBatchImpl: () => Promise.reject(new Error('disk is full')),
      }),
    )
    // The first journaled message is what trips the sink.
    stdio.clientOutbox.write(requestLine(1, 'tools/call', { name: 'echo', arguments: {} }))
    const exitCode = await runPromise

    expect(exitCode).toBe(EXIT_CODE_JOURNAL_FAILURE)
    expect(io.err()).toContain('fail-closed')
  })

  test('revoking the agent mid-session ends it and is journaled', async () => {
    await addPolicyServer()
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const runPromise = runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )
    stdio.clientOutbox.write(requestLine(1, 'tools/call', { name: 'echo', arguments: {} }))
    await waitUntil(() => stdio.lineCount() >= 1)

    await createAgentsStore({ journalDir: tempDir }).revokeAgent(AGENT)
    const exitCode = await runPromise

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('revoked')
    const records = await readJournalRecords(tempDir, SESSION_ID)
    expect(records.some((record) => record.decision?.rule === 'agent-revoked')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Policy source: operator-controlled only
// ---------------------------------------------------------------------------

describe('connect: the policy source is not agent-controlled', () => {
  /** Runs one `echo` call and reports whether policy blocked it. */
  async function echoWasDenied(args: {
    readonly token: string
    readonly deps?: Partial<ConnectDeps>
  }): Promise<boolean> {
    const outcome = await runLines({
      token: args.token,
      lines: [requestLine(1, 'tools/call', { name: 'echo', arguments: {} })],
      ...(args.deps !== undefined ? { deps: args.deps } : {}),
    })
    return Object.prototype.hasOwnProperty.call(outcome.messages[0] ?? {}, 'error')
  }

  test('--policy is refused outright, with the operator location in the message', async () => {
    await addPolicyServer()
    const bait = join(tempDir, 'agent-chosen-policy.json')
    await writeFile(bait, JSON.stringify(ALLOW_ALL_POLICY), 'utf8')
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT, '--policy', bait],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('refusing --policy')
    expect(io.err()).toContain(join(tempDir, 'policy.json'))
    // Refused before anything ran: no journal, not one protocol byte.
    expect(existsSync(journalPath())).toBe(false)
    expect(stdio.stdoutText()).toBe('')
  })

  test('--policy is refused even when it names the very file connect would have loaded', async () => {
    await addPolicyServer()
    const policyPath = await writeJournalPolicy(ALLOW_ALL_POLICY)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT, '--policy', policyPath],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    // The flag is refused by its nature, not by where it points: a rule that
    // depends on the value is a rule an attacker gets to probe.
    expect(exitCode).toBe(1)
    expect(io.err()).toContain('refusing --policy')
  })

  test('the usage text no longer advertises --policy', async () => {
    await runConnect([SERVER], io, depsOf())

    expect(io.err()).toContain('Usage:')
    expect(io.err()).not.toContain('--policy <path>')
  })

  test('$MCP_JOURNAL_POLICY is ignored, with a note, and the journal-dir policy still applies', async () => {
    await addPolicyServer()
    await writeJournalPolicy(DENY_ECHO_POLICY)
    const envPolicy = join(tempDir, 'env-policy.json')
    await writeFile(envPolicy, JSON.stringify(ALLOW_ALL_POLICY), 'utf8')
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const denied = await echoWasDenied({
      token,
      deps: {
        env: {
          MCP_AGENT_TOKEN: token,
          PATH: process.env['PATH'] ?? '',
          MCP_JOURNAL_POLICY: envPolicy,
        },
      },
    })

    expect(denied).toBe(true)
    expect(io.err()).toContain('ignoring $MCP_JOURNAL_POLICY')
    expect(io.err()).toContain(`policy: loaded from ${join(tempDir, 'policy.json')}`)
  })

  test('a project-level <cwd>/.mcp-journal/policy.json is ignored, with a note', async () => {
    await addPolicyServer()
    await writeJournalPolicy(DENY_ECHO_POLICY)
    const projectDir = join(tempDir, 'agent-project')
    await mkdir(join(projectDir, '.mcp-journal'), { recursive: true })
    const projectPolicy = join(projectDir, '.mcp-journal', 'policy.json')
    await writeFile(projectPolicy, JSON.stringify(ALLOW_ALL_POLICY), 'utf8')
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const denied = await echoWasDenied({ token, deps: { cwd: projectDir } })

    expect(denied).toBe(true)
    expect(io.err()).toContain(`ignoring ${projectPolicy}`)
  })

  test('no note is printed when no agent-controlled source is present', async () => {
    await addPolicyServer()
    await writeJournalPolicy(DENY_ECHO_POLICY)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    await echoWasDenied({ token })

    expect(io.err()).not.toContain('ignoring')
  })
})

describe('connect: vault failure messages', () => {
  test('each failure shape names what the operator has to fix, and nothing else', () => {
    expect(formatVaultFailure('env', { status: 'invalid-refs', refs: ['vault:BAD NAME'] })).toContain(
      'vault:BAD NAME',
    )
    expect(
      formatVaultFailure('headers', { status: 'vault-error', failure: { status: 'not-initialized' } }),
    ).toContain('mcp-journal vault init')
    expect(
      formatVaultFailure('env', {
        status: 'vault-error',
        failure: { status: 'corrupt', message: 'tag mismatch' },
      }),
    ).toContain('tag mismatch')
  })

  /**
   * The message is also the probe's one-line `message` (`probe/engine.ts`
   * trims it and the status store keeps it), and every terminal-facing view
   * sanitizes control characters into `?`. An interior newline therefore read
   * as `crm-token?Add each with: …` in `server add|list|show` (user-journey
   * smoke 2026-09-18, UX-3). Fixing it HERE rather than weakening the
   * sanitizer: one line is the honest shape for a fact that also travels as a
   * field.
   */
  test('the missing-secrets message is one line, so a one-line view reads it whole', () => {
    const message = formatVaultFailure('headers', {
      status: 'missing-secrets',
      missing: ['crm-token'],
    })

    expect(message.trimEnd()).not.toContain('\n')
    expect(message.trimEnd()).toBe(
      "missing vault secret(s) for the server's headers: crm-token — " +
        'add each with: mcp-journal vault set <name>',
    )
  })
})

// ---------------------------------------------------------------------------
// HTTP upstream
// ---------------------------------------------------------------------------

describe('connect: http upstream', () => {
  test('a sessionful server is bridged to the stdio agent', async () => {
    const fixture = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'http',
      url: fixture.url,
      protocol: 'sessionful',
    })
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: ['echo'],
    })

    const outcome = await runLines({
      token,
      lines: [
        requestLine(1, 'initialize', { protocolVersion: '2025-06-18' }),
        requestLine(2, 'tools/call', { name: 'echo', arguments: {} }),
      ],
    })

    expect(outcome.exitCode).toBe(0)
    expect((outcome.messages[0]?.['result'] as { protocolVersion: string }).protocolVersion).toBe(
      '2025-06-18',
    )
    expect((outcome.messages[1]?.['result'] as { echo: string }).echo).toBe('tools/call')
    // Both directions were journaled, exactly as on the stdio path.
    expect(outcome.records.some((record) => record.direction === 'server→client')).toBe(true)
    fixture.stop()
  })

  test('an unresolvable header secret refuses before any request is sent', async () => {
    const fixture = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'http',
      url: fixture.url,
      protocol: 'sessionful',
      headers: { Authorization: 'vault:absent-header' },
    })
    await seedVault(tempDir, VAULT_SECRET_NAME, VAULT_MARKER)
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const exitCode = await runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('absent-header')
    expect((await fixture.stats()).posts).toBe(0)
    expect(existsSync(journalPath())).toBe(false)
    fixture.stop()
  })

  test('a stateless record refuses a sessionful client before any request is sent', async () => {
    const fixture = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await addServerRecord(tempDir, {
      name: SERVER,
      transport: 'http',
      url: fixture.url,
      protocol: 'stateless',
    })
    const token = await createGrantedAgent({
      journalDir: tempDir,
      agentName: AGENT,
      serverName: SERVER,
      tools: '*',
    })

    const runPromise = runConnect(
      [SERVER, '--agent', AGENT],
      io,
      depsOf({ env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' } }),
    )
    stdio.clientOutbox.write(requestLine(1, 'initialize', { protocolVersion: '2025-06-18' }))
    const exitCode = await runPromise

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('protocol-mismatch')
    expect(io.err()).toContain('docs/adr/0002-http-dual-version.md')
    expect((await fixture.stats()).posts).toBe(0)
    expect(stdio.stdoutText()).toBe('')
    fixture.stop()
  })
})
