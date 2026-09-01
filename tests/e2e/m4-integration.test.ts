import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import { readJournalRecords, requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import { startUiHarness, type UiTestHarness } from '../ui/harness.js'
import {
  asOwner,
  decisionsOf,
  postMcp,
  rpcBody,
  runConnectLines,
  startServe,
  writePolicyFile,
  type Plane,
} from './m3-harness.js'
import {
  AGENT,
  ALLOW_ALL_POLICY,
  APPROVAL_TIMEOUT_MS,
  cliAsAdmin,
  createM4Context,
  GATE_POLICY,
  messagesWithId,
  OPERATOR,
  OTHER_SERVER,
  OWNER,
  QUARANTINE_DENY_POLICY,
  SERVER,
  UI_POLL_INTERVAL_MS,
  VIEWER,
  VISIBLE_WITHIN_MS,
  waitForPending,
  type M4Context,
} from './m4-harness.js'

/**
 * Milestone 4 end-to-end (Task 18): the admin UI and the traffic plane driven
 * together, each through its real entry point — `dispatch()` for every CLI
 * command and agent session, `runUi()` (the `mcp-journal ui` process body) for
 * the UI — over one temp journal directory and real HTTP sockets.
 *
 * What only this file can show is the COMPOSITION: that the file approvals
 * queue really is the shared source of truth between a blocked agent, the CLI
 * and a browser; that the UI is a standalone entry point which needs no `serve`
 * running; and that the role table, the grant matrix and the quarantine diff
 * all take effect on live traffic rather than only in a handler unit test.
 *
 * Mechanisms already covered in isolation are not re-run here: the SSE hub and
 * its revocation sweep (`tests/ui/events-*.test.ts`), the route × role matrix
 * (`tests/ui/ui-hardening.test.ts`), escaping (`tests/ui/html.test.ts`), the
 * schema differ (`tests/policy/schema-diff.test.ts`) and per-carrier redaction
 * (`tests/redact/leak-regression.test.ts`).
 */

let tempDir: string
let ctx: M4Context
let plane: Plane
let ui: UiTestHarness | null = null

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-m4-'))
  ctx = createM4Context(tempDir)
  plane = ctx.plane
})

afterEach(async () => {
  await ui?.stop()
  ui = null
  await rm(tempDir, { recursive: true, force: true })
})

/**
 * Every byte the plane persisted under `tempDir`, rendered as UTF-8 and as
 * latin1. Since M4.5 the admins document lives in `state.db` -- and, until a
 * checkpoint, its newest pages live only in the `state.db-wal` sidecar -- so a
 * secret scan aimed at `admins.json` would silently stop covering it.
 * Sweeping the whole directory covers every store, the journal and the
 * approval queue at once, and the two renderings keep a marker from hiding
 * inside a byte run that is not valid UTF-8.
 */
async function persistedBytes(): Promise<readonly string[]> {
  return (await collectPersistedBytes(tempDir)).renderings
}

/** Boots the composed UI over this test's plane directory. */
async function startUi(): Promise<UiTestHarness> {
  ui = await startUiHarness({ journalDir: tempDir, queuePollIntervalMs: UI_POLL_INTERVAL_MS })
  return ui
}

// Thin, per-test bindings of the harness moves (see `m4-harness.ts`), so a
// scenario body reads as a scenario rather than as plumbing.
const onboard: M4Context['onboard'] = (...args) => ctx.onboard(...args)
const addServer: M4Context['addServer'] = (...args) => ctx.addServer(...args)
const openSession: M4Context['openSession'] = (...args) => ctx.openSession(...args)
const runResourceRead: M4Context['runResourceRead'] = (...args) => ctx.runResourceRead(...args)
const readResolved: M4Context['readResolved'] = (id) => ctx.readResolved(id)

// ---------------------------------------------------------------------------
// (1) The gate metric, over `connect` (stdio) — with no `serve` in the picture
// ---------------------------------------------------------------------------

