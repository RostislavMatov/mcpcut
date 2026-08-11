import { rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import {
  JSONRPC_ERROR_HEADER_MISMATCH,
  REFUSAL_MODEL_UNDETECTED,
  REFUSAL_NO_GRANT,
  REFUSAL_UNKNOWN_SERVER,
  REFUSAL_VAULT_ERROR,
} from '../../src/cli/serve-constants.js'
import {
  createModelHandoff,
  createServeHooks,
  expectsResponse,
  validateStatelessHeaders,
} from '../../src/cli/serve-hooks.js'
import { createMemoryPipe } from '../../src/cli/serve-pipe.js'
import { createServeSessionFactory } from '../../src/cli/serve-runtime.js'
import { checkModelCompatibility } from '../../src/cli/serve-upstream.js'
import { createSessionManager } from '../../src/transport/http/session.js'
import { clientMessage, serverMessage } from '../../src/transport/message.js'
import {
  addStdioServer,
  disposeServeFixtures,
  fixtureControl,
  HTTP_SESSIONFUL_FIXTURE,
  INITIALIZE_BODY,
  POLICY_SERVER,
  SERVER,
  startHttpFixture,
  startServe,
  waitUntil,
} from './serve-harness.js'

/**
 * Edge cases of `serve`'s semantic hooks, the session factory's refusal
 * ladder and its transport plumbing — the parts a happy-path e2e cannot
 * reach: header↔body validation corner shapes, the fail-closed
 * downstream-model handoff, the in-memory front⇄session pipe's disposal
 * contract, and server-initiated messages travelling out over SSE.
 */

afterEach(disposeServeFixtures)

// ---------------------------------------------------------------------------
// Stateless header <-> body validation (SEP-2243)
// ---------------------------------------------------------------------------

function bodyOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('validateStatelessHeaders', () => {
  test('accepts a request whose headers mirror its body exactly', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })

    expect(
      validateStatelessHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'echo' }, body),
    ).toEqual({ ok: true })
  })

  test('accepts a method that carries no Mcp-Name at all', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(validateStatelessHeaders({ 'mcp-method': 'tools/list' }, body)).toEqual({ ok: true })
  })

  test('rejects a spurious Mcp-Name the body does not justify', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    const result = validateStatelessHeaders(
      { 'mcp-method': 'tools/list', 'mcp-name': 'echo' },
      body,
    )

    expect(result.ok).toBe(false)
    expect(errorOf(result)).toMatchObject({ code: JSONRPC_ERROR_HEADER_MISMATCH })
  })

  test('rejects headers on a body that is not a method message at all', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, result: {} })

    expect(validateStatelessHeaders({ 'mcp-method': 'tools/call' }, body).ok).toBe(false)
    expect(validateStatelessHeaders({}, body)).toEqual({ ok: true })
  })

  test('unparseable bodies expect no headers, and any header is a mismatch', () => {
    const garbage = Buffer.from('not json at all', 'utf8')

    expect(validateStatelessHeaders({}, garbage)).toEqual({ ok: true })
    expect(validateStatelessHeaders({ 'mcp-method': 'tools/call' }, garbage).ok).toBe(false)
  })

  test('a non-ASCII tool name must arrive in the spec Base64 sentinel form', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'экспорт' } })
    const sentinel = `=?base64?${Buffer.from('экспорт', 'utf8').toString('base64')}?=`

    expect(
      validateStatelessHeaders({ 'mcp-method': 'tools/call', 'mcp-name': sentinel }, body),
    ).toEqual({ ok: true })
    expect(
      validateStatelessHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'экспорт' }, body).ok,
    ).toBe(false)
  })

  test('a duplicated header is judged by its first value', () => {
    const body = bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(validateStatelessHeaders({ 'mcp-method': ['tools/list', 'x'] }, body)).toEqual({
      ok: true,
    })
    expect(validateStatelessHeaders({ 'mcp-method': ['x', 'tools/list'] }, body).ok).toBe(false)
  })

  test('MCP-Protocol-Version is passed through, never validated here (ADR-0002 §4)', () => {
    const body = bodyOf({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    })

    expect(
      validateStatelessHeaders(
        { 'mcp-method': 'tools/list', 'mcp-protocol-version': '1999-01-01' },
        body,
      ),
    ).toEqual({ ok: true })
  })
})

