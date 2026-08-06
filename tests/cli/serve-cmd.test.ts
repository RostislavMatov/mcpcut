import { rm } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ADR_0002_REFERENCE,
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  JSONRPC_ERROR_HEADER_MISMATCH,
  REFUSAL_MISSING_SECRETS,
  REFUSAL_NO_GRANT,
} from '../../src/cli/serve-constants.js'
import { runServe, type ServeHandle } from '../../src/cli/serve-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  addStdioServer,
  AGENT,
  captureIo,
  createJournalDir,
  disposeServeFixtures,
  ENV_ECHO_SERVER,
  HTTP_SESSIONFUL_FIXTURE,
  HTTP_STATELESS_FIXTURE,
  INITIALIZE_BODY,
  onDispose,
  POLICY_SERVER,
  POLL_INTERVAL_MS,
  SERVER,
  sleep,
  startHttpFixture,
  startServe,
  toolCallBody,
  waitUntil,
  WAIT_TIMEOUT_MS,
} from './serve-harness.js'

/**
 * `mcp-journal serve` (M3 Task 13): the HTTP front wired to real registry /
 * agents / vault stores in a temp journal dir, driven with real HTTP requests
 * against an ephemeral port.
 *
 * Covers the plan's Task 13 validation list: het-transport bridges (HTTP
 * agent → stdio server, HTTP agent → HTTP server), both downstream session
 * models, the ADR-0002 mismatch refusals, agent grants and mid-session
 * revocation, graceful shutdown, EADDRINUSE, a broken policy, and the vault
 * path (secret reaches the child, never an HTTP response or the plane's
 * stderr). Semantic-hook edge cases live in `serve-hardening.test.ts`.
 */

afterEach(disposeServeFixtures)

// ---------------------------------------------------------------------------
// Argument parsing and startup
// ---------------------------------------------------------------------------

