import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import type { DispatchOptions } from '../../src/cli.js'
import { REPORT_FILES } from '../../src/journal/report.js'
import { PROBE_SESSION_ID, STATUS_STALE_AFTER_MS } from '../../src/probe/constants.js'
import { readJournalRecords, requestLine, waitUntilAsync } from '../proxy/harness.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import { startUiHarness, type UiTestHarness } from '../ui/harness.js'
import {
  asOwner,
  createPlane,
  HTTP_STATELESS_FIXTURE,
  runConnectLines,
  runOnboarding,
  type CliRun,
  type Plane,
} from './m3-harness.js'

/**
 * M5.5 п.1 end-to-end (Task 9): the server-status probe driven through the
 * REAL surfaces only — `dispatch()` for every CLI command, `runUi()` over a
 * real socket for the admin UI, the real probe engine spawning the real
 * stdio/http fixtures — over one temp journal directory per test. No store
 * is ever written directly; where a scenario needs "time passed", the CLI's
 * documented probe-clock seam (`server.probes.now`) backdates the RECORDED
 * probe time instead of sleeping (the plan's "сдвинь часы инжекцией").
 *
 * Mechanisms already covered in isolation are not re-run here: the engine's
 * transport matrix (`tests/probe/engine.test.ts`), the orchestrator's dedup
 * and cap (`tests/probe/orchestrator.test.ts`), the route × role matrix
 * (`tests/ui/authz-match.test.ts`), dot/tooltip rendering states
 * (`tests/ui/servers-render.test.ts`). What only this file shows is the
 * COMPOSITION: registration → auto-probe → inventory → page; staleness →
 * lazy probe → SSE; refresh → quarantine; probes → journal → verify/export.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The controllable stdio fixture (see the file itself for the control-file contract). */
const PROBE_FIXTURE = join(__dirname, '../fixtures/probe-server.mjs')

/** Per-test budget: UI boot + real spawns + verify/export stay well inside it. */
const TEST_TIMEOUT_MS = 30_000

/**
 * How far into the past a backdated probe result is stamped: past the
 * staleness horizon, so the very next status read sees it as stale.
 */
const BACKDATE_MS = STATUS_STALE_AFTER_MS + 60_000

let tempDir: string
let plane: Plane
let ui: UiTestHarness | null = null

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-m55-p1-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await ui?.stop()
  ui = null
  await rm(tempDir, { recursive: true, force: true })
})

/** Writes (or rewrites) the fixture's control file between probes. */
function writeControl(path: string, control: Record<string, unknown>): Promise<void> {
  return writeFile(path, JSON.stringify(control), 'utf8')
}

/**
 * The probe-clock seam of the `server` commands: results recorded by THIS
 * invocation are stamped `BACKDATE_MS` in the past, so a later reader (UI or
 * CLI, real clock) sees them as stale without any sleeping.
 */
function backdatedProbeSeam(): DispatchOptions {
  return { server: { probes: { now: () => Date.now() - BACKDATE_MS } } }
}

/** `extra` with the plane owner's token on the `server` seam (`server add` is owner-only). */
async function asServerOwner(extra: DispatchOptions = {}): Promise<DispatchOptions> {
  const owner = await asOwner(plane)
  return { ...extra, server: { ...extra.server, ...owner.server } }
}

/** `server add` for a stdio server backed by the controllable fixture. */
async function addStdioServer(
  name: string,
  controlPath: string,
  extra: DispatchOptions = {},
): Promise<CliRun> {
  const run = await plane.run(
    [
      'server', 'add', name,
      '--transport', 'stdio',
      '--command', process.execPath,
      '--args', [PROBE_FIXTURE, controlPath].join(','),
    ],
    await asServerOwner(extra),
  )
  expect(run.err, `server add ${name} failed`).not.toMatch(/error/i)
  expect(run.code).toBe(0)
  return run
}

/** Mints a named admin through the CLI and returns its one-time token. */
async function mintAdminToken(name: string, role: string): Promise<string> {
  // Not the bootstrap any more: the plane's owner exists as soon as the first
  // `server add` ran, so every further admin is minted by that owner.
  const run = await plane.run(['admin', 'add', name, '--role', role], await asOwner(plane))
  expect(run.code).toBe(0)
  const token = /^token: (\S+)$/m.exec(run.out)?.[1]
  if (token === undefined) throw new Error(`admin add printed no token: ${run.out}`)
  return token
}