function errorOf(result: ReturnType<typeof validateStatelessHeaders>): unknown {
  if (result.ok) throw new Error('expected a rejection')
  return (JSON.parse(result.errorBody.toString('utf8')) as { error: unknown }).error
}

// ---------------------------------------------------------------------------
// expectsResponse
// ---------------------------------------------------------------------------

describe('expectsResponse', () => {
  test('only a request is owed an answer on the same HTTP response', () => {
    expect(expectsResponse(bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBe(true)
    expect(expectsResponse(bodyOf({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBe(
      false,
    )
    expect(expectsResponse(bodyOf({ jsonrpc: '2.0', id: 1, result: {} }))).toBe(false)
    expect(expectsResponse(Buffer.from('{oops', 'utf8'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Downstream-model handoff
// ---------------------------------------------------------------------------

describe('the downstream-model handoff', () => {
  test('is one-shot: a second read finds nothing', () => {
    const handoff = createModelHandoff()

    handoff.note('sessionful')

    expect(handoff.take()).toBe('sessionful')
    expect(handoff.take()).toBeNull()
  })

  test('detectInitialize notes the model it decided on', () => {
    const hooks = createServeHooks()

    expect(hooks.detectInitialize(Buffer.from(INITIALIZE_BODY, 'utf8'))).toBe(true)
    expect(hooks.handoff.take()).toBe('sessionful')

    expect(hooks.detectInitialize(bodyOf({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toBe(
      false,
    )
    expect(hooks.handoff.take()).toBe('stateless')
  })

  /**
   * The note is one-shot, so a POST that consults `detectInitialize` and
   * then refuses without opening a session must not leave one behind — a
   * later factory invocation would otherwise read a model decided for
   * somebody else's request. Both refusal shapes are covered: header
   * mismatch (the hooks ran → the front must reset explicitly, hence
   * `onOpenAbandoned`) and the session cap (checked before any hook runs,
   * so no note is ever created).
   */
  describe('refusals leave no stale note', () => {
    const CTX = { agentName: 'bot', serverName: 'testsrv' }
    const REFUSING_OPEN = () => Promise.resolve({ error: REFUSAL_UNKNOWN_SERVER })

    test('a 400 header mismatch resets the note through onOpenAbandoned', async () => {
      const hooks = createServeHooks()
      const manager = createSessionManager({
        openSession: REFUSING_OPEN,
        detectInitialize: hooks.detectInitialize,
        validateStatelessHeaders: hooks.validateStatelessHeaders,
        expectsResponse: hooks.expectsResponse,
        onOpenAbandoned: () => {
          hooks.handoff.take()
        },
      })

      const plan = await manager.handlePost(CTX, {}, bodyOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))

      expect(plan.status).toBe(400)
      expect(hooks.handoff.take()).toBeNull()
      await manager.close()
    })

    test('a 429 never reaches the hooks, so no note is created at all', async () => {
      const hooks = createServeHooks()
      const manager = createSessionManager({
        openSession: REFUSING_OPEN,
        detectInitialize: hooks.detectInitialize,
        validateStatelessHeaders: hooks.validateStatelessHeaders,
        expectsResponse: hooks.expectsResponse,
        maxSessions: 0,
      })

      const plan = await manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY, 'utf8'))

      expect(plan.status).toBe(429)
      expect(hooks.handoff.take()).toBeNull()
      await manager.close()
    })
  })
})

// ---------------------------------------------------------------------------
// The session factory's refusal ladder, driven directly
// ---------------------------------------------------------------------------

const AGENT_RECORD: AgentRecord = {
  name: 'bot',
  tokenHash: 'a'.repeat(64),
  createdAt: '2026-08-01T00:00:00.000Z',
  grants: { [SERVER]: { tools: '*' } },
}

function policyOf(): Policy {
  const parsed = parsePolicy({ version: 1, defaultDecision: 'allow', quarantine: { enabled: false } })
  if (!parsed.ok) throw new Error('test policy is invalid')
  return parsed.policy
}

interface FactoryOverrides {
  readonly agent?: AgentRecord | undefined
  readonly record?: ServerRecord | undefined
  readonly noteModel?: boolean
}

function factoryUnderTest(overrides: FactoryOverrides = {}) {
  const stderr: string[] = []
  const handoff = createModelHandoff()
  if (overrides.noteModel !== false) handoff.note('sessionful')

  const openSession = createServeSessionFactory({
    registry: { getServer: () => Promise.resolve(overrides.record) },
    agents: {
      getAgent: () =>
        Promise.resolve('agent' in overrides ? overrides.agent : AGENT_RECORD),
    },
    handoff,
    policy: policyOf(),
    journalDir: '/nonexistent-journal-dir',
    approvalsBaseDir: '/nonexistent-journal-dir/approvals',
    inventoryStorePath: '/nonexistent-journal-dir/tool-inventory.json',
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    upstream: {
      processEnv: {},
      envAllowlist: [],
      resolveRefs: (record) => Promise.resolve({ status: 'resolved', values: { ...record } }),
    },
    newSessionId: () => 'serve-hardening-session',
    failClosed: false,
  })

  return { openSession, stderr: () => stderr.join('') }
}

describe('createServeSessionFactory: refusal ladder', () => {
  test('fails closed when no downstream model was detected', async () => {
    const { openSession, stderr } = factoryUnderTest({ noteModel: false })

    const result = await openSession({ agentName: 'bot', serverName: SERVER })

    expect(result).toEqual({ error: REFUSAL_MODEL_UNDETECTED })
    expect(stderr()).toContain('session model')
  })

  test('an agent that vanished between authentication and opening gets no-grant', async () => {
    const { openSession } = factoryUnderTest({ agent: undefined })

    expect(await openSession({ agentName: 'bot', serverName: SERVER })).toEqual({
      error: REFUSAL_NO_GRANT,
    })
  })

  test('a revoked agent is refused as if it had no grant', async () => {
    const { openSession } = factoryUnderTest({
      agent: { ...AGENT_RECORD, revokedAt: '2026-08-02T00:00:00.000Z' },
      record: { name: SERVER, transport: 'stdio', command: 'true' },
    })

    expect(await openSession({ agentName: 'bot', serverName: SERVER })).toEqual({
      error: REFUSAL_NO_GRANT,
    })
  })

  test('the grant is checked before the registry, so absent servers stay unprobeable', async () => {
    const withoutGrant = factoryUnderTest({
      agent: { ...AGENT_RECORD, grants: {} },
      record: undefined,
    })
    const withGrant = factoryUnderTest({ record: undefined })

    expect(await withoutGrant.openSession({ agentName: 'bot', serverName: SERVER })).toEqual({
      error: REFUSAL_NO_GRANT,
    })
    expect(await withGrant.openSession({ agentName: 'bot', serverName: SERVER })).toEqual({
      error: REFUSAL_UNKNOWN_SERVER,
    })
  })
})

// ---------------------------------------------------------------------------
// The ADR-0002 compatibility matrix, cell by cell
// ---------------------------------------------------------------------------

describe('checkModelCompatibility (ADR-0002 matrix)', () => {
  const stdio: ServerRecord = { name: SERVER, transport: 'stdio', command: 'true' }
  const http = (protocol: 'sessionful' | 'stateless' | 'auto'): ServerRecord => ({
    name: SERVER,
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    protocol,
  })

  test('a sessionful agent transports every upstream except a stateless one', () => {
    expect(checkModelCompatibility('sessionful', stdio)).toBeNull()
    expect(checkModelCompatibility('sessionful', http('sessionful'))).toBeNull()
    expect(checkModelCompatibility('sessionful', http('auto'))).toBeNull()
    expect(checkModelCompatibility('sessionful', http('stateless'))).toContain('protocol-mismatch')
  })

  test('a stateless agent transports only a stateless-capable HTTP upstream', () => {
    expect(checkModelCompatibility('stateless', http('stateless'))).toBeNull()
    expect(checkModelCompatibility('stateless', http('auto'))).toBeNull()
    expect(checkModelCompatibility('stateless', http('sessionful'))).toContain('protocol-mismatch')
    expect(checkModelCompatibility('stateless', stdio)).toContain('initialize handshake')
  })
})

// ---------------------------------------------------------------------------
// The front <-> session pipe
// ---------------------------------------------------------------------------

describe('createMemoryPipe', () => {
  test('carries messages in both directions by identity', async () => {
    const pipe = createMemoryPipe()
    const toPlane: Buffer[] = []
    const toAgent: Buffer[] = []
    pipe.session.source.onMessage((message) => toPlane.push(message.bytes))
    pipe.front.source.onMessage((message) => toAgent.push(message.bytes))

    const up = clientMessage(Buffer.from('up', 'utf8'))
    const down = serverMessage(Buffer.from('down', 'utf8'))
    await pipe.front.sink.write(up)
    await pipe.session.sink.write(down)

    expect(toPlane).toEqual([up.bytes])
    expect(toAgent).toEqual([down.bytes])
  })

  test('delivers nothing after either end is disposed, and writes stay no-ops', async () => {
    const pipe = createMemoryPipe()
    const seen: Buffer[] = []
    pipe.session.source.onMessage((message) => seen.push(message.bytes))

    pipe.session.source.dispose()
    await expect(pipe.front.sink.write(clientMessage(Buffer.from('x', 'utf8')))).resolves.toBeUndefined()

    expect(seen).toEqual([])
  })

  test('the end signal fires exactly once', () => {
    const pipe = createMemoryPipe()
    let ends = 0
    pipe.front.source.onEnd(() => {
      ends += 1
    })

    pipe.endFrontSource()
    pipe.endFrontSource()

    expect(ends).toBe(1)
  })

  test('a handler registered after the end still learns the conversation is over', () => {
    // The front registers `onEnd` right after `openSession` resolves; a
    // session that died in between (dead upstream) must not leave the
    // front waiting for a message that can never come.
    const pipe = createMemoryPipe()
    let ends = 0

    pipe.endFrontSource()
    pipe.front.source.onEnd(() => {
      ends += 1
    })

    expect(ends).toBe(1)
  })

  test('a disposed source is not woken by a late registration', () => {
    const pipe = createMemoryPipe()
    let ends = 0

    pipe.endFrontSource()
    pipe.front.source.dispose()
    pipe.front.source.onEnd(() => {
      ends += 1
    })

    expect(ends).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Server-initiated traffic and origin screening, end to end
// ---------------------------------------------------------------------------

describe('runServe: live-session behaviour', () => {
  test('a message the upstream pushes reaches the agent on its GET stream', async () => {
    const fixture = await startServe({ grant: '*' })
    const url = await startHttpFixture(HTTP_SESSIONFUL_FIXTURE)
    await fixture.registry.addServer({ name: SERVER, transport: 'http', url, protocol: 'sessionful' })

    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')!

    const controller = new AbortController()
    const stream = await fetch(`${fixture.baseUrl}${fixture.path}`, {
      headers: { authorization: `Bearer ${fixture.token}`, 'mcp-session-id': sessionId },
      signal: controller.signal,
    })
    expect(stream.status).toBe(200)

    let received = ''
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of stream.body!) {
        received += decoder.decode(chunk as Uint8Array, { stream: true })
      }
    })().catch(() => undefined)

    const pushed = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })
    await waitUntil(() => true)
    for (let attempt = 0; attempt < 20 && !received.includes('notifications/message'); attempt += 1) {
      await fixtureControl(url, 'emit', pushed)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    controller.abort()

    expect(received).toContain('notifications/message')
  })

  test("the spawned server's stderr is journaled (redacted), never echoed to the plane's own", async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    expect((await fixture.post(INITIALIZE_BODY)).status).toBe(200)
    await fixture.shutdown()

    const records = await fixture.journalRecords()
    const stderrRecords = records.filter((record) => record.kind === 'stderr')
    expect(stderrRecords.length).toBeGreaterThan(0)
    expect(stderrRecords[0]?.direction).toBe('server-stderr')
    expect(fixture.io.errText()).not.toContain('policy-server: starting')
  })

  test('a server that cannot be spawned ends the session instead of hanging', async () => {
    const fixture = await startServe({ grant: '*' })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'stdio',
      command: '/nonexistent/mcp-server-binary',
    })

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(404)
    expect(fixture.io.errText()).toContain('SpawnServerError')
  })

  test('an unreadable vault refuses with a code, and the reason stays on stderr', async () => {
    const fixture = await startServe({ grant: '*' })
    await fixture.vault.setSecret('serve-marker', 'value')
    await addStdioServer(fixture, POLICY_SERVER, { MARKER_VALUE: 'vault:serve-marker' })
    await rm(join(fixture.journalDir, 'vault.key'))

    const response = await fixture.post(INITIALIZE_BODY)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: REFUSAL_VAULT_ERROR })
    expect(fixture.io.errText()).toContain('vault unavailable')
  })

  test('--fail-closed ends the session whose journal record could not be written', async () => {
    const fixture = await startServe({
      grant: '*',
      argv: ['--fail-closed'],
      serveOptions: {
        journalAppendFileImpl: () => Promise.reject(new Error('disk full')),
      },
    })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')!

    await waitUntil(
      () => fixture.io.errText().includes('journal write failed'),
      'the fail-closed report',
    )
    const after = await fixture.post(INITIALIZE_BODY, { 'mcp-session-id': sessionId })
    expect(after.status).toBe(404)
  })

  test('a notification is accepted with 202 and never waits for an answer', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')!

    const response = await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      { 'mcp-session-id': sessionId },
    )

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  test('an Origin outside the allowlist is refused before authentication', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const forbidden = await fixture.post(INITIALIZE_BODY, { origin: 'https://evil.example' })
    expect(forbidden.status).toBe(403)

    const allowed = await fixture.post(INITIALIZE_BODY, { origin: 'http://localhost:3000' })
    expect(allowed.status).toBe(200)
  })

  test('--allowed-origin extends the localhost allowlist', async () => {
    const fixture = await startServe({
      grant: '*',
      argv: ['--allowed-origin', 'https://ide.example'],
    })
    await addStdioServer(fixture, POLICY_SERVER)

    const response = await fixture.post(INITIALIZE_BODY, { origin: 'https://ide.example' })

    expect(response.status).toBe(200)
  })

  test('--allowed-host admits a reverse-proxy Host name; others still answer 403', async () => {
    const fixture = await startServe({
      grant: '*',
      argv: ['--allowed-host', 'mcp.internal.example'],
    })
    await addStdioServer(fixture, POLICY_SERVER)

    const allowed = await rawHostPost(fixture, 'mcp.internal.example')
    const refused = await rawHostPost(fixture, 'other.internal.example')

    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(403)
    expect(refused.body).toBe('{"error":"forbidden"}')
  })

  test('without --allowed-host a foreign Host name answers 403 (flag is the only way in)', async () => {
    const fixture = await startServe({ grant: '*' })
    await addStdioServer(fixture, POLICY_SERVER)

    const refused = await rawHostPost(fixture, 'mcp.internal.example')

    expect(refused.status).toBe(403)
  })
})

/**
 * `node:http` POST with full control over the Host header — `fetch` treats
 * `Host` as a forbidden header and silently drops overrides, so the CLI flag
 * cannot be exercised through the fixture's own `post`.
 */
function rawHostPost(
  fixture: { readonly handle: { readonly port: number }; readonly path: string; readonly token: string },
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: fixture.handle.port,
        path: fixture.path,
        method: 'POST',
        setHost: false,
        headers: {
          host: hostHeader,
          authorization: `Bearer ${fixture.token}`,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(INITIALIZE_BODY)
  })
}
