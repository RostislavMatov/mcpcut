import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveConnectPolicy } from '../../src/cli/connect-policy.js'
import type { PolicyProvider } from '../../src/policy/reload.js'

/**
 * Smoke 2026-09-18, M1, on the agent-launched side. A `connect` session that
 * started with no policy adopts one that appears -- but only where THIS trust
 * class reads (ADR-0005): the state directory. The agent's own working
 * directory and environment stay as ignored after start-up as they were at it.
 */

let cwd: string
let journalDir: string
let stderr: string[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'mcp-journal-connect-adopt-cwd-'))
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-connect-adopt-home-'))
  stderr = []
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

async function startedWithoutPolicy(): Promise<PolicyProvider> {
  const outcome = await resolveConnectPolicy({
    io: { stderr: { write: (chunk: string) => stderr.push(chunk) } },
    journalDir,
    env: {},
    cwd,
  })
  if (outcome.status !== 'resolved') throw new Error('expected the journaling-only resolution')
  return outcome.policy
}

const DENY_ALL = JSON.stringify({ version: 1, defaultDecision: 'deny' })

describe('connect started with no policy file', () => {
  test('adopts a policy.json that appears in the state directory', async () => {
    const policy = await startedWithoutPolicy()
    expect(policy.current().defaultDecision).toBe('allow')

    await writeFile(join(journalDir, 'policy.json'), DENY_ALL, 'utf8')
    await policy.refresh()

    expect(policy.current().defaultDecision).toBe('deny')
    expect(stderr.join('')).toContain(`policy adopted: ${join(journalDir, 'policy.json')}`)
  })

  test('never adopts a project file from the agent’s working directory', async () => {
    const policy = await startedWithoutPolicy()

    await mkdir(join(cwd, '.mcp-journal'), { recursive: true })
    await writeFile(join(cwd, '.mcp-journal', 'policy.json'), DENY_ALL, 'utf8')
    await policy.refresh()

    expect(policy.current().defaultDecision).toBe('allow')
    expect(stderr.join('')).not.toContain('policy adopted')
  })
})
