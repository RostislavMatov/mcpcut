import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, insertAccount, openAccountsDb, type AccountRecord } from '../../hub/src/accounts-db.js'
import { unavailableOrchestrator, type Orchestrator } from '../../hub/src/orchestrator.js'
import { createFakeOrchestrator } from './fake-orchestrator.js'
import { startServe, waitForOutput } from './serve-harness.js'

/**
 * `hub serve` settles the `pending` rows an earlier run left (plan
 * `hosted-path-and-ops`, Task A, P4): after it listens, every `pending`
 * account is checked with the provisioner — an install that exists makes the
 * account `active`, a missing one removes the row, a provisioner that cannot
 * answer leaves it `pending`. With no orchestrator nothing is asked. Output
 * is awaited by condition (`serve-harness.ts`), never by a fixed pause.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-serve-reconcile-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const dataDir = (): string => join(dir, 'data')

async function seedPending(accounts: ReadonlyArray<readonly [number, string]>): Promise<void> {
  const db = await openAccountsDb(dataDir())
  try {
    for (const [githubId, login] of accounts) {
      insertAccount(db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now: '2026-09-27T10:00:00.000Z' }, 100)
    }
  } finally {
    db.handle.close()
  }
}

async function readAccount(githubId: number): Promise<AccountRecord | null> {
  const db = await openAccountsDb(dataDir())
  try {
    return findAccountByGithubId(db, githubId)
  } finally {
    db.handle.close()
  }
}

async function serveUntil(orchestrator: Orchestrator, done: (out: string) => boolean): Promise<string> {
  const hub = await startServe(dir, dataDir(), { orchestrator })
  await waitForOutput(hub, done)
  expect(await hub.stop()).toBe(0)
  return hub.out()
}

describe('hub serve and pending accounts (P4)', () => {
  test('present → active, absent → removed, and the outcome is logged', async () => {
    await seedPending([
      [1, 'here'],
      [2, 'gone'],
    ])
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('here')

    const out = await serveUntil(orchestrator, (text) => text.includes('pending accounts settled'))

    expect(out).toContain('[hub] pending accounts settled: 1 activated, 1 discarded, 0 left pending')
    expect((await readAccount(1))?.status).toBe('active')
    expect(await readAccount(2)).toBeNull()
  })

  test('a provisioner that cannot answer leaves the account pending', async () => {
    await seedPending([[1, 'here']])
    const orchestrator = createFakeOrchestrator()
    orchestrator.fail('inspect', 'provisioner status: the provisioner could not be reached (ECONNREFUSED)')

    const out = await serveUntil(orchestrator, (text) => text.includes('pending accounts settled'))

    expect(out).toContain('install status for here unknown, left pending')
    expect((await readAccount(1))?.status).toBe('pending')
  })

  test('with no orchestrator nothing is asked and the row stays pending', async () => {
    await seedPending([[1, 'here']])

    const out = await serveUntil(unavailableOrchestrator, (text) => text.includes('listening on'))

    expect(out).not.toContain('pending accounts settled')
    expect((await readAccount(1))?.status).toBe('pending')
  })
})
