import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ClientConfigDocument, StdioClientEntry } from '../../src/agents/client-config.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import type { DispatchOptions } from '../../src/cli/dispatch-types.js'
import { INSTALL_CONFIG_VERSION } from '../../src/setup/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { createConnectStdio, type ConnectStdio } from '../cli/connect-harness.js'
import { requestLine, waitUntil } from '../proxy/harness.js'
import {
  asOwner,
  createPlane,
  POOL_SERVER_FIXTURE,
  startServe,
  writePolicyFile,
  type CliRun,
  type Plane,
} from './m3-harness.js'

/**
 * The PRD's success metric for the pool, through the product's own seams end
 * to end (ADR-0015 phase 5, Task 14): an agent is given ONE block by `agent
 * create`, that block is "pasted" once, and three later changes of its access
 * -- joining a group, losing a grant, getting it back -- reach the agent over
 * that one unchanged block, through the `connect --url` bridge, with no
 * restart. Then the audit report shows the pool session that carried it all
 * and verifies offline.
 */

const AGENT = 'bot'
const POLL_MS = 25

/** `npx -y mcpcut@<version>` — what npx consumes before handing argv to the binary. */
const NPX_PACKAGE_ARGS = 2

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-pool-bridge-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** The install config `agent create` reads its public address from -- never the developer's own. */
function installWithPublicUrl(publicUrl: string): InstallConfigLoad {
  return {
    kind: 'ok',
    path: join(tempDir, 'config.json'),
    config: {
      version: INSTALL_CONFIG_VERSION,
      dataDir: tempDir,
      ui: { host: '127.0.0.1', port: 8091 },
      serve: { host: '127.0.0.1', port: 8090, publicUrl },
    },
  }
}

function blockOf(out: string): ClientConfigDocument {
  const lines = out.split('\n')
  const start = lines.indexOf('{')
  return JSON.parse(lines.slice(start, lines.indexOf('}', start) + 1).join('\n')) as ClientConfigDocument
}

/** Runs one command as this plane's owner, failing loudly with its own stderr. */
async function owned(argv: readonly string[], extra: DispatchOptions = {}): Promise<CliRun> {
  const owner = await asOwner(plane)
  const env = owner.agent?.env ?? {}
  // `group` has no seam in the shared harness: without this one it would reach
  // the developer's own data directory.
  const result = await plane.run(argv, { ...owner, group: { journalDir: tempDir, env }, ...extra })
  if (result.code !== 0) throw new Error(`"mcpcut ${argv.join(' ')}" exited ${result.code}: ${result.err}`)
  return result
}

async function addServer(name: string, tools: readonly string[]): Promise<void> {
  await owned([
    'server',
    'add',
    name,
    '--transport',
    'stdio',
    '--command',
    process.execPath,
    '--args',
    [POOL_SERVER_FIXTURE, ...tools].join(','),
    '--env',
    `POOL_FIXTURE_NAME=${name}`,
  ])
}

function toolNamesOf(message: Record<string, unknown> | undefined): string[] {
  const result = message?.['result'] as { tools?: { name: string }[] } | undefined
  return (result?.tools ?? []).map((entry) => entry.name)
}

/** The bridge's reply to request `id`, once it has arrived. */
async function replyTo(stdio: ConnectStdio, id: number): Promise<Record<string, unknown>> {
  await waitUntil(() => stdio.messages().some((message) => message['id'] === id))
  return stdio.messages().find((message) => message['id'] === id) ?? {}
}

function listChangedCount(stdio: ConnectStdio): number {
  return stdio.messages().filter((message) => message['method'] === 'notifications/tools/list_changed').length
}

