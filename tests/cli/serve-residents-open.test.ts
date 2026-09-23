import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChildSessionDeps } from '../../src/cli/serve-child.js'
import { createResidentOpenStart } from '../../src/cli/serve-residents-open.js'
import type { StartJob } from '../../src/cli/serve-residents-start.js'
import { policySchema } from '../../src/policy/schema.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-resident-open-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/**
 * One held start (ADR-0016): an abort that lands while the process is still
 * being spawned must end the start at once — not after the whole start
 * budget (security review LOW-1: `serve` shutdown waited up to 40 s).
 */

const SILENT = "setInterval(() => undefined, 1000)"

function job(): StartJob {
  return {
    key: 'k',
    commandKey: 'c',
    pair: { agentName: 'bot', agentCreatedAt: 't', serverName: 'quiet' },
    agent: { name: 'bot', tokenHash: 'x', createdAt: 't', grants: { quiet: { tools: '*' } } } as StartJob['agent'],
    record: { name: 'quiet', transport: 'stdio', command: process.execPath, args: ['-e', SILENT] } as StartJob['record'],
  }
}

function childDeps(onResolve: () => void): ChildSessionDeps {
  return {
    agents: { getAgent: () => Promise.resolve(job().agent), findAgentByToken: () => Promise.resolve(undefined) },
    policy: policySchema.parse({ version: 1, defaultDecision: 'allow' }),
    journalDir,
    approvalsBaseDir: join(journalDir, 'approvals'),
    inventoryStorePath: join(journalDir, 'inventory.json'),
    stderr: { write: () => true },
    upstream: {
      processEnv: process.env,
      envAllowlist: ['PATH'],
      resolveRefs: async (declared) => {
        onResolve()
        return { status: 'resolved', values: { ...declared } }
      },
      killEscalationMs: 50,
    },
    newSessionId: () => '01TEST',
    failClosed: false,
  }
}

describe('createResidentOpenStart', () => {
  test('an abort during the spawn ends the start at once, and closes what was opened', async () => {
    // Arrange
    const abort = new AbortController()
    const open = createResidentOpenStart({
      // Aborted exactly while the env resolves — the spawn is on its way.
      childDeps: childDeps(() => abort.abort()),
      planeVersion: '0.0.0',
      now: Date.now,
    })
    const started = Date.now()

    // Act
    const result = await open(job(), Date.now() + 30_000, abort.signal)

    // Assert
    expect(result).toEqual({ ok: false, reason: 'aborted' })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)
})