/** The record's payload as the object the probe writer built. */
function payloadOf(record: { payload: unknown }): Record<string, unknown> {
  return record.payload as Record<string, unknown>
}

/** Every `server-status-changed` SSE payload received so far, in order. */
function statusEventsOf(sseText: string): Array<Record<string, unknown>> {
  return [...sseText.matchAll(/event: server-status-changed\ndata: ([^\n]+)\n/g)].map(
    (match) => JSON.parse(match[1] ?? '{}') as Record<string, unknown>,
  )
}

/** Lines appended to the fixture's spawn log — one per real process start. */
async function spawnCountOf(spawnLogPath: string): Promise<number> {
  try {
    const text = await readFile(spawnLogPath, 'utf8')
    return text.split('\n').filter((line) => line.length > 0).length
  } catch {
    return 0
  }
}

describe('scenario 1 — the gate: registration alone yields tools and a white dot', () => {
  test(
    'server add → auto-probe → /servers shows the tools and an alive dot, zero agent calls',
    async () => {
      const controlPath = join(tempDir, 'control.json')
      await writeControl(controlPath, { mode: 'alive', variant: 'v1' })

      const add = await addStdioServer('gate-srv', controlPath)
      // The add itself already reports the probe's outcome (O8).
      expect(add.out).toMatch(/probe: alive/)

      ui = await startUiHarness({ journalDir: tempDir })
      const viewer = await ui.login('ui-viewer')
      const page = await viewer.get('/servers')
      expect(page.status).toBe(200)
      // Tools straight from the probe-fed inventory — no agent ever listed them.
      expect(page.body).toContain('read_note')
      expect(page.body).toContain('write_note')
      // The white (alive, no fresh traffic) dot with its SSE hook.
      expect(page.body).toContain('class="dot srv-dot" data-server="gate-srv"')

      // "Without a single agent call": the only traffic record is the probe's
      // own. The registration also leaves its `access-edit` attribution record
      // (UX-9, who registered this server) — a record ABOUT the command, not a
      // call through the plane, so it is set aside rather than counted here.
      const all = await readJournalRecords(tempDir)
      expect(all.map((record) => record.kind)).toContain('access-edit')
      const records = all.filter((record) => record.kind !== 'access-edit')
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        expect(record.kind).toBe('probe')
        expect(record.sessionId).toBe(PROBE_SESSION_ID)
      }
      const first = payloadOf(records[0] as { payload: unknown })
      expect(first['serverName']).toBe('gate-srv')
      expect(first['outcome']).toBe('alive')
      expect((first['initiator'] as Record<string, unknown>)['trigger']).toBe('registration')
    },
    TEST_TIMEOUT_MS,
  )
})

describe('scenario 2 — a dead server goes gray through the lazy probe and SSE', () => {
  test(
    'stale status + dead fixture → GET /servers answers instantly, the gray dot arrives by SSE',
    async () => {
      const controlPath = join(tempDir, 'control.json')
      await writeControl(controlPath, { mode: 'alive', variant: 'v1' })
      // The registration probe's result is stamped past the staleness horizon.
      await addStdioServer('lazy-srv', controlPath, backdatedProbeSeam())
      // The server "dies": the same confirmed command line now exits at once.
      await writeControl(controlPath, { mode: 'dead' })

      ui = await startUiHarness({ journalDir: tempDir })
      const viewer = await ui.login('ui-viewer')
      const sse = await ui.openSse(viewer)

      // The page answers from the store — still the last known alive dot.
      const first = await viewer.get('/servers')
      expect(first.status).toBe(200)
      expect(first.body).toContain('class="dot srv-dot" data-server="lazy-srv"')

      // The view triggered the lazy probe; its verdict arrives as an event.
      await sse.waitFor('server-status-changed')
      const events = statusEventsOf(sse.text())
      expect(events.length).toBeGreaterThan(0)
      const event = events[events.length - 1] as Record<string, unknown>
      expect(event['server']).toBe('lazy-srv')
      expect(event['status']).toBe('unreachable')

      // The next render shows the gray (off) dot — no reload was needed for
      // the SSE client, but the stored state agrees with what SSE pushed.
      const second = await viewer.get('/servers')
      expect(second.body).toContain('class="dot srv-dot dot-off" data-server="lazy-srv"')
      sse.close()
    },
    TEST_TIMEOUT_MS,
  )
})