describe('e2e: one pasted block outlives three changes of access (PRD metric)', () => {
  test('group join, ungrant and re-grant reach the agent over the same bridge; the report shows the pool', async () => {
    // Arrange — three servers, a group that grants the third; the agent is not in it yet.
    await writePolicyFile(plane, { defaultDecision: 'allow', quarantine: { enabled: false } })
    await addServer('alpha', ['echo', 'slow_echo'])
    await addServer('beta', ['query'])
    await addServer('gamma', ['fetch'])
    await owned(['group', 'create', 'ops'])
    await owned(['group', 'grant', 'ops', 'gamma', '--tools', '*'])
    const serve = await startServe(plane, [], { revocationPollIntervalMs: POLL_MS })

    try {
      // The block `agent create` prints IS the pasted config.
      const publicUrl = `http://127.0.0.1:${serve.port}`
      const owner = await asOwner(plane)
      const created = await owned(['agent', 'create', AGENT], {
        agent: { ...owner.agent, install: installWithPublicUrl(publicUrl) },
      })
      const block = blockOf(created.out)
      const pasted = JSON.stringify(block)
      const entry = block.mcpServers.mcpcut as StdioClientEntry
      expect(entry.command).toBe('npx')
      expect(entry.args.slice(0, NPX_PACKAGE_ARGS)).toEqual(['-y', `mcpcut@${PRODUCT_VERSION}`])
      const bridgeArgv = entry.args.slice(NPX_PACKAGE_ARGS)
      expect(bridgeArgv).toEqual(['connect', '--url', publicUrl])
      expect(Object.keys(entry.env)).toEqual(['MCP_AGENT_TOKEN'])
      await owned(['agent', 'grant', AGENT, 'alpha', '--tools', '*'])
      await owned(['agent', 'grant', AGENT, 'beta', '--tools', '*'])

      // Act — the agent's process runs exactly what the block says.
      const stdio = createConnectStdio()
      const bridge = plane.run([...bridgeArgv], {
        connectBridge: {
          env: { ...entry.env },
          stdin: stdio.clientOutbox,
          stdout: stdio.clientStdout,
          clientOptions: { sseReconnectMaxAttempts: 1, delay: () => Promise.resolve() },
        },
      })
      const send = (line: string): void => void stdio.clientOutbox.write(line)
      send(requestLine(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }))
      await replyTo(stdio, 1)
      send(requestLine(2, 'tools/list'))
      expect(toolNamesOf(await replyTo(stdio, 2))).toEqual(['alpha__echo', 'alpha__slow_echo', 'beta__query'])

      // Progress on a pool call reaches the agent before the call's result.
      send(requestLine(3, 'tools/call', { name: 'alpha__slow_echo', arguments: {}, _meta: { progressToken: 'p-1' } }))
      await replyTo(stdio, 3)
      const messages = stdio.messages()
      const progressAt = messages.findIndex((message) => message['method'] === 'notifications/progress')
      expect(messages[progressAt]?.['params']).toMatchObject({ progressToken: 'p-1', message: 'alpha' })
      expect(progressAt).toBeLessThan(messages.findIndex((message) => message['id'] === 3))

      // Change 1: the agent joins the group that grants gamma.
      await owned(['group', 'join', 'ops', AGENT])
      await waitUntil(() => listChangedCount(stdio) >= 1)
      send(requestLine(4, 'tools/list'))
      expect(toolNamesOf(await replyTo(stdio, 4))).toContain('gamma__fetch')

      // Change 2: beta is taken away.
      await owned(['agent', 'ungrant', AGENT, 'beta'])
      await waitUntil(() => listChangedCount(stdio) >= 2)
      send(requestLine(5, 'tools/list'))
      expect(toolNamesOf(await replyTo(stdio, 5)).some((name) => name.startsWith('beta__'))).toBe(false)

      // Change 3: beta comes back.
      await owned(['agent', 'grant', AGENT, 'beta', '--tools', '*'])
      await waitUntil(() => listChangedCount(stdio) >= 3)
      send(requestLine(6, 'tools/list'))
      expect(toolNamesOf(await replyTo(stdio, 6))).toContain('beta__query')

      // The same bridge process lived through all three, and the block never moved.
      expect(JSON.stringify(block)).toBe(pasted)
      stdio.clientOutbox.end()
      expect((await bridge).code).toBe(0)
    } finally {
      await serve.shutdown()
    }

    // Assert — the audit report names the pool session and verifies offline.
    // Every seam named: without one these commands would reach the
    // developer's own data directory.
    const reportDir = join(tempDir, 'report')
    expect((await plane.run(['keygen'], { keygen: { journalDir: tempDir } })).code).toBe(0)
    const exported = await plane.run(['export', '--report', '--out', reportDir], { export: { journalDir: tempDir } })
    expect(exported.code).toBe(0)
    expect(exported.out).toContain('Pool sessions: 1')
    const summary = await readFile(join(reportDir, 'summary.md'), 'utf8')
    expect(summary).toContain('## Pool sessions')
    expect(summary).toMatch(/### Pool session \S+ — agent bot/)
    expect(summary).toMatch(/alpha → \S+/)
    expect(summary).toMatch(/gamma → \S+/)
    expect(summary.match(/beta → \S+/g)).toHaveLength(2)
    // Two watches race on an ungrant, and either one now leaves the same
    // record (DR1): the child session's own watch ends it as `revoked`, which
    // the pool reads as `ungranted`.
    expect(summary).toMatch(/- Left the pool: beta \(ungranted\)/)
    expect(summary).toMatch(/\| alpha \| slow\\_echo \|/)
    expect(summary).toMatch(/### Session \S+ — server alpha, pool session \S+ \(agent bot\)/)

    const verified = await plane.run(['verify', '--report', reportDir, '--pub', join(tempDir, 'signing.pub')], {
      verify: { journalDir: tempDir },
    })
    expect(verified.code).toBe(0)
    expect(verified.out).toContain('RESULT: PASSED')

    // D2 — one child exported alone still says whose pool it belonged to, and
    // still verifies: the pool lines are marked as outside the export.
    const child = /alpha → (\S+)/.exec(summary)?.[1] as string
    const childDir = join(tempDir, 'report-child')
    const childExport = await plane.run(['export', '--report', '--session', child, '--out', childDir], {
      export: { journalDir: tempDir },
    })
    expect(childExport.code).toBe(0)
    expect(childExport.out).toMatch(/Note: session \S+ was attached by 1 pool session\(s\)/)
    const childSummary = await readFile(join(childDir, 'summary.md'), 'utf8')
    expect(childSummary).toContain(`Pool membership of session ${child}`)
    expect(childSummary).toMatch(/- pool session \S+ — agent bot, server alpha/)
    const childVerified = await plane.run(['verify', '--report', childDir, '--pub', join(tempDir, 'signing.pub')], {
      verify: { journalDir: tempDir },
    })
    expect(childVerified.code).toBe(0)
    expect(childVerified.out).toContain('RESULT: PASSED')
  }, 60_000)
})
