import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, insertAccount, openAccountsDb, setStatus, type AccountRecord } from '../../hub/src/accounts-db.js'
import { runHubCli, type HubCliIo } from '../../hub/src/cli.js'
import { unavailableOrchestrator } from '../../hub/src/orchestrator.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'

/**
 * The operator's `sweep [--dry-run]` (plan `hosted-path-and-ops`, Task C):
 * one idle sweep from the host's shell, against the same `HUB_DATA_DIR` and
 * provisioner the running hub uses. `--dry-run` prints what a sweep would do
 * and changes nothing. `pending` accounts are left to the running hub, which
 * alone knows which of them it is still creating.
 */

const NOW = Date.parse('2026-09-27T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

let dir: string
let orchestrator: FakeOrchestrator

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-cli-sweep-test-'))
  orchestrator = createFakeOrchestrator()
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
    orchestrator,
    ...io,
  })
  return { code, out, err }
}

async function seed(githubId: number, login: string, seenDaysAgo: number, status: 'active' | 'pending' = 'active'): Promise<void> {
  const db = await openAccountsDb(dir)
  try {
    const now = new Date(NOW - seenDaysAgo * DAY_MS).toISOString()
    insertAccount(db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now }, 100)
    if (status === 'active') setStatus(db, githubId, 'active')
  } finally {
    db.handle.close()
  }
  orchestrator.addInstall(login)
}

async function read(githubId: number): Promise<AccountRecord | null> {
  const db = await openAccountsDb(dir)
  try {
    return findAccountByGithubId(db, githubId)
  } finally {
    db.handle.close()
  }
}

describe('sweep --dry-run', () => {
  test('prints each decision and changes nothing', async () => {
    await seed(1, 'gone', 91)
    await seed(2, 'idle', 61)
    await seed(3, 'fresh', 1)

    const { code, out } = await run(['sweep', '--dry-run'])

    expect(code).toBe(0)
    expect(out).toContain('[hub] idle sweep (dry run): @gone (gone) idle 91 d — would be removed with its account (no tombstone)')
    expect(out).toContain('[hub] idle sweep (dry run): @idle (idle) idle 61 d — would be stopped')
    expect(out).toContain('[hub] idle sweep (dry run): @fresh (fresh) idle 1 d — kept')
    expect(out).toContain('3 account(s) swept (dry run: nothing changed)')
    expect(orchestrator.calls().map((call) => call.method)).toEqual(['inspect', 'inspect', 'inspect'])
    expect(await read(1)).not.toBeNull()
    expect((await read(2))?.stoppedAt).toBeNull()
  })
})

describe('sweep', () => {
  test('stops and removes, and leaves pending accounts to the running hub', async () => {
    await seed(1, 'gone', 91)
    await seed(2, 'idle', 61)
    await seed(4, 'making', 400, 'pending')

    const { code, out } = await run(['sweep'])

    expect(code).toBe(0)
    expect(await read(1)).toBeNull()
    expect((await read(2))?.stoppedAt).toBe(new Date(NOW).toISOString())
    expect((await read(4))?.status).toBe('pending')
    expect(out).toContain('2 account(s) swept; pending accounts are settled by the running hub')
  })

  test('`list` then shows when an install was stopped', async () => {
    await seed(2, 'idle', 61)
    await run(['sweep'])

    const { out } = await run(['list'])

    expect(out).toContain('\tstopped\n')
    expect(out).toMatch(new RegExp(`idle\\tidle\\tactive\\t.*\\t${new Date(NOW).toISOString()}\\n`))
  })

  test('a failed account makes the command exit 1, after the others are swept', async () => {
    await seed(1, 'gone', 91)
    await seed(2, 'idle', 61)
    orchestrator.fail('remove')

    const { code } = await run(['sweep'])

    expect(code).toBe(1)
    expect((await read(2))?.stoppedAt).not.toBeNull()
  })

  test('without a provisioner there is nothing to sweep with', async () => {
    const { code, err } = await run(['sweep'], { orchestrator: unavailableOrchestrator })

    expect(code).toBe(1)
    expect(err).toContain('sweep needs the provisioner')
  })

  test('an unknown argument is a usage error', async () => {
    const { code, err } = await run(['sweep', '--force'])

    expect(code).toBe(2)
    expect(err).toContain('usage: sweep [--dry-run]')
  })
})
