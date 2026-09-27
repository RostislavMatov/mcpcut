import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  findAccountByGithubId,
  insertAccount,
  openAccountsDb,
  type AccountRecord,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'
import type { GithubClient, GithubProfile } from '../../hub/src/github.js'
import { createOauthFlows, type OauthFlows } from '../../hub/src/oauth-flow.js'
import { unavailableOrchestrator } from '../../hub/src/orchestrator.js'
import { createWindowCounter } from '../../hub/src/rate-limit.js'
import { completeCallback, type SigninDeps } from '../../hub/src/signin.js'
import { RESERVED_SUBDOMAINS } from '../../hub/src/subdomain.js'
import { createFakeOrchestrator } from './fake-orchestrator.js'

/**
 * `completeCallback` against a stub GitHub client — for the branches a real
 * (fake-server) GitHub cannot reach: a client that throws something other
 * than `GithubError`, a login whose every subdomain is taken, a pending row
 * left behind by a crash.
 */

const NOW = Date.parse('2026-09-27T10:00:00.000Z')

let dir: string
let db: AccountsDb
let flows: OauthFlows
let logs: string[]
let started: AccountRecord[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-signin-test-'))
  db = await openAccountsDb(dir)
  flows = createOauthFlows({ clock: () => NOW })
  logs = []
  started = []
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function stubGithub(overrides: Partial<GithubClient> = {}, profile?: GithubProfile): GithubClient {
  return {
    authorizeUrl: () => 'https://github.example/authorize',
    exchangeCode: async () => 'gho_stub',
    fetchProfile: async () => profile ?? { id: 1, login: 'alice', createdAt: '2019-01-01T00:00:00Z' },
    revokeToken: async () => undefined,
    close: () => undefined,
    ...overrides,
  }
}

function deps(github: GithubClient, overrides: Partial<SigninDeps> = {}): SigninDeps {
  return {
    db,
    github,
    orchestrator: createFakeOrchestrator(),
    provisioning: {
      start: (account) => {
        started.push(account)
        return true
      },
    },
    flows,
    signups: createWindowCounter({ windowMs: 3_600_000, clock: () => NOW }),
    maxAccounts: 15,
    minAccountAgeDays: 30,
    signupsPerHourPerIp: 3,
    clock: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  }
}

function callbackQuery(): { query: URLSearchParams; flowId: string; ip: string } {
  const flow = flows.begin()
  return { query: new URLSearchParams({ code: 'the-code', state: flow.state }), flowId: flow.flowId, ip: '192.0.2.1' }
}

describe('completeCallback', () => {
  test('a client failure that is not a GithubError is try again, logged without detail', async () => {
    const github = stubGithub({
      exchangeCode: () => Promise.reject(new Error('socket said gho_secret_in_message')),
    })

    const outcome = await completeCallback(deps(github), callbackQuery())

    expect(outcome).toEqual({ kind: 'refused', reason: { kind: 'try-again' }, status: 502 })
    expect(logs.join('\n')).not.toContain('gho_secret_in_message')
  })

  test('a revocation that throws something odd is logged without detail and sign-in continues', async () => {
    const github = stubGithub({ revokeToken: () => Promise.reject(new Error('gho_leaky')) })

    const outcome = await completeCallback(deps(github), callbackQuery())

    expect(outcome.kind).toBe('preparing')
    expect(logs.join('\n')).toContain('revocation failed')
    expect(logs.join('\n')).not.toContain('gho_leaky')
  })

  test('a new person gets a pending account and a background install, not a wait', async () => {
    const orchestrator = createFakeOrchestrator()

    const outcome = await completeCallback(deps(stubGithub(), { orchestrator }), callbackQuery())

    expect(outcome).toMatchObject({ kind: 'preparing', account: { githubId: 1, subdomain: 'alice', status: 'pending' } })
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
    expect(started.map((account) => account.githubId)).toEqual([1])
    // The callback itself never calls the orchestrator: the background task does.
    expect(orchestrator.calls()).toEqual([])
  })

  test('a hub shutting down still reserves the seat and leaves the install for the next start', async () => {
    const outcome = await completeCallback(deps(stubGithub(), { provisioning: { start: () => false } }), callbackQuery())

    expect(outcome.kind).toBe('preparing')
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
    expect(logs.join('\n')).toContain('install left for the next start')
  })

  test('a login whose every subdomain is taken is try again, not a crash', async () => {
    const github = stubGithub({}, { id: 9, login: 'www', createdAt: '2019-01-01T00:00:00Z' })
    expect(RESERVED_SUBDOMAINS.has('www')).toBe(true)
    for (let suffix = 2; suffix <= 200; suffix += 1) {
      const subdomain = `www-${suffix}`
      insertAccount(db, { githubId: 1000 + suffix, login: subdomain, subdomain, githubCreatedAt: '2019-01-01T00:00:00Z', now: new Date(NOW).toISOString() }, 1000)
    }

    const outcome = await completeCallback(deps(github, { maxAccounts: 1000 }), callbackQuery())

    expect(outcome).toEqual({ kind: 'refused', reason: { kind: 'try-again' }, status: 409 })
    expect(findAccountByGithubId(db, 9)).toBeNull()
  })

  test('a pending row left by a crash signs its owner in rather than creating twice', async () => {
    insertAccount(db, { githubId: 1, login: 'alice', subdomain: 'alice', githubCreatedAt: '2019-01-01T00:00:00Z', now: new Date(NOW).toISOString() }, 15)
    const orchestrator = createFakeOrchestrator()

    const outcome = await completeCallback(deps(stubGithub(), { orchestrator }), callbackQuery())

    expect(outcome.kind).toBe('signed-in')
    expect(orchestrator.calls()).toEqual([])
    expect(started).toEqual([])
  })

  test('an unparsable GitHub creation date fails closed as try again', async () => {
    const github = stubGithub({}, { id: 2, login: 'bob', createdAt: 'not-a-date' })

    const outcome = await completeCallback(deps(github), callbackQuery())

    expect(outcome).toEqual({ kind: 'refused', reason: { kind: 'try-again' }, status: 403 })
  })

  test('with the unavailable orchestrator a new person is waitlisted', async () => {
    const outcome = await completeCallback(deps(stubGithub(), { orchestrator: unavailableOrchestrator }), callbackQuery())

    expect(outcome).toEqual({ kind: 'waitlist', position: 1 })
  })
})

describe('unavailableOrchestrator', () => {
  test('is not available and every method rejects', async () => {
    expect(unavailableOrchestrator.available).toBe(false)
    await expect(unavailableOrchestrator.create({ githubId: 1, login: 'a', subdomain: 'a' })).rejects.toThrow(/unavailable/)
    await expect(unavailableOrchestrator.rotateOwnerToken('a')).rejects.toThrow(/unavailable/)
    await expect(unavailableOrchestrator.remove('a')).rejects.toThrow(/unavailable/)
    await expect(unavailableOrchestrator.inspect('a')).rejects.toThrow(/unavailable/)
    await expect(unavailableOrchestrator.stop('a')).rejects.toThrow(/unavailable/)
    await expect(unavailableOrchestrator.start('a')).rejects.toThrow(/unavailable/)
  })
})
