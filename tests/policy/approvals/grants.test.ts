import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { checkRecentApproval, createGrantRegistry } from '../../../src/policy/approvals/grants.js'

describe('createGrantRegistry', () => {
  test('isGranted is false before any grant is recorded', () => {
    const registry = createGrantRegistry()
    expect(registry.isGranted({ serverName: 'github', toolName: 'create_issue', argsHash: 'abc' })).toBe(
      false,
    )
  })

  test('isGranted is true immediately after grant()', () => {
    const registry = createGrantRegistry()
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key, 5000)

    expect(registry.isGranted(key)).toBe(true)
  })

  test('a grant does not apply to a different argsHash (different call, same tool)', () => {
    const registry = createGrantRegistry()
    registry.grant({ serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }, 5000)

    expect(registry.isGranted({ serverName: 'github', toolName: 'create_issue', argsHash: 'xyz' })).toBe(
      false,
    )
  })

  test('a grant expires after ttlMs, per the injected clock', () => {
    let nowMs = 0
    const registry = createGrantRegistry({ clock: () => nowMs })
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key, 1000)
    expect(registry.isGranted(key)).toBe(true)

    nowMs = 1001
    expect(registry.isGranted(key)).toBe(false)
  })

  test('grant() uses DEFAULT_GRANT_TTL_MS when ttlMs is omitted', () => {
    let nowMs = 0
    const registry = createGrantRegistry({ clock: () => nowMs })
    const key = { serverName: 'github', toolName: 'create_issue', argsHash: 'abc' }

    registry.grant(key)
    nowMs = 60_000 // well under DEFAULT_GRANT_TTL_MS (5 min)
    expect(registry.isGranted(key)).toBe(true)
  })
})

describe('checkRecentApproval', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-grants-test-'))
    await mkdir(join(baseDir, 'resolved'), { recursive: true })
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  async function writeResolvedFile(
    approvalId: string,
    fields: {
      serverName?: string
      toolName?: string
      argsHash?: string
      outcome?: string
      resolvedAt?: string
    } = {},
  ): Promise<void> {
    const content = {
      approvalId,
      serverName: fields.serverName ?? 'github',
      toolName: fields.toolName ?? 'create_issue',
      toolClass: 'write',
      argsRedacted: {},
      argsHash: fields.argsHash ?? 'hash-1',
      sessionId: 'session-1',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      resolution: { outcome: fields.outcome ?? 'approved' },
      resolvedAt: fields.resolvedAt ?? new Date().toISOString(),
    }
    await writeFile(join(baseDir, 'resolved', `${approvalId}.json`), JSON.stringify(content), 'utf8')
  }

  test('finds a recent approved resolution matching the triple', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { resolvedAt: new Date(nowMs - 1000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(true)
  })

  test('ignores a resolution with a different argsHash', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { argsHash: 'other-hash', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a resolution that is expired-by-ttl', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { resolvedAt: new Date(nowMs - 120_000).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a denied resolution', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { outcome: 'denied', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores an expired-outcome resolution (session teardown), not just denied', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { outcome: 'expired', resolvedAt: new Date(nowMs).toISOString() })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('ignores a resolution for a different server or tool', async () => {
    const nowMs = Date.now()
    await writeResolvedFile('01AAA', { serverName: 'other-server' })
    await writeResolvedFile('01BBB', { toolName: 'other_tool' })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      ttlMs: 60_000,
      clock: () => nowMs,
    })

    expect(granted).toBe(false)
  })

  test('skips malformed files instead of throwing', async () => {
    await writeFile(join(baseDir, 'resolved', 'garbage.json'), 'not json', 'utf8')

    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBe(false)
  })

  test('returns false when the resolved directory does not exist yet', async () => {
    await rm(join(baseDir, 'resolved'), { recursive: true, force: true })

    await expect(
      checkRecentApproval(baseDir, {
        serverName: 'github',
        toolName: 'create_issue',
        argsHash: 'hash-1',
        ttlMs: 60_000,
      }),
    ).resolves.toBe(false)
  })
})
