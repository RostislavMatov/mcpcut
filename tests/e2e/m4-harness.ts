import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import type { DispatchOptions } from '../../src/cli.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import type { UiClient, UiTestHarness } from '../ui/harness.js'
import {
  asOwner,
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

  const addServer = async (name: string, variant: SchemaVariant): Promise<CliRun> =>
    plane.run(
      [
        'server', 'add', name,
        '--transport', 'stdio',
        '--command', process.execPath,
        '--args', [M4_FIXTURE, variant].join(','),
      ],
      await asOwner(plane),
    )

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
    // Read through the queue module (M4.5 wave 3 moved the medium into
    // state.db): still a read of what was actually persisted, same as the
    // resolved-file read this replaced.
    const queue = createApprovalQueue({ baseDir: join(journalDir, 'approvals') })
    const resolved = await queue.listResolved({ limit: 100 })
    const record = resolved.find((entry) => entry.approvalId === approvalId)
    if (record === undefined) throw new Error(`no resolved approval ${approvalId} in state.db`)
    return record as unknown as Record<string, unknown>
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

/**
 * The dispatch seam that runs `approvals approve|deny` AS one of the harness's
 * named admins — the same human the browser logs in as.
 *
 * Since M5 wave 2 (owner decision O3) a resolution made from the shell carries
 * `actor: cli:<adminName>`, read from a personal token in `MCP_ADMIN_TOKEN`.
 * Reusing the UI's admins here is deliberate: it lets one scenario show the
 * same person attributed as `ui:<name>` through the browser and `cli:<name>`
 * through the terminal, rather than as an anonymous `cli`.
 */
export function cliAsAdmin(harness: UiTestHarness, adminName: string): DispatchOptions {
  const token = harness.tokens[adminName]
  if (token === undefined) throw new Error(`no admin token for "${adminName}"`)
  return { approvals: { env: { [ADMIN_TOKEN_ENV_VAR]: token } } }
}

/** Every message the agent received under one JSON-RPC id (usually expected: one). */
export function messagesWithId(live: ConnectDriver, id: number): Record<string, unknown>[] {
  return live.stdio.messages().filter((message) => message['id'] === id)
}