describe('scenario 3 — refresh re-shoots tools/list into the standard quarantine path', () => {
  test(
    'a changed schema lands in quarantine with a structural diff; unchanged tools stay approved',
    async () => {
      const controlPath = join(tempDir, 'control.json')
      await writeControl(controlPath, { mode: 'alive', variant: 'v1' })
      await addStdioServer('drift-srv', controlPath)

      // One operator answers for both acts of this scenario: releasing a
      // quarantined tool needs a token of that role since owner decision Q17,
      // and forcing a probe always did.
      const token = await mintAdminToken('refresher', 'operator')

      // First observation quarantines both tools as `new`; approve them so a
      // baseline exists to diff against (the operator's normal review step).
      const approveAll = await plane.run(['quarantine', 'approve', '--all', '--server', 'drift-srv'], {
        quarantine: { env: { [ADMIN_TOKEN_ENV_VAR]: token } },
      })
      expect(approveAll.code).toBe(0)

      // The server changes ONE tool's schema (v2 adds the optional `force`).
      await writeControl(controlPath, { mode: 'alive', variant: 'v2' })

      const refresh = await plane.run(['server', 'refresh', 'drift-srv'], {
        server: { env: { [ADMIN_TOKEN_ENV_VAR]: token } },
      })
      expect(refresh.code).toBe(0)
      expect(refresh.out).toMatch(/refresh "drift-srv": alive/)
      // The changed tool was quarantined by the refresh...
      expect(refresh.out).toContain('quarantined: write_note (changed)')
      // ...and the unchanged one was NOT (O8: same schemaHash never re-quarantines).
      expect(refresh.out).not.toContain('read_note')

      // The quarantine entry carries the STRUCTURAL diff, not just "hashes differ".
      const show = await plane.run(['quarantine', 'show', 'drift-srv', 'write_note'])
      expect(show.code).toBe(0)
      expect(show.out).toContain('state: changed')
      expect(show.out).toContain('surfaceDelta: widened')
      expect(show.out).toContain('force')

      const list = await plane.run(['quarantine', 'list', '--server', 'drift-srv'])
      expect(list.code).toBe(0)
      expect(list.out).toContain('write_note')
      expect(list.out).not.toContain('read_note')

      // The refresh probe is attributed to the named operator in the journal.
      const probes = await readJournalRecords(tempDir, PROBE_SESSION_ID)
      const refreshRecord = probes.find(
        (record) =>
          (payloadOf(record)['initiator'] as Record<string, unknown>)['trigger'] === 'refresh',
      )
      expect(refreshRecord).toBeDefined()
      expect(
        (payloadOf(refreshRecord as { payload: unknown })['initiator'] as Record<string, unknown>)[
          'adminName'
        ],
      ).toBe('refresher')
    },
    TEST_TIMEOUT_MS,
  )
})