describe('e2e: scenario 1 — a stdio agent is unblocked by an approval clicked in the UI', () => {
  test('pending is visible in the UI ≤ 2s, approve delivers the call before the wait expires', async () => {
    const token = await onboard()
    await writePolicyFile(plane, GATE_POLICY)
    const harness = await startUi()
    const operator = await harness.login(OPERATOR)
    const stream = await harness.openSse(operator)

    const live = await openSession(token, 'm4-gate-connect')
    const askedAt = Date.now()
    live.stdio.clientOutbox.write(
      requestLine(2, 'tools/call', { name: 'write_note', arguments: { path: 'notes/a' } }),
    )

    const seen = await waitForPending(operator)
    expect(seen.elapsedMs).toBeLessThan(VISIBLE_WITHIN_MS)
    // The same delta reached the open browser tab without a reload.
    await stream.waitFor('approval-pending')
    expect(Date.now() - askedAt).toBeLessThan(VISIBLE_WITHIN_MS)

    const approved = await operator.post(`/approvals/${seen.approvalId}/approve`)
    expect(approved.status).toBe(200)
    expect(JSON.parse(approved.body)).toMatchObject({ status: 'ok', outcome: 'approved' })

    await waitUntil(() => live.stdio.lineCount() >= 2)
    // The whole round trip finished inside the agent's own wait window.
    expect(Date.now() - askedAt).toBeLessThan(APPROVAL_TIMEOUT_MS)
    const answers = messagesWithId(live, 2)
    expect(answers).toHaveLength(1)
    expect(answers[0]).not.toHaveProperty('error')
    // The call really reached the fixture (it stamps its own variant on it).
    expect(JSON.stringify(answers[0])).toContain('served')

    live.stdio.clientOutbox.end()
    await live.done
    const outcomes = decisionsOf(await readJournalRecords(tempDir, 'm4-gate-connect')).map(
      (record) => record.decision?.outcome,
    )
    expect(outcomes).toEqual(expect.arrayContaining(['require-approval-pending', 'approved']))
  })
})

// ---------------------------------------------------------------------------
// (2) The same gate through the `serve` HTTP front
// ---------------------------------------------------------------------------

