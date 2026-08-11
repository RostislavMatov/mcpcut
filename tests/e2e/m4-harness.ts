import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import type { UiClient } from '../ui/harness.js'
import {
  createPlane,
  runOnboarding,
  startConnect,
  type CliRun,
  type ConnectDriver,
  type OnboardingArgs,
  type Plane,
} from './m3-harness.js'

/**
 * Plumbing for `tests/e2e/m4-integration.test.ts`, split out for the same
 * reason `m3-harness.ts` was: the scenarios read as scenarios, and the setup
 * that is identical across ten of them is written once.
 *
 * The rule `m3-harness.ts` established holds here unchanged — **every plane
 * command goes through `dispatch()`** and every UI action through a real HTTP
 * request. Nothing in this file writes a store directly; a helper that seeded
 * `agents.json` itself would stop the e2e proving that the documented operator
 * flow works.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The M4 stdio fixture: two tools with real schemas, plus a resources surface. */
export const M4_FIXTURE = join(__dirname, '../fixtures/m4-server.mjs')

/** Which `inputSchema` the fixture serves for `write_note` (`v2` adds one property). */
export type SchemaVariant = 'v1' | 'v2'

export const SERVER = 'm4-fixture'
export const OTHER_SERVER = 'm4-other'
export const AGENT = 'research-bot'

/** The three admins the UI harness mints, by role. */
export const OWNER = 'ui-owner'
export const OPERATOR = 'ui-operator'
export const VIEWER = 'ui-viewer'

/** Watcher cadence: short enough that the suite never sleeps for seconds. */
export const UI_POLL_INTERVAL_MS = 40

/** The agent's wait window. Every gate assertion must finish well inside it. */
export const APPROVAL_TIMEOUT_MS = 20_000

/** The plan's budget for "a new request is visible in the UI" (§Acceptance). */
export const VISIBLE_WITHIN_MS = 2000

/** Everything allowed, except that a `write` tool needs a human first. */
export const GATE_POLICY = {
  defaultDecision: 'allow',
  quarantine: { enabled: false },
  classDefaults: { write: 'require-approval' },
  approval: { timeoutMs: APPROVAL_TIMEOUT_MS },
}

/** No gate at all: used where the scenario is about grants or revocation. */
export const ALLOW_ALL_POLICY = { defaultDecision: 'allow', quarantine: { enabled: false } }

/** Quarantine on, and a quarantined tool is refused outright. */
export const QUARANTINE_DENY_POLICY = {
  defaultDecision: 'allow',
  quarantine: { enabled: true, onQuarantined: 'deny' },
}

/** One pending approval as the UI's own feed reported it, and how long that took. */
export interface PendingSeen {
  readonly approvalId: string
  readonly elapsedMs: number
}

/** One test's control plane, plus the M4-specific moves every scenario makes. */
export interface M4Context {
  readonly plane: Plane
  readonly journalDir: string
  /** `vault init → server add → vault set → agent create → agent grant`. */
  onboard(variant?: SchemaVariant, extra?: Partial<OnboardingArgs>): Promise<string>
  /** Registers another stdio server backed by the same fixture. */
  addServer(name: string, variant: SchemaVariant): Promise<CliRun>
  /** A live `connect` session that has already listed (and so classified) the catalog. */
  openSession(token: string, sessionId: string): Promise<ConnectDriver>
  /** One `resources/read` through a fresh session; returns the agent's answer. */
  runResourceRead(token: string, sessionId: string, uri?: string): Promise<Record<string, unknown>>
  /** The resolved queue file for one approval id, straight off disk. */
  readResolved(approvalId: string): Promise<Record<string, unknown>>
}

export function createM4Context(journalDir: string): M4Context {
  const plane = createPlane(journalDir)

  const onboard = (
    variant: SchemaVariant = 'v1',
    extra: Partial<OnboardingArgs> = {},
  ): Promise<string> =>
    runOnboarding(plane, {
      serverName: SERVER,
      agentName: AGENT,
      command: process.execPath,
      args: [M4_FIXTURE, variant],
      ...extra,
    })

  const addServer = (name: string, variant: SchemaVariant): Promise<CliRun> =>
    plane.run([
      'server', 'add', name,
      '--transport', 'stdio',
      '--command', process.execPath,
      '--args', [M4_FIXTURE, variant].join(','),
    ])

  async function openSession(token: string, sessionId: string): Promise<ConnectDriver> {
    const live = startConnect({ plane, token, sessionId, argv: ['connect', SERVER, '--agent', AGENT] })
    // The catalog first: a tool must be known (and classified) before a class
    // rule such as `write: require-approval` can apply to it.
    live.stdio.clientOutbox.write(requestLine(1, 'tools/list'))
    await waitUntil(() => live.stdio.lineCount() >= 1)
    return live
  }

  async function runResourceRead(
    token: string,
    sessionId: string,
    uri = 'file:///project/readme.md',
  ): Promise<Record<string, unknown>> {
    const live = startConnect({ plane, token, sessionId, argv: ['connect', SERVER, '--agent', AGENT] })
    live.stdio.clientOutbox.write(requestLine(1, 'resources/read', { uri }))
    await waitUntil(() => live.stdio.lineCount() >= 1)
    live.stdio.clientOutbox.end()
    await live.done
    return live.stdio.messages()[0] as Record<string, unknown>
  }

  async function readResolved(approvalId: string): Promise<Record<string, unknown>> {
    const raw = await readFile(join(journalDir, 'approvals', 'resolved', `${approvalId}.json`), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  }

  return { plane, journalDir, onboard, addServer, openSession, runResourceRead, readResolved }
}

/**
 * Polls the UI's OWN approvals feed (`GET /api/approvals`) until a request
 * shows up, and reports how long that took — the number the plan's "visible in
 * the UI ≤ 2 s" acceptance criterion is measured against. Reading it through
 * HTTP rather than off disk is the point: it is the browser's view under test.
 */
export async function waitForPending(client: UiClient): Promise<PendingSeen> {
  const startedAt = Date.now()
  let approvalId = ''
  await waitUntilAsync(async () => {
    const res = await client.get('/api/approvals')
    const payload = JSON.parse(res.body) as { approvals: Array<Record<string, unknown>> }
    approvalId = (payload.approvals[0]?.approvalId as string | undefined) ?? ''
    return approvalId !== ''
  })
  return { approvalId, elapsedMs: Date.now() - startedAt }
}

/** Every message the agent received under one JSON-RPC id (usually expected: one). */
export function messagesWithId(live: ConnectDriver, id: number): Record<string, unknown>[] {
  return live.stdio.messages().filter((message) => message['id'] === id)
}
