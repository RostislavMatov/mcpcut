import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { POLICY_RECHECK_MIN_MS } from '../../src/policy/constants.js'
import { requestLine, waitUntil } from '../proxy/harness.js'
import {
  createPlane,
  POLICY_SERVER_FIXTURE,
  runOnboarding,
  startConnect,
  writePolicyFile,
  type ConnectDriver,
  type Plane,
} from './m3-harness.js'

/**
 * Hot reload end to end (policy-tool-rules-ui plan, wave 2 gate): a REAL
 * `connect` session over the real stdio fixture, a REAL `policy.json` in a
 * temp plane directory, the real `stat`. The file is edited by hand while the
 * session is up; the next call is decided under the new rules and the tool
 * disappears from the next `tools/list`. A broken edit changes nothing and is
 * reported exactly once.
 *
 * Timing: the provider checks the file at most once per
 * `POLICY_RECHECK_MIN_MS`, and the swap lands asynchronously after the check
 * that noticed the change. A call that merely TRIGGERS the check is still
 * decided under the old rules, so each scenario waits out the cooldown, sends
 * one triggering call, and then waits for the reload to be announced on
 * stderr — never a fixed sleep for the swap itself.
 */

const SERVER_NAME = 'policysrv'
const AGENT_NAME = 'reload-bot'
const TEST_TIMEOUT_MS = 30_000

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-e2e-reload-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const ALLOW_ALL = { defaultDecision: 'allow', quarantine: { enabled: false } }

function denyEcho(): Record<string, unknown> {
  return { ...ALLOW_ALL, servers: { [SERVER_NAME]: { tools: { echo: 'deny' } } } }
}

/** Lets the provider's cooldown lapse, so the next call actually stats the file. */
function waitOutRecheckCooldown(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLICY_RECHECK_MIN_MS + 50))
}

/** Onboards the fixture and starts a live session; the session id doubles as the journal's. */
async function startLiveSession(sessionId: string): Promise<ConnectDriver> {
  await writePolicyFile(plane, ALLOW_ALL)
  const token = await runOnboarding(plane, {
    serverName: SERVER_NAME,
    agentName: AGENT_NAME,
    command: process.execPath,
    args: [POLICY_SERVER_FIXTURE],
  })
  return startConnect({ plane, argv: ['connect', SERVER_NAME, '--agent', AGENT_NAME], token, sessionId })
}

/** Sends one `echo` call and waits for its answer (whatever the verdict). */
async function callEcho(live: ConnectDriver, id: number): Promise<Record<string, unknown>> {
  live.stdio.clientOutbox.write(requestLine(id, 'tools/call', { name: 'echo', arguments: { id } }))
  await waitUntil(() => live.stdio.lineCount() >= id)
  const message = live.stdio.messages()[id - 1]
  if (message === undefined) throw new Error(`no answer for call ${id}`)
  return message
}

describe('policy hot reload through a live connect session', () => {
  test(
    'a hand edit denies the next call and hides the tool from the next tools/list',
    async () => {
      const live = await startLiveSession('reload-e2e-1')
      expect(await callEcho(live, 1)).toMatchObject({ id: 1, result: expect.anything() })

      await writePolicyFile(plane, denyEcho())
      await waitOutRecheckCooldown()
      // This call triggers the check and is still decided under the OLD rules.
      await callEcho(live, 2)
      await waitUntil(() => plane.allErr().includes('policy reloaded: '))

      expect(await callEcho(live, 3)).toMatchObject({
        id: 3,
        error: { data: { reason: 'policy_denied', rule: `servers.${SERVER_NAME}.tools.echo` } },
      })

      live.stdio.clientOutbox.write(requestLine(4, 'tools/list'))
      await waitUntil(() => live.stdio.lineCount() >= 4)
      const catalog = live.stdio.messages()[3] as { result: { tools: Array<{ name: string }> } }
      expect(catalog.result.tools.map((tool) => tool.name)).not.toContain('echo')
      expect(catalog.result.tools.length).toBeGreaterThan(0)

      live.stdio.clientOutbox.end()
      const run = await live.done
      expect(run.err).toMatch(/policy reloaded: [0-9a-f]{8} -> [0-9a-f]{8}/)
      expect(run.err).not.toContain('policy reload failed')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a broken edit keeps the last valid policy and is reported once; the fix is picked up',
    async () => {
      const live = await startLiveSession('reload-e2e-2')
      // The session must be UP before the file breaks: at start-up a broken
      // policy is a hard stop (M2 rule), and that is not what is under test.
      await callEcho(live, 1)

      await writeFile(join(plane.journalDir, 'policy.json'), '{ "version": 1, "defaultDecision": ', 'utf8')
      await waitOutRecheckCooldown()
      await callEcho(live, 2)
      await waitUntil(() => plane.allErr().includes('policy reload failed: '))

      // Several more checks against the same broken version: still allowed, still one report.
      for (const id of [3, 4]) {
        await waitOutRecheckCooldown()
        await callEcho(live, id)
      }
      for (const message of live.stdio.messages()) {
        expect(message).toMatchObject({ result: expect.anything() })
      }
      expect(plane.allErr().match(/policy reload failed: /g)).toHaveLength(1)
      expect(plane.allErr()).toMatch(/keeping policy [0-9a-f]{8}/)

      await writePolicyFile(plane, denyEcho())
      await waitOutRecheckCooldown()
      await callEcho(live, 5)
      await waitUntil(() => plane.allErr().includes('policy reloaded: '))
      expect(await callEcho(live, 6)).toMatchObject({ id: 6, error: { data: { reason: 'policy_denied' } } })

      live.stdio.clientOutbox.end()
      await live.done
    },
    TEST_TIMEOUT_MS,
  )
})