describe('scenario 4 — probe records are separable evidence, and the M5 chain stays whole', () => {
  test(
    'probe and agent records share the journal but never mix; verify, export --report and offline verify --report all pass',
    async () => {
      const controlPath = join(tempDir, 'control.json')
      await writeControl(controlPath, { mode: 'alive', variant: 'v1' })

      // The documented onboarding (vault init → server add → agent create/grant);
      // the add auto-probes, so a probe record exists before any agent speaks.
      const token = await runOnboarding(plane, {
        serverName: 'mixed-srv',
        agentName: 'probe-e2e-agent',
        command: process.execPath,
        args: [PROBE_FIXTURE, controlPath],
      })

      // Real agent traffic through `connect` — the records probes must be
      // separable FROM.
      const session = await runConnectLines({
        plane,
        token,
        sessionId: 'agent-session-1',
        argv: ['connect', 'mixed-srv', '--agent', 'probe-e2e-agent'],
        lines: [requestLine(1, 'tools/list')],
        expectedResponses: 1,
      })
      expect(session.code).toBe(0)

      const all = await readJournalRecords(tempDir)
      const probeRecords = all.filter((record) => record.kind === 'probe')
      const agentRecords = all.filter((record) => record.sessionId === 'agent-session-1')
      expect(probeRecords.length).toBeGreaterThan(0)
      expect(agentRecords.length).toBeGreaterThan(0)
      // Separable by construction: kind + reserved session id on one side...
      for (const record of probeRecords) {
        expect(record.sessionId).toBe(PROBE_SESSION_ID)
        expect(JSON.stringify(record.payload)).not.toContain('agentName')
      }
      // ...and not a single probe-kind record inside the agent's session.
      expect(agentRecords.every((record) => record.kind !== 'probe')).toBe(true)

      // The M5 evidentiary surface digests the probe records untouched.
      const seams = {
        keygen: { journalDir: tempDir },
        verify: { journalDir: tempDir },
        export: { journalDir: tempDir },
      }
      expect((await plane.run(['keygen'], seams)).code).toBe(0)
      expect((await plane.run(['verify'], seams)).code).toBe(0)

      const outDir = join(tempDir, 'export-out', 'report')
      expect((await plane.run(['export', '--report', '--out', outDir], seams)).code).toBe(0)
      expect((await plane.run(['verify', '--report', outDir], seams)).code).toBe(0)

      // The exported evidence carries the probes, still separable offline.
      const exported = await readFile(join(outDir, REPORT_FILES.records), 'utf8')
      expect(exported).toContain('"kind":"probe"')
      expect(exported).toContain(PROBE_SESSION_ID)
    },
    TEST_TIMEOUT_MS,
  )
})

describe('scenario 5 — vault values never surface on any probe-facing plane', () => {
  test(
    'an http probe sends the resolved secret upstream, yet no UI response, SSE byte, probe record or status document holds it',
    async () => {
      const SECRET = 'probe-marker-secret-value-9f3e7c1ab2'
      const fixture = await spawnHttpFixture()
      try {
        expect((await plane.run(['vault', 'init'])).code).toBe(0)
        // `vault set` needs an owner token (owner decision S2, 2026-09-03).
        const vaultOwner = await mintAdminToken('vault-owner', 'owner')
        expect(
          (
            await plane.run(['vault', 'set', 'probe-secret'], {
              vault: {
                env: { [ADMIN_TOKEN_ENV_VAR]: vaultOwner },
                readSecretInput: () => Promise.resolve(SECRET),
              },
            })
          ).code,
        ).toBe(0)

        const add = await plane.run(
          [
            'server', 'add', 'secret-http',
            '--transport', 'http',
            '--url', `http://127.0.0.1:${fixture.port}/mcp`,
            '--header', 'authorization=vault:probe-secret',
            '--protocol', 'stateless',
          ],
          await asServerOwner(),
        )
        expect(add.code).toBe(0)
        expect(add.out).toMatch(/probe: alive/)

        // Positive sentinel: the probe REALLY dereferenced the vault and sent
        // the value upstream — so the absence assertions below cannot pass
        // because nothing secret ever flowed.
        const stats = (await (
          await fetch(`http://127.0.0.1:${fixture.port}/__control/stats`)
        ).json()) as { lastPostHeaders: Record<string, string> }
        expect(stats.lastPostHeaders['authorization']).toContain(SECRET)

        // Exercise every UI-facing surface: page render, forced refresh, SSE.
        ui = await startUiHarness({ journalDir: tempDir })
        const operator = await ui.login('ui-operator')
        const sse = await ui.openSse(operator)
        await operator.get('/servers')
        const refresh = await operator.post('/servers/refresh', { name: 'secret-http' })
        expect(refresh.status).toBe(303)
        await sse.waitFor('server-status-changed')
        sse.close()

        // Marker sweep 1: every response byte the UI produced (headers,
        // bodies, the whole SSE stream).
        expect(ui.transcript()).not.toContain(SECRET)

        // Marker sweep 2: probe journal records specifically.
        const probes = await readJournalRecords(tempDir, PROBE_SESSION_ID)
        expect(probes.length).toBeGreaterThan(0)
        expect(JSON.stringify(probes)).not.toContain(SECRET)

        // Marker sweep 3: every persisted byte — journal.db (probe records),
        // state.db (+wal: the server-status.json document), the vault, all of
        // it, in both renderings.
        const persisted = await collectPersistedBytes(tempDir)
        expect(persisted.fileNames).toContain('state.db')
        expect(persisted.fileNames).toContain('journal.db')
        for (const rendering of persisted.renderings) {
          expect(rendering).not.toContain(SECRET)
        }
      } finally {
        fixture.child.kill('SIGKILL')
      }
    },
    TEST_TIMEOUT_MS,
  )
})