describe('e2e: scenario 2 — an HTTP agent behind `serve` is unblocked from the UI', () => {
  test('a blocked POST completes once the operator approves in the browser', async () => {
    const token = await onboard()
    const policyPath = await writePolicyFile(plane, GATE_POLICY)
    const harness = await startUi()
    const operator = await harness.login(OPERATOR)
    const serve = await startServe(plane, ['--policy', policyPath])
    const url = serve.endpoint(AGENT, SERVER)

    const init = await postMcp({ url, token, body: rpcBody(1, 'initialize') })
    const sessionId = init.headers.get('mcp-session-id') ?? ''
    expect(sessionId).not.toBe('')
    const headers = { 'mcp-session-id': sessionId }
    await postMcp({ url, token, body: rpcBody(2, 'tools/list'), headers })

    // Deliberately NOT awaited: the front holds this request open while the
    // gate waits for a human, which is the property under test.
    const blocked = postMcp({
      url,
      token,
      body: rpcBody(3, 'tools/call', { name: 'write_note', arguments: { path: 'notes/b' } }),
      headers,
    })

    const seen = await waitForPending(operator)
    expect(seen.elapsedMs).toBeLessThan(VISIBLE_WITHIN_MS)
    expect((await operator.post(`/approvals/${seen.approvalId}/approve`)).status).toBe(200)

    const response = await blocked
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ id: 3 })
    expect(body).not.toHaveProperty('error')

    expect((await serve.shutdown()).code).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (3) The architectural property: the UI needs no `serve`
// ---------------------------------------------------------------------------

describe('e2e: scenario 3 — the UI is a standalone entry point', () => {
  test('every page and a store mutation work with no `serve` process anywhere', async () => {
    await onboard()
    const harness = await startUi()
    const owner = await harness.login(OWNER)

    for (const path of ['/', '/quarantine', '/servers', '/agents', '/journal', '/vault', '/admins']) {
      const page = await owner.get(path)
      expect([path, page.status]).toEqual([path, 200])
    }
    // A mutation, not just reads: the UI writes through the same file stores.
    const created = await owner.post('/agents/create', { name: 'ui-born-agent' })
    expect(created.status).toBe(200)

    // …and the CLI, a separate process boundary, sees it immediately.
    const listed = await plane.run(['agent', 'list'])
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('ui-born-agent')
  })
})

// ---------------------------------------------------------------------------
// (4) Deny: one outcome, same JSON-RPC id
// ---------------------------------------------------------------------------

describe('e2e: scenario 4 — a denial from the UI reaches the agent as one error', () => {
  test('the agent gets a synthetic error under the same id and nothing else', async () => {
    const token = await onboard()
    await writePolicyFile(plane, GATE_POLICY)
    const harness = await startUi()
    const operator = await harness.login(OPERATOR)

    const live = await openSession(token, 'm4-deny')
    live.stdio.clientOutbox.write(
      requestLine(7, 'tools/call', { name: 'write_note', arguments: { path: 'notes/c' } }),
    )
    const seen = await waitForPending(operator)

    const denied = await operator.post(`/approvals/${seen.approvalId}/deny`, { reason: 'not today' })
    expect(denied.status).toBe(200)
    expect(JSON.parse(denied.body)).toMatchObject({ status: 'ok', outcome: 'denied' })

    await waitUntil(() => live.stdio.lineCount() >= 2)
    const answers = messagesWithId(live, 7)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toHaveProperty('error')

    live.stdio.clientOutbox.end()
    await live.done
    const decisions = decisionsOf(await readJournalRecords(tempDir, 'm4-deny'))
    expect(decisions.some((record) => record.decision?.outcome === 'denied-by-operator')).toBe(true)
    // Exactly one outcome on disk, attributed to the human who clicked.
    const resolved = await readResolved(seen.approvalId)
    expect(resolved.resolution).toMatchObject({ outcome: 'denied', actor: `ui:${OPERATOR}` })
  })
})

// ---------------------------------------------------------------------------
// (5) CLI and UI race the same id
// ---------------------------------------------------------------------------

describe('e2e: scenario 5 — the first resolve wins and the loser gets a clean answer', () => {
  test('a CLI approval beats a later UI denial with 409, never a 500', async () => {
    const token = await onboard()
    await writePolicyFile(plane, GATE_POLICY)
    const harness = await startUi()
    const operator = await harness.login(OPERATOR)

    const live = await openSession(token, 'm4-race')
    live.stdio.clientOutbox.write(
      requestLine(11, 'tools/call', { name: 'write_note', arguments: { path: 'notes/d' } }),
    )
    const first = await waitForPending(operator)

    // The CLI resolves AS a named admin — the same human the browser is logged
    // in as. Before M5 wave 2 this path recorded a constant `cli`, so the
    // record said an approval happened but never who made it.
    const asOperator = cliAsAdmin(harness, OPERATOR)
    expect((await plane.run(['approvals', 'approve', first.approvalId], asOperator)).code).toBe(0)
    const late = await operator.post(`/approvals/${first.approvalId}/deny`)
    expect(late.status).toBe(409)
    expect(JSON.parse(late.body)).toMatchObject({ status: 'already-resolved' })
    // End to end, and attributed: the surface prefix differs from the UI's
    // `ui:<name>` (scenario 4), the human named does not.
    expect((await readResolved(first.approvalId)).resolution).toMatchObject({
      outcome: 'approved',
      actor: `cli:${OPERATOR}`,
    })

    // And the genuinely concurrent form: still exactly one winner.
    await waitUntil(() => live.stdio.lineCount() >= 2)
    live.stdio.clientOutbox.write(
      requestLine(12, 'tools/call', { name: 'write_note', arguments: { path: 'notes/e' } }),
    )
    const second = await waitForPending(operator)
    const [cli, uiDeny] = await Promise.all([
      plane.run(['approvals', 'approve', second.approvalId], asOperator),
      operator.post(`/approvals/${second.approvalId}/deny`),
    ])
    // Exactly one winner, and the loser answered cleanly (409 / non-zero exit).
    expect([cli.code === 0, uiDeny.status === 200].filter(Boolean)).toHaveLength(1)
    expect([200, 409]).toContain(uiDeny.status)
    if (uiDeny.status === 200) expect(cli.code).not.toBe(0)
    // Whichever surface won, the record names a human on that surface.
    expect((await readResolved(second.approvalId)).resolution).toMatchObject({
      actor: uiDeny.status === 200 ? `ui:${OPERATOR}` : `cli:${OPERATOR}`,
    })

    live.stdio.clientOutbox.end()
    await live.done
  })
})

// ---------------------------------------------------------------------------
// (6) Revocation from the UI tears down a live session
// ---------------------------------------------------------------------------

describe('e2e: scenario 6 — `revoke` in the UI ends the agent session', () => {
  test('the live stdio session dies within the revocation poll interval', async () => {
    const token = await onboard()
    await writePolicyFile(plane, ALLOW_ALL_POLICY)
    const harness = await startUi()
    // Personal-matrix routes are owner-only since T4 (2026-09-01); the
    // approvals scenarios keep proving that an operator can act and is named.
    const owner = await harness.login(OWNER)
    const live = await openSession(token, 'm4-revoke')

    const revoked = await owner.post('/agents/revoke', { agent: AGENT })
    expect(revoked.status).toBe(200)

    // Nobody closed the client's pipe: the session ends because the plane
    // polled `agents.json` and saw what the browser wrote.
    const ended = await live.done
    expect(ended.code).not.toBe(0)
    expect(ended.err).toContain('revoked')
    const records = await readJournalRecords(tempDir, 'm4-revoke')
    expect(records.some((record) => record.decision?.rule === 'agent-revoked')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (7) A changed tool schema: quarantine, structural diff, blocked call
// ---------------------------------------------------------------------------

describe('e2e: scenario 7 — a changed inputSchema quarantines the tool and shows a diff', () => {
  test('the UI renders the added property and surfaceDelta, and the call is blocked', async () => {
    const token = await onboard('v1')
    await writePolicyFile(plane, QUARANTINE_DENY_POLICY)
    const harness = await startUi()
    const operator = await harness.login(OPERATOR)

    // Round 1: the catalog is new, so both tools land in quarantine.
    const firstRun = await openSession(token, 'm4-quarantine-1')
    firstRun.stdio.clientOutbox.end()
    await firstRun.done
    await waitUntilAsync(async () =>
      (await operator.get('/quarantine')).body.includes('data-tool="write_note"'),
    )
    for (const tool of ['read_note', 'write_note']) {
      const ok = await operator.post('/quarantine/approve', { server: SERVER, tool })
      expect([tool, ok.status]).toEqual([tool, 200])
    }

    // The same server name, now serving a widened schema for `write_note`.
    expect((await plane.run(['server', 'remove', SERVER])).code).toBe(0)
    expect((await addServer(SERVER, 'v2')).code).toBe(0)
    // `server remove` cascades (M5.5 p.2, G6): the agent's grant for the server
    // went with it, so the re-registered server must be granted again.
    expect((await plane.run(['agent', 'grant', AGENT, SERVER], await asOwner(plane))).code).toBe(0)

    const secondRun = await openSession(token, 'm4-quarantine-2')
    // The catalog is observed asynchronously behind the response, so wait for
    // the observation to land before making the call it must block.
    await waitUntilAsync(async () =>
      (await operator.get('/quarantine')).body.includes('state-changed'),
    )
    secondRun.stdio.clientOutbox.write(
      requestLine(2, 'tools/call', { name: 'write_note', arguments: { path: 'notes/f' } }),
    )
    await waitUntil(() => secondRun.stdio.lineCount() >= 2)
    const blocked = secondRun.stdio.messages().find((message) => message['id'] === 2)
    expect(blocked).toHaveProperty('error')
    secondRun.stdio.clientOutbox.end()
    await secondRun.done

    const page = (await operator.get('/quarantine')).body
    expect(page).toContain('data-tool="write_note"')
    expect(page).toContain('state-changed')
    // A readable structural diff, not "the hashes diverged".
    expect(page).toContain('properties.force')
    expect(page).toContain('property-added')
    expect(page).toContain('surfaceDelta: widened')
  })
})

// ---------------------------------------------------------------------------
// (8) The resources grant dimension, opened and closed from the UI
// ---------------------------------------------------------------------------

describe('e2e: scenario 8 — granting `resources` in the UI opens the method', () => {
  test('no grant denies, a UI grant allows the matching URI only, and removing it closes again', async () => {
    const token = await onboard()
    await writePolicyFile(plane, ALLOW_ALL_POLICY)
    const harness = await startUi()
    // The grant matrix is an owner edit (T4); the resource dimension itself is
    // what this scenario is about.
    const owner = await harness.login(OWNER)

    const readNoGrant = await runResourceRead(token, 'm4-res-closed')
    expect(readNoGrant).toHaveProperty('error')

    const granted = await owner.post('/agents/grant', {
      agent: AGENT,
      server: SERVER,
      tools: '*',
      resources: 'file:///project/*',
    })
    expect(granted.status).toBe(200)

    const allowed = await runResourceRead(token, 'm4-res-open')
    expect(allowed).not.toHaveProperty('error')
    const outOfScope = await runResourceRead(token, 'm4-res-scope', 'file:///secrets/keys.env')
    expect(outOfScope).toHaveProperty('error')

    // Re-granting without the dimension closes it again (M3 fail-closed shape).
    const closed = await owner.post('/agents/grant', { agent: AGENT, server: SERVER, tools: '*' })
    expect(closed.status).toBe(200)
    expect(await runResourceRead(token, 'm4-res-reclosed')).toHaveProperty('error')

    const decisions = decisionsOf(await readJournalRecords(tempDir, 'm4-res-open'))
    expect(
      decisions.some(
        (record) => record.decision?.toolName === 'resources/read' && record.decision.outcome === 'allow',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (9) Marker test: no vault value and no admin token anywhere
// ---------------------------------------------------------------------------

/** Distinctive, and shaped like nothing `REDACT_VALUE_PATTERNS` would catch on its own. */
const VAULT_MARKER = 'VAULT-MARKER-m4-9f3a1c'

describe('e2e: scenario 9 — no vault value and no admin token escapes into the UI', () => {
  test('every UI byte, every SSE byte and every journal record is free of both', async () => {
    const token = await onboard('v1', {
      env: { M4_TOKEN: 'vault:m4-secret' },
      secret: { name: 'm4-secret', value: VAULT_MARKER },
    })
    await writePolicyFile(plane, GATE_POLICY)
    const harness = await startUi()
    const owner = await harness.login(OWNER)
    const stream = await harness.openSse(owner)

    // Real traffic first, so the journal and the queue actually hold content.
    const live = await openSession(token, 'm4-marker')
    live.stdio.clientOutbox.write(
      requestLine(3, 'tools/call', { name: 'write_note', arguments: { path: 'notes/g' } }),
    )
    const seen = await waitForPending(owner)
    await stream.waitFor('approval-pending')
    await owner.post(`/approvals/${seen.approvalId}/approve`)
    await waitUntil(() => live.stdio.lineCount() >= 2)
    live.stdio.clientOutbox.end()
    await live.done

    // Then every surface a browser can reach.
    for (const path of [
      '/', '/api/approvals', '/quarantine', '/servers', '/vault', '/agents', '/journal',
      '/admins', `/journal?session=m4-marker`,
    ]) {
      expect((await owner.get(path)).status).toBe(200)
    }

    const transcript = harness.transcript()
    expect(transcript.length).toBeGreaterThan(0)
    // The vault reference IS shown (that is the point of the vault page)…
    expect(transcript).toContain('vault:m4-secret')
    // …but never the value behind it, in any response or on the event stream.
    expect(transcript).not.toContain(VAULT_MARKER)
    expect(stream.text()).not.toContain(VAULT_MARKER)
    for (const [name, adminToken] of Object.entries(harness.tokens)) {
      expect([name, transcript.includes(adminToken)]).toEqual([name, false])
      expect([name, harness.stderr().includes(adminToken)]).toEqual([name, false])
    }

    // Everything the plane wrote to disk — journal, resolved approval and the
    // admins document alike. Each of the three is asserted PRESENT in the
    // sweep first (by session id, approval id and the `tokenHash` field), so
    // the negatives below cannot pass by scanning bytes that hold none of them.
    const persisted = await persistedBytes()
    expect(persisted.some((blob) => blob.includes('m4-marker'))).toBe(true)
    expect(persisted.some((blob) => blob.includes(seen.approvalId))).toBe(true)
    expect(persisted.some((blob) => blob.includes('tokenHash'))).toBe(true)
    for (const blob of [...persisted, harness.stderr()]) {
      expect(blob).not.toContain(VAULT_MARKER)
    }
    for (const adminToken of Object.values(harness.tokens)) {
      for (const blob of persisted) {
        expect(blob).not.toContain(adminToken)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// (10) The three roles, end to end
// ---------------------------------------------------------------------------

describe('e2e: scenario 10 — the role table holds on live traffic', () => {
  test('viewer cannot approve, operator can and is named, owner issues a scoped agent', async () => {
    const token = await onboard()
    await writePolicyFile(plane, GATE_POLICY)
    expect((await addServer(OTHER_SERVER, 'v1')).code).toBe(0)
    const harness = await startUi()
    const viewer = await harness.login(VIEWER)
    const operator = await harness.login(OPERATOR)
    const owner = await harness.login(OWNER)

    const live = await openSession(token, 'm4-roles')
    live.stdio.clientOutbox.write(
      requestLine(5, 'tools/call', { name: 'write_note', arguments: { path: 'notes/h' } }),
    )
    const seen = await waitForPending(operator)

    // viewer: refused, and the request is untouched.
    const refused = await viewer.post(`/approvals/${seen.approvalId}/approve`)
    expect(refused.status).toBe(403)
    const stillPending = JSON.parse((await viewer.get('/api/approvals')).body) as {
      approvals: Array<Record<string, unknown>>
    }
    expect(stillPending.approvals.map((entry) => entry.approvalId)).toContain(seen.approvalId)

    // operator: allowed, and the resolution carries their name.
    expect((await operator.post(`/approvals/${seen.approvalId}/approve`)).status).toBe(200)
    await waitUntil(() => live.stdio.lineCount() >= 2)
    expect(messagesWithId(live, 5)[0]).not.toHaveProperty('error')
    expect((await readResolved(seen.approvalId)).resolution).toMatchObject({
      outcome: 'approved',
      actor: `ui:${OPERATOR}`,
    })
    live.stdio.clientOutbox.end()
    await live.done

    // owner: issues a fresh agent scoped to exactly one server.
    const created = await owner.post('/agents/create', { name: 'scoped-bot' })
    expect(created.status).toBe(200)
    const scopedToken = /<pre class="token" data-token>([^<]+)<\/pre>/.exec(created.body)?.[1] ?? ''
    expect(scopedToken).not.toBe('')
    expect((await owner.post('/agents/grant', { agent: 'scoped-bot', server: SERVER, tools: '*' })).status).toBe(200)

    const onGranted = await runConnectLines({
      plane,
      token: scopedToken,
      sessionId: 'm4-scoped-ok',
      argv: ['connect', SERVER, '--agent', 'scoped-bot'],
      lines: [requestLine(1, 'tools/list')],
    })
    expect(onGranted.code).toBe(0)
    const onOther = await runConnectLines({
      plane,
      token: scopedToken,
      sessionId: 'm4-scoped-deny',
      argv: ['connect', OTHER_SERVER, '--agent', 'scoped-bot'],
      lines: [],
    })
    expect(onOther.code).not.toBe(0)
    expect(onOther.err).toContain('no grant for server')
  })
})
