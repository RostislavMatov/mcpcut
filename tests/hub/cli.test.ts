import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  deleteAccount,
  findAccountByGithubId,
  findTombstone,
  insertAccount,
  joinWaitlist,
  openAccountsDb,
  setStatus,
} from '../../hub/src/accounts-db.js'
import { runHubCli, type HubCliIo } from '../../hub/src/cli.js'
import { createFakeOrchestrator } from './fake-orchestrator.js'

/**
 * `hub/src/cli.ts` (plan Task 5, H7): `serve` and the operator commands the
 * host's shell runs — `list`, `delete`, `purge-tombstones` (`block`/`unblock`:
 * `cli-block.test.ts`; `sweep`: `cli-sweep.test.ts`).
 * Operator commands need only `HUB_DATA_DIR`; `serve` needs the whole config.
 */

const NOW = Date.parse('2026-09-27T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-cli-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function run(argv: readonly string[], io: Partial<HubCliIo> = {}): Promise<Run> {
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

async function seed(githubId: number, login: string, status: 'active' | 'blocked' = 'active'): Promise<void> {
  const db = await openAccountsDb(dir)
  try {
    const now = new Date(NOW - DAY_MS).toISOString()
    insertAccount(db, { githubId, login, subdomain: login.toLowerCase(), githubCreatedAt: '2019-01-01T00:00:00Z', now }, 100)
    setStatus(db, githubId, status)
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

describe('usage', () => {
  test('no command or an unknown one prints usage and exits 2', async () => {
    for (const argv of [[], ['frobnicate']]) {
      const result = await run(argv)

      expect(result.code).toBe(2)
      expect(result.err).toContain('usage:')
    }
  })

  test('an operator command without HUB_DATA_DIR fails with one line', async () => {
    const result = await run(['list'], { env: {} })

    expect(result.code).toBe(1)
    expect(result.err).toContain('HUB_DATA_DIR')
  })

  test('a login argument is required where one is expected', async () => {
    const result = await run(['block'])

    expect(result.code).toBe(2)
  })
})

describe('list', () => {
  test('prints every account without any token, and the waitlist size', async () => {
    await seed(1, 'alice')
    await seed(2, 'bob', 'blocked')
    await withDb((db) => joinWaitlist(db, { githubId: 3, login: 'carol', now: new Date(NOW).toISOString() }))

    const result = await run(['list'])

    expect(result.code).toBe(0)
    expect(result.out).toMatch(/alice\s+alice\s+active/)
    expect(result.out).toMatch(/bob\s+bob\s+blocked/)
    expect(result.out).toContain('waitlist: 1')
  })

  test('an empty hub says so', async () => {
    const result = await run(['list'])

    expect(result.out).toContain('no accounts')
  })
})

describe('delete', () => {
  test('deletes with a 30-day tombstone and notes the pending install removal', async () => {
    await seed(20, 'paul')

    const result = await run(['delete', 'paul'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('install removal pending orchestrator')
    expect(await withDb((db) => findAccountByGithubId(db, 20))).toBeNull()
    expect(await withDb((db) => findTombstone(db, 20)?.reason)).toBe('deleted')
  })

  test('a blocked account leaves a permanent blocked tombstone', async () => {
    await seed(21, 'quinn', 'blocked')

    await run(['delete', 'quinn'])

    expect(await withDb((db) => findTombstone(db, 21)?.reason)).toBe('blocked')
  })

  test('with an available orchestrator the install is removed first', async () => {
    await seed(22, 'rita')
    const orchestrator = createFakeOrchestrator()

    const result = await run(['delete', 'rita'], { orchestrator })

    expect(result.code).toBe(0)
    expect(orchestrator.calls()).toEqual([{ method: 'remove', subdomain: 'rita' }])
  })

  test('a failed install removal keeps the account', async () => {
    await seed(23, 'sam')
    const orchestrator = createFakeOrchestrator()
    orchestrator.fail('remove')

    const result = await run(['delete', 'sam'], { orchestrator })

    expect(result.code).toBe(1)
    expect(result.err).toContain('account kept')
    expect(await withDb((db) => findAccountByGithubId(db, 23))).not.toBeNull()
  })

  test('a token quoted in the removal error is redacted on stderr', async () => {
    await seed(24, 'tess')
    const orchestrator = createFakeOrchestrator()
    const leaked = 'mcpo_operatorLeak0123456789'
    orchestrator.fail('remove', `teardown refused for ${leaked}`)

    const result = await run(['delete', 'tess'], { orchestrator })

    expect(result.code).toBe(1)
    expect(result.err).toContain('[redacted]')
    expect(`${result.out}${result.err}`).not.toContain(leaked)
  })

  test('an unknown login fails', async () => {
    expect((await run(['delete', 'nobody'])).code).toBe(1)
  })
})

describe('purge-tombstones', () => {
  test('removes deleted tombstones past the 30-day cooldown only', async () => {
    await seed(30, 'old')
    await seed(31, 'new')
    await withDb((db) => {
      deleteAccount(db, 30, 'deleted', new Date(NOW - 31 * DAY_MS).toISOString())
      deleteAccount(db, 31, 'deleted', new Date(NOW - DAY_MS).toISOString())
    })

    const result = await run(['purge-tombstones'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('purged 1')
    expect(await withDb((db) => findTombstone(db, 30))).toBeNull()
    expect(await withDb((db) => findTombstone(db, 31))).not.toBeNull()
  })
})

describe('serve', () => {
  async function serveEnv(): Promise<NodeJS.ProcessEnv> {
    const secretFile = join(dir, 'github-client-secret')
    await writeFile(secretFile, 'the-client-secret-value\n')
    await chmod(secretFile, 0o600)
    return {
      HUB_PUBLIC_URL: 'https://mcpcut.test',
      HUB_GITHUB_CLIENT_ID: 'Ov23liTestClientId',
      HUB_GITHUB_CLIENT_SECRET_FILE: secretFile,
      HUB_DATA_DIR: join(dir, 'data'),
      HUB_PORT: '0',
    }
  }

  test('an invalid config lists every problem and exits 1 without listening', async () => {
    const result = await run(['serve'], { env: { HUB_PUBLIC_URL: 'http://insecure' } })

    expect(result.code).toBe(1)
    expect(result.err).toContain('HUB_PUBLIC_URL')
    expect(result.err).toContain('HUB_GITHUB_CLIENT_ID')
  })

  test('listens, answers /healthz, announces the waitlist mode, and stops on shutdown', async () => {
    let stop: () => void = () => undefined
    const shutdown = new Promise<void>((resolve) => (stop = resolve))
    let out = ''
    const running = runHubCli(['serve'], {
      env: await serveEnv(),
      stdout: (text) => (out += text),
      stderr: (text) => (out += text),
      shutdown,
    })
    const port = await waitForPort(() => out)

    const health = await get(port, '/healthz')
    stop()

    expect(health).toBe(200)
    expect(await running).toBe(0)
    expect(out).toContain('orchestrator not available')
    expect(out).not.toContain('the-client-secret-value')
    expect(out).not.toContain('CF-Connecting-IP')
  })

  test('trusting CF-Connecting-IP is announced loudly on stderr', async () => {
    let stop: () => void = () => undefined
    const shutdown = new Promise<void>((resolve) => (stop = resolve))
    let out = ''
    let err = ''
    const running = runHubCli(['serve'], {
      env: { ...(await serveEnv()), HUB_TRUST_CF_CONNECTING_IP: '1' },
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      shutdown,
    })
    await waitForPort(() => out)
    stop()

    expect(await running).toBe(0)
    expect(err).toContain(
      'warning: HUB_TRUST_CF_CONNECTING_IP=1 trusts the CF-Connecting-IP header — turn on Cloudflare Authenticated Origin Pulls (docs/deploy/site/Caddyfile), or anyone reaching the origin directly can forge it and bypass the per-IP sign-up limit\n',
    )
    expect(out).not.toContain('CF-Connecting-IP')
  })
})

describe('the provisioner link (tenant-orchestrator Task 5)', () => {
  const PROVISIONER_SECRET = 'k'.repeat(40)

  async function linkEnv(url: string): Promise<NodeJS.ProcessEnv> {
    const tokenFile = join(dir, 'provisioner-token')
    await writeFile(tokenFile, PROVISIONER_SECRET)
    await chmod(tokenFile, 0o600)
    return { HUB_PROVISIONER_URL: url, HUB_PROVISIONER_TOKEN_FILE: tokenFile }
  }

  test('serve with a provisioner configured announces it instead of the waitlist', async () => {
    let stop: () => void = () => undefined
    const shutdown = new Promise<void>((resolve) => (stop = resolve))
    let out = ''
    const secretFile = join(dir, 'github-client-secret')
    await writeFile(secretFile, 'the-client-secret-value\n')
    await chmod(secretFile, 0o600)
    const running = runHubCli(['serve'], {
      env: {
        HUB_PUBLIC_URL: 'https://mcpcut.test',
        HUB_GITHUB_CLIENT_ID: 'Ov23liTestClientId',
        HUB_GITHUB_CLIENT_SECRET_FILE: secretFile,
        HUB_DATA_DIR: join(dir, 'data'),
        HUB_PORT: '0',
        ...(await linkEnv('http://provisioner.internal:8093')),
      },
      stdout: (text) => (out += text),
      stderr: (text) => (out += text),
      shutdown,
    })
    await waitForPort(() => out)
    stop()

    expect(await running).toBe(0)
    expect(out).toContain('[hub] orchestrator: the provisioner at http://provisioner.internal:8093')
    expect(out).not.toContain('waitlist')
    expect(out).not.toContain(PROVISIONER_SECRET)
  })

  test('an operator delete removes the install through the provisioner', async () => {
    await seed(40, 'vera')
    const seen: string[] = []
    const stub = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`)
      res.writeHead(204).end()
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const address = stub.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const result = await run(['delete', 'vera'], { env: { HUB_DATA_DIR: dir, ...(await linkEnv(`http://127.0.0.1:${port}`)) } })

      expect(result.code).toBe(0)
      expect(seen).toEqual([`DELETE /tenants/vera Bearer ${PROVISIONER_SECRET}`])
      expect(await withDb((db) => findAccountByGithubId(db, 40))).toBeNull()
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()))
    }
  })

  test('a half-configured link stops an operator command with one line', async () => {
    const result = await run(['list'], { env: { HUB_DATA_DIR: dir, HUB_PROVISIONER_URL: 'http://p:1' } })

    expect(result.code).toBe(1)
    expect(result.err).toBe('hub: HUB_PROVISIONER_URL and HUB_PROVISIONER_TOKEN_FILE must be set together, or neither\n')
  })
})

async function waitForPort(read: () => string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = /listening on http:\/\/[^:]+:(\d+)/.exec(read())
    if (match?.[1] !== undefined) return Number(match[1])
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`hub never announced its port: ${read()}`)
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}