describe("scenario 6 — a viewer's page view is a named, journaled lazy trigger", () => {
  test(
    "GET /servers by a viewer probes a stale server; the record carries trigger 'lazy' and the viewer's name",
    async () => {
      const controlPath = join(tempDir, 'control.json')
      await writeControl(controlPath, { mode: 'alive', variant: 'v1' })
      await addStdioServer('viewed-srv', controlPath, backdatedProbeSeam())

      ui = await startUiHarness({ journalDir: tempDir })
      const viewer = await ui.login('ui-viewer')
      const page = await viewer.get('/servers')
      expect(page.status).toBe(200)

      // The probe the view caused settles in the background; its journal
      // record is the proof of O5's attribution contract (ADR-0008 §6).
      await waitUntilAsync(async () => {
        const probes = await readJournalRecords(tempDir, PROBE_SESSION_ID)
        return probes.some(
          (record) =>
            (payloadOf(record)['initiator'] as Record<string, unknown>)['trigger'] === 'lazy',
        )
      })
      const probes = await readJournalRecords(tempDir, PROBE_SESSION_ID)
      const lazy = probes.find(
        (record) =>
          (payloadOf(record)['initiator'] as Record<string, unknown>)['trigger'] === 'lazy',
      )
      const payload = payloadOf(lazy as { payload: unknown })
      expect(payload['serverName']).toBe('viewed-srv')
      expect(payload['outcome']).toBe('alive')
      expect(payload['initiator']).toEqual({ trigger: 'lazy', adminName: 'ui-viewer' })
    },
    TEST_TIMEOUT_MS,
  )
})

describe('scenario 7 — concurrent handles over one status document dedupe to a single probe', () => {
  test(
    'two concurrent `server list` runs (independent probe chains) spawn the fixture exactly once',
    async () => {
      const controlPath = join(tempDir, 'control.json')
      const spawnLog = join(tempDir, 'spawn.log')
      // The delay keeps the probe in flight long enough that the second
      // handle meets a FRESH `probing` marker, not a settled result.
      await writeControl(controlPath, {
        mode: 'alive',
        variant: 'v1',
        delayMs: 300,
        spawnLog,
      })
      await addStdioServer('busy-srv', controlPath, backdatedProbeSeam())

      const before = await spawnCountOf(spawnLog)
      expect(before).toBe(1) // the registration probe

      // Two `server list` invocations = two independent probe chains over the
      // same state.db, the same shape as two separate processes (each CLI run
      // composes its own orchestrator). Both see the stale status.
      const [first, second] = await Promise.all([
        plane.run(['server', 'list'], { server: { env: {} } }),
        plane.run(['server', 'list'], { server: { env: {} } }),
      ])
      expect(first.code).toBe(0)
      expect(second.code).toBe(0)

      // Cross-handle dedup (the fresh `probing` marker): one spawn, not two.
      const after = await spawnCountOf(spawnLog)
      expect(after - before).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )
})

/** Spawns the stateless http fixture and resolves once it printed its port. */
function spawnHttpFixture(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HTTP_STATELESS_FIXTURE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const line = buffered.split('\n')[0]
      if (line !== undefined && /^\d+$/.test(line.trim())) {
        resolve({ child, port: Number(line.trim()) })
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      reject(new Error(`http fixture exited (${String(code)}) before printing its port`))
    })
  })
}
