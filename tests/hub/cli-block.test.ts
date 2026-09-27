import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, insertAccount, openAccountsDb, setStatus } from '../../hub/src/accounts-db.js'
import { runHubCli, type HubCliIo } from '../../hub/src/cli.js'
import { createFakeOrchestrator } from './fake-orchestrator.js'

/**
 * The operator's `block` / `unblock` (plan Task 5, H7; stage-4 review of
 * `hosted-path-and-ops`): an install of a blocked account must not run. With
 * the provisioner link `block` stops it (data kept); a failed stop is a
 * warning and the account is blocked anyway; without the link the output says
 * the install still runs (the running hub's sweep stops it). A `pending`
 * account is refused — its install is still being created. `unblock` starts
 * nothing.
 */

const NOW = Date.parse('2026-09-27T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-cli-block-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function run(argv: readonly string[], io: Partial<HubCliIo> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runHubCli(argv, {
    env: { HUB_DATA_DIR: dir },
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    clock: () => NOW,
    ...io,
  })
  return { code, out, err }
}

async function seed(githubId: number, login: string, status: 'pending' | 'active' | 'blocked' = 'active'): Promise<void> {
  const db = await openAccountsDb(dir)
  try {
    const now = new Date(NOW - DAY_MS).toISOString()
    insertAccount(db, { githubId, login, subdomain: login.toLowerCase(), githubCreatedAt: '2019-01-01T00:00:00Z', now }, 100)
    if (status !== 'pending') setStatus(db, githubId, status)
  } finally {
    db.handle.close()
  }
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof openAccountsDb>>) => T): Promise<T> {
  const db = await openAccountsDb(dir)
  try {
    return fn(db)
  } finally {
    db.handle.close()
  }
}

describe('block / unblock', () => {
  test('without a provisioner link: blocked, and it says honestly the install still runs', async () => {
    await seed(10, 'mallory')

    const result = await run(['block', 'Mallory'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('blocked @mallory (mallory)')
    expect(result.out).toContain("install not stopped: this shell has no provisioner link; the hub's next idle sweep stops it")
    expect(result.out).not.toContain('install removal pending orchestrator')
    expect(await withDb((db) => findAccountByGithubId(db, 10)?.status)).toBe('blocked')
  })

  test('with a provisioner: the install of a blocked account is stopped, its data kept', async () => {
    await seed(13, 'mike')
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('mike')

    const result = await run(['block', 'mike'], { orchestrator })

    expect(result.code).toBe(0)
    expect(orchestrator.calls()).toEqual([{ method: 'stop', subdomain: 'mike' }])
    expect(orchestrator.install('mike')?.running).toBe(false)
    expect(result.out).toContain('install stopped (data kept)')
    expect(await withDb((db) => findAccountByGithubId(db, 13))).toMatchObject({ status: 'blocked', stoppedAt: new Date(NOW).toISOString() })
  })

  test('a failed stop warns on stderr, redacted, and the account is blocked anyway', async () => {
    await seed(14, 'nora')
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('nora')
    const leaked = 'mcpo_blockLeak0123456789'
    orchestrator.fail('stop', `stop refused for ${leaked}`)

    const result = await run(['block', 'nora'], { orchestrator })

    expect(result.code).toBe(0)
    expect(result.err).toContain("hub: warning: stopping the install of @nora failed; the account is blocked anyway and the hub's next idle sweep tries again")
    expect(result.err).toContain('[redacted]')
    expect(`${result.out}${result.err}`).not.toContain(leaked)
    expect(await withDb((db) => findAccountByGithubId(db, 14))).toMatchObject({ status: 'blocked', stoppedAt: null })
  })

  test('an account still being created (pending) is refused: its install may appear later', async () => {
    await seed(15, 'otto', 'pending')
    const orchestrator = createFakeOrchestrator()

    const result = await run(['block', 'otto'], { orchestrator })

    expect(result.code).toBe(1)
    expect(result.err).toBe('hub: @otto: account is being created; try again in a minute\n')
    expect(orchestrator.calls()).toEqual([])
    expect(await withDb((db) => findAccountByGithubId(db, 15)?.status)).toBe('pending')
  })

  test('unblock restores it and does not start the install — the next sign-in or the operator does', async () => {
    await seed(11, 'nick')
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('nick')
    await run(['block', 'nick'], { orchestrator })

    const result = await run(['unblock', 'nick'], { orchestrator })

    expect(result.code).toBe(0)
    expect(result.out).toContain('its install starts on its next sign-in')
    expect(orchestrator.calls()).toEqual([{ method: 'stop', subdomain: 'nick' }])
    expect(await withDb((db) => findAccountByGithubId(db, 11))).toMatchObject({ status: 'active', stoppedAt: new Date(NOW).toISOString() })
  })

  test('both are idempotent and say so', async () => {
    await seed(12, 'olga', 'blocked')

    expect((await run(['block', 'olga'])).out).toContain('already blocked')
    await run(['unblock', 'olga'])
    expect((await run(['unblock', 'olga'])).out).toContain('not blocked')
  })

  test('an unknown login fails', async () => {
    const result = await run(['block', 'nobody'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('no account')
  })
})