describe('runServe: argument parsing and startup', () => {
  test('defaults are the documented host and port constants', () => {
    expect(DEFAULT_SERVE_PORT).toBe(8090)
    expect(DEFAULT_SERVE_HOST).toBe('127.0.0.1')
  })

  test('an unknown option fails before anything is bound', async () => {
    const io = captureIo()
    let listened = false
    const code = await runServe(['--nope'], io, {
      signals: [],
      onListening: () => {
        listened = true
      },
    })

    expect(code).toBe(1)
    expect(listened).toBe(false)
    expect(io.errText()).toContain('mcp-journal serve')
    expect(io.outText()).toBe('')
  })

  test('a non-numeric --port is rejected with a usage error', async () => {
    const io = captureIo()
    const code = await runServe(['--port', 'eighty'], io, { signals: [] })

    expect(code).toBe(1)
    expect(io.errText()).toContain('--port')
  })

  test('an out-of-range --port is rejected', async () => {
    const io = captureIo()
    expect(await runServe(['--port', '70000'], io, { signals: [] })).toBe(1)
    expect(io.errText()).toContain('--port')
  })

  test('a broken policy stops serve before it listens', async () => {
    const { journalDir, policyPath } = await createJournalDir(
      '{"version": 1, "defaultDecision": "sometimes"}',
    )

    const io = captureIo()
    let listened = false
    const code = await runServe(['--port', '0', '--policy', policyPath], io, {
      journalDir,
      signals: [],
      onListening: () => {
        listened = true
      },
    })

    expect(code).toBe(1)
    expect(listened).toBe(false)
    expect(io.errText()).toContain(policyPath)
  })

  test('a port already in use fails with a clear error, not a stack trace', async () => {
    const blocker = createNetServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busyPort = (blocker.address() as AddressInfo).port
    onDispose(() => new Promise<void>((resolve) => blocker.close(() => resolve())))

    const { journalDir, policyPath } = await createJournalDir()
    const io = captureIo()
    const code = await runServe(['--port', String(busyPort), '--policy', policyPath], io, {
      journalDir,
      signals: [],
    })

    expect(code).not.toBe(0)
    expect(io.errText()).toContain(String(busyPort))
    expect(io.errText().toLowerCase()).toContain('in use')
  })

  test('listening is announced on stderr and stdout stays silent', async () => {
    const fixture = await startServe({ grant: '*' })

    expect(fixture.io.errText()).toContain(`127.0.0.1:${fixture.handle.port}`)
    expect(fixture.io.outText()).toBe('')
    expect(fixture.handle.host).toBe(DEFAULT_SERVE_HOST)
  })

  test('a run without any policy file starts journaling-only (like connect) and says so', async () => {
    const emptyDir = await createJournalDir()
    await rm(emptyDir.policyPath)

    const io = captureIo()
    let handle: ServeHandle | undefined
    const exit = runServe(['--port', '0'], io, {
      journalDir: emptyDir.journalDir,
      signals: [],
      loadPolicy: { cwd: emptyDir.journalDir, env: {} },
      onListening: (started) => {
        handle = started
      },
    })
    exit.catch(() => undefined)
    await waitUntil(() => handle !== undefined, 'the front to listen')

    expect(io.errText()).toContain('no policy file found')
    await handle!.shutdown()
    expect(await exit).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Het-transport: HTTP agent -> stdio server
// ---------------------------------------------------------------------------

describe('runServe: HTTP agent bridged to a stdio server', () => {
  test('initialize opens a session, tools/call is allowed, and both are journaled', async () => {
    const fixture = await startServe({ grant: ['echo'] })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    expect(init.status).toBe(200)
    const sessionId = init.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    expect(await init.json()).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'policy-server' } },
    })

    const call = await fixture.post(toolCallBody(2, 'echo'), { 'mcp-session-id': sessionId! })
    expect(call.status).toBe(200)
    expect(await call.json()).toMatchObject({ id: 2, result: {} })

    await fixture.shutdown()
    const records = await fixture.journalRecords()
    const decisions = records.filter((record) => record.kind === 'decision')
    expect(decisions.some((record) => record.decision?.outcome === 'allow')).toBe(true)
    expect(decisions.some((record) => record.decision?.toolName === 'echo')).toBe(true)
    // The registry name reaches the journal, never an `auto:<hash>` identity.
    expect(decisions.every((record) => record.decision?.serverName === SERVER)).toBe(true)
    expect(
      records.some((record) => record.direction === 'client→server' && record.kind === 'request'),
    ).toBe(true)
  })

  test('a tool the agent was not granted is denied without reaching the server', async () => {
    const fixture = await startServe({ grant: ['echo'] })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')!

    const denied = await fixture.post(toolCallBody(3, 'risky_tool'), { 'mcp-session-id': sessionId })
    expect(denied.status).toBe(200)
    const body = (await denied.json()) as { id: number; error?: { message: string } }
    expect(body.id).toBe(3)
    expect(body.error).toBeDefined()

    await fixture.shutdown()
    const records = await fixture.journalRecords()
    const deny = records
      .filter((record) => record.kind === 'decision')
      .find((record) => record.decision?.toolName === 'risky_tool')
    expect(deny?.decision?.outcome).toBe('deny')
    expect(deny?.decision?.rule).toBe(`agent: no grant for ${SERVER}/risky_tool`)
    // The upstream never answered it: no server→client record carries its id.
    expect(
      records.filter((record) => record.direction === 'server→client' && record.rpcId === 3),
    ).toEqual([])
  })

  test('the spawned server sees only the allowlisted slice of the plane environment', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, ENV_ECHO_SERVER, { DECLARED_VALUE: 'declared' })

    const response = await fixture.post(INITIALIZE_BODY)
    const echoed = (await response.json()) as Record<string, string>

    expect(echoed['DECLARED_VALUE']).toBe('declared')
    expect(echoed['MCP_JOURNAL_SERVE_MARKER']).toBeUndefined()
    expect(Object.keys(echoed)).not.toContain('npm_config_registry')
  })

  test('DELETE ends the session and its id stops working', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')!

    expect((await fixture.del({ 'mcp-session-id': sessionId })).status).toBe(204)
    const after = await fixture.post(toolCallBody(4, 'echo'), { 'mcp-session-id': sessionId })
    expect(after.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Het-transport: HTTP agent -> HTTP server
// ---------------------------------------------------------------------------

describe('runServe: HTTP agent bridged to an HTTP server', () => {
  test('a sessionful upstream is bridged end to end', async () => {
    const fixture = await startServe({ grant: '*' })
    const url = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await fixture.registry.addServer({ name: SERVER, transport: 'http', url, protocol: 'sessionful' })

    const init = await fixture.post(INITIALIZE_BODY)
    expect(init.status).toBe(200)
    // The plane mints its OWN downstream session id; the upstream's stays inside.
    expect(init.headers.get('mcp-session-id')).toBeTruthy()
    expect(await init.json()).toMatchObject({ id: 1, result: {} })
  })

  test('a stateless upstream is bridged with mirrored per-message headers', async () => {
    const fixture = await startServe({ grant: '*' })
    const url = await startHttpFixture(HTTP_STATELESS_FIXTURE)
    await fixture.registry.addServer({ name: SERVER, transport: 'http', url, protocol: 'stateless' })

    const response = await fixture.post(toolCallBody(9, 'echo'), {
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    // The fixture refuses a body whose Mcp-Method header does not mirror it,
    // so a clean 200 proves the plane mirrored the headers going upstream.
    expect(text).not.toContain('HeaderMismatch')
    expect(text).toContain('tools/call')
  })
})

// ---------------------------------------------------------------------------
// Stateless downstream: header <-> body validation
// ---------------------------------------------------------------------------

describe('runServe: stateless downstream header validation', () => {
  async function statelessFixture() {
    const fixture = await startServe({ grant: '*' })
    const url = await startHttpFixture(HTTP_STATELESS_FIXTURE)
    await fixture.registry.addServer({ name: SERVER, transport: 'http', url, protocol: 'stateless' })
    return fixture
  }

  test('a header that does not mirror the body is refused with -32020', async () => {
    const fixture = await statelessFixture()

    const response = await fixture.post(toolCallBody(10, 'echo'), { 'mcp-method': 'tools/list' })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(JSONRPC_ERROR_HEADER_MISMATCH)
    expect(body.error.message).toContain('Mcp-Method')
  })

  test('a missing Mcp-Method header is refused too (matrix 2.3: absence is MUST-level)', async () => {
    const fixture = await statelessFixture()

    const response = await fixture.post(toolCallBody(11, 'echo'))

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(
      JSONRPC_ERROR_HEADER_MISMATCH,
    )
  })

  test('an Mcp-Name that does not mirror params.name is refused', async () => {
    const fixture = await statelessFixture()

    const response = await fixture.post(toolCallBody(12, 'echo'), {
      'mcp-method': 'tools/call',
      'mcp-name': 'other_tool',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(JSONRPC_ERROR_HEADER_MISMATCH)
    expect(body.error.message).toContain('Mcp-Name')
  })
})

// ---------------------------------------------------------------------------
// ADR-0002 session-model mismatches
// ---------------------------------------------------------------------------

describe('runServe: session-model mismatch refusals (ADR-0002)', () => {
  /**
   * The agent gets the bare refusal CODE; the sentence explaining which
   * session model the server is registered with — and the ADR reference —
   * is operator information and goes to the plane's stderr only.
   */
  test('a sessionful agent against a stateless server record is refused with the code alone', async () => {
    const fixture = await startServe({ grant: '*' })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
      protocol: 'stateless',
    })

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('protocol-mismatch')
    expect(body.error).not.toContain(ADR_0002_REFERENCE)
    expect(fixture.io.errText()).toContain(ADR_0002_REFERENCE)
  })

  test('a stateless agent against a stdio server record is refused the same way', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const response = await fixture.post(toolCallBody(13, 'echo'), {
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('protocol-mismatch')
    expect(fixture.io.errText()).toContain(ADR_0002_REFERENCE)
  })

  test("an 'auto' HTTP record accepts a sessionful agent", async () => {
    const fixture = await startServe({ grant: '*' })
    const url = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await fixture.registry.addServer({ name: SERVER, transport: 'http', url, protocol: 'auto' })

    expect((await fixture.post(INITIALIZE_BODY)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Authorization refusals
// ---------------------------------------------------------------------------

describe('runServe: refusals leak nothing about the plane', () => {
  test('an agent with no grant for the server is refused without registry details', async () => {
    const fixture = await startServe()
    await addStdioServer(fixture, POLICY_SERVER)

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: REFUSAL_NO_GRANT })
    expect(fixture.io.outText()).toBe('')
  })

  test('a granted but unregistered server answers 404 without naming anything', async () => {
    const fixture = await startServe({ grant: '*' })

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(SERVER)
  })

  test('a missing vault secret refuses with a code only; the name reaches stderr alone', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, ENV_ECHO_SERVER, { MARKER_VALUE: 'vault:absent-secret' })

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: REFUSAL_MISSING_SECRETS })
    expect(fixture.io.errText()).toContain('absent-secret')
  })
})

// ---------------------------------------------------------------------------
// Vault secrets
// ---------------------------------------------------------------------------

describe('runServe: vault secrets reach the child and nothing else', () => {
  test('a vault-referenced env value is injected into the spawned server, never into the plane stderr', async () => {
    const marker = 'SERVE-VAULT-MARKER-4b71'
    const fixture = await startServe({ grant: '*' })
    await fixture.vault.setSecret('serve-marker', marker)
    await addStdioServer(fixture, ENV_ECHO_SERVER, { MARKER_VALUE: 'vault:serve-marker' })

    const response = await fixture.post(INITIALIZE_BODY)
    expect(response.status).toBe(200)
    const echoed = (await response.json()) as Record<string, string>
    // env-echo prints its whole environment: proof the secret crossed the spawn boundary.
    expect(echoed['MARKER_VALUE']).toBe(marker)

    await fixture.shutdown()
    expect(fixture.io.errText()).not.toContain(marker)
    expect(fixture.io.outText()).not.toContain(marker)
  })
})

// ---------------------------------------------------------------------------
// Revocation and shutdown
// ---------------------------------------------------------------------------

describe('runServe: revocation and graceful shutdown', () => {
  test('revoking the agent mid-session ends it within the poll interval', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    expect(init.status).toBe(200)
    const sessionId = init.headers.get('mcp-session-id')!

    await fixture.agents.revokeAgent(AGENT)

    // The live session dies on its own poll; its final decision record is the
    // observable proof (the token also dies, so no request can prove it).
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    let records: JournalRecord[] = []
    for (;;) {
      records = await fixture.journalRecords()
      if (records.some((record) => record.decision?.rule === 'agent-revoked')) break
      if (Date.now() > deadline) throw new Error('the session was never ended by the revocation')
      await sleep(POLL_INTERVAL_MS)
    }

    const unauthorized = await fixture.post(toolCallBody(5, 'echo'), { 'mcp-session-id': sessionId })
    expect(unauthorized.status).toBe(401)
  })

  test('the shutdown handler closes the front and leaves a flushed journal behind', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    expect((await fixture.post(INITIALIZE_BODY)).status).toBe(200)
    const port = fixture.handle.port

    expect(await fixture.shutdown()).toBe(0)

    const records = await fixture.journalRecords()
    expect(records.length).toBeGreaterThan(0)
    expect(records.some((record) => record.kind === 'response')).toBe(true)
    await expect(fetch(`http://127.0.0.1:${port}${fixture.path}`)).rejects.toThrow()
  })

  test('shutdown is idempotent', async () => {
    const fixture = await startServe({ grant: '*' })

    await fixture.handle.shutdown()
    await fixture.handle.shutdown()

    expect(await fixture.exit).toBe(0)
  })

  test('installs and removes its own signal handlers', async () => {
    const before = process.listenerCount('SIGINT')
    const { journalDir, policyPath } = await createJournalDir()

    const io = captureIo()
    let handle: ServeHandle | undefined
    const exit = runServe(['--port', '0', '--policy', policyPath], io, {
      journalDir,
      onListening: (started) => {
        handle = started
      },
    })
    exit.catch(() => undefined)
    await waitUntil(() => handle !== undefined, 'the front to listen')
    expect(process.listenerCount('SIGINT')).toBe(before + 1)

    await handle!.shutdown()
    expect(await exit).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
