import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import type { AdminRecord } from '../../src/admin/store.js'
import type { ConsoleRunner } from '../../src/console-api/runner.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import type { AdminResolver, LoginRateLimiter } from '../../src/ui/auth.js'
import { handleConsoleRun, type ConsoleRunDeps } from '../../src/ui/console-run.js'
import { consoleErrorSchema, consoleRunFrameSchema } from '../../src/console-api/contract.js'
import { isTenantPathRefused, TENANT_PATH_REFUSED_MESSAGE } from '../../src/ui/console-tenant.js'

/**
 * ADR-0017 T6: the remote console's extra refusal on a TENANT install --
 * argv naming a path or a whole-host operation on the server -- on top of
 * its allowlist and role floor (`tests/ui/console-run.test.ts` covers those;
 * this suite exists only for the tenant layer). Style mirrors
 * `tests/ui/console-run-streaming.test.ts`: `handleConsoleRun` is called
 * directly against a fake request/response, since a real HTTP round trip adds
 * nothing this layer needs.
 */

const OWNER: AdminRecord = {
  name: 'alice',
  role: 'owner',
  tokenHash: 'x'.repeat(64),
  createdAt: '2026-09-19T00:00:00.000Z',
}

const TENANT: TenantSettings = {
  isTenant: true,
  stdioServers: 'refused',
  upstreams: 'public-https',
  limits: { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 },
}

const SELF_HOSTED: TenantSettings = {
  isTenant: false,
  stdioServers: 'allowed',
  upstreams: 'any',
  limits: {
    servers: 200,
    agents: 200,
    groups: 100,
    requestsPerSecond: Number.POSITIVE_INFINITY,
    requestsPerDay: Number.POSITIVE_INFINITY,
  },
}

function fakeRequest(body: unknown): IncomingMessage {
  const stream = new PassThrough()
  const req = stream as unknown as IncomingMessage
  Object.assign(req, {
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  stream.end(JSON.stringify(body))
  return req
}

/** Minimal fake `ServerResponse`: only what `console-run.ts` touches for a run that never streams. */
class FakeServerResponse {
  writableEnded = false
  destroyed = false
  readonly writes: string[] = []
  headWritten: { readonly status: number; readonly headers: Record<string, string> } | undefined

  writeHead(status: number, headers: Record<string, string>): void {
    this.headWritten = { status, headers }
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.writes.push(chunk)
    this.writableEnded = true
  }

  destroy(): void {
    this.destroyed = true
  }

  once(): void {
    // No backpressure is ever forced in this suite; nothing to wait for.
  }

  off(): void {}
}

function storeResolving(token: string, admin: AdminRecord): AdminResolver {
  return {
    findAdminByToken: async (candidate) => (candidate === token ? admin : undefined),
    getActiveAdmin: async () => admin,
  }
}

function alwaysAllow(): LoginRateLimiter {
  return {
    allow: () => true,
    penaltyMs: () => 0,
    recordFailure: () => undefined,
    recordSuccess: () => undefined,
    recordAuthenticated: () => undefined,
  }
}

function depsFor(runner: ConsoleRunner, tenant: TenantSettings): ConsoleRunDeps {
  return {
    adminStore: storeResolving('tok', OWNER),
    rateLimiter: alwaysAllow(),
    behindTls: false,
    maxBodyBytes: 65_536,
    runner,
    stderr: { write: () => undefined },
    tenant,
  }
}

/** Runs one argv and returns the response body's parsed frames or error. */
async function run(
  argv: readonly string[],
  tenant: TenantSettings,
  runner: ConsoleRunner = async () => 0,
): Promise<{ readonly res: FakeServerResponse; readonly ranTheCommand: boolean }> {
  let ranTheCommand = false
  const res = new FakeServerResponse()
  const req = fakeRequest({ argv })
  await handleConsoleRun(req, res as unknown as ServerResponse, depsFor(async (request, io) => {
    ranTheCommand = true
    return runner(request, io)
  }, tenant))
  return { res, ranTheCommand }
}

function errorBodyOf(res: FakeServerResponse): unknown {
  const written = res.writes.join('')
  return JSON.parse(written)
}

describe('isTenantPathRefused (unit)', () => {
  test('a self-hosted install (isTenant: false) never refuses anything', () => {
    expect(isTenantPathRefused(['backup', '/tmp/x'], SELF_HOSTED)).toBe(false)
    expect(isTenantPathRefused(['policy', 'validate', '/etc/passwd'], SELF_HOSTED)).toBe(false)
    expect(isTenantPathRefused(['export', '--out', '/tmp/x'], SELF_HOSTED)).toBe(false)
  })

  test.each(['backup', 'migrate', 'start', 'stop', 'logs'])(
    'refuses "%s" as a first word under tenant mode',
    (first) => {
      expect(isTenantPathRefused([first], TENANT)).toBe(true)
    },
  )

  test('refuses "policy validate" with or without an explicit path', () => {
    expect(isTenantPathRefused(['policy', 'validate'], TENANT)).toBe(true)
    expect(isTenantPathRefused(['policy', 'validate', '/etc/passwd'], TENANT)).toBe(true)
  })

  test('does not refuse "policy show" with no path flag', () => {
    expect(isTenantPathRefused(['policy', 'show'], TENANT)).toBe(false)
  })

  test.each(['--policy', '--out', '--report', '--pub'])('refuses a path flag "%s value" form', (flag) => {
    expect(isTenantPathRefused(['policy', 'show', flag, '/etc/passwd'], TENANT)).toBe(true)
  })

  test.each(['--policy', '--out', '--report', '--pub'])('refuses a path flag "%s=value" form', (flag) => {
    expect(isTenantPathRefused(['policy', 'show', `${flag}=/etc/passwd`], TENANT)).toBe(true)
  })

  test('a plain streaming export (no --out, no --report) is not refused', () => {
    expect(isTenantPathRefused(['export'], TENANT)).toBe(false)
  })

  test('export --report is refused even though the flag is boolean there, not a path value', () => {
    expect(isTenantPathRefused(['export', '--report'], TENANT)).toBe(true)
  })

  test('server add over https is not refused', () => {
    expect(isTenantPathRefused(['server', 'add', 'x', '--transport', 'http', '--url', 'https://x'], TENANT)).toBe(
      false,
    )
  })

  test('agent create is not refused', () => {
    expect(isTenantPathRefused(['agent', 'create', 'bot'], TENANT)).toBe(false)
  })

  test('approvals list is not refused', () => {
    expect(isTenantPathRefused(['approvals', 'list'], TENANT)).toBe(false)
  })
})

describe('handleConsoleRun over the wire, under tenant mode', () => {
  test('refuses "backup" before the runner is ever asked', async () => {
    const { res, ranTheCommand } = await run(['backup', '/tmp/x'], TENANT)
    expect(ranTheCommand).toBe(false)
    expect(res.headWritten?.status).toBe(403)
    const body = consoleErrorSchema.parse(errorBodyOf(res))
    expect(body.error).toBe('forbidden')
    expect(body.message).toBe(TENANT_PATH_REFUSED_MESSAGE)
  })

  test('refuses "policy validate <path>" before the runner is ever asked', async () => {
    const { res, ranTheCommand } = await run(['policy', 'validate', '/etc/passwd'], TENANT)
    expect(ranTheCommand).toBe(false)
    expect(res.headWritten?.status).toBe(403)
  })

  test('refuses "policy show --policy <path>" before the runner is ever asked', async () => {
    const { res, ranTheCommand } = await run(['policy', 'show', '--policy', '/etc/passwd'], TENANT)
    expect(ranTheCommand).toBe(false)
    expect(res.headWritten?.status).toBe(403)
  })

  test('refuses "verify --report <dir> --pub <path>" before the runner is ever asked', async () => {
    const { res, ranTheCommand } = await run(['verify', '--report', '/tmp/report', '--pub', '/tmp/key.pem'], TENANT)
    expect(ranTheCommand).toBe(false)
    expect(res.headWritten?.status).toBe(403)
  })

  test('a plain streaming "export" (no --out, no --report) runs', async () => {
    const { res, ranTheCommand } = await run(['export'], TENANT, async (_request, io) => {
      io.stdout.write('line\n')
      return 0
    })
    expect(ranTheCommand).toBe(true)
    const lastFrame = consoleRunFrameSchema.parse(JSON.parse(res.writes.at(-1) ?? '{}'))
    expect(lastFrame).toEqual({ t: 'exit', code: 0 })
  })

  test('"server add" over https runs', async () => {
    const { ranTheCommand } = await run(
      ['server', 'add', 'x', '--transport', 'http', '--url', 'https://example.com'],
      TENANT,
    )
    expect(ranTheCommand).toBe(true)
  })

  test('"agent create" runs', async () => {
    const { ranTheCommand } = await run(['agent', 'create', 'bot'], TENANT)
    expect(ranTheCommand).toBe(true)
  })

  test('"approvals list" runs', async () => {
    const { ranTheCommand } = await run(['approvals', 'list'], TENANT)
    expect(ranTheCommand).toBe(true)
  })

  test('without tenant mode, "backup" is not refused by this gate (falls through to the role floor)', async () => {
    const { ranTheCommand } = await run(['backup', '/tmp/x'], SELF_HOSTED)
    expect(ranTheCommand).toBe(true)
  })

  test('without tenant mode, "policy validate <path>" runs as before', async () => {
    const { ranTheCommand } = await run(['policy', 'validate', '/etc/passwd'], SELF_HOSTED)
    expect(ranTheCommand).toBe(true)
  })

  test('the default (no `tenant` in deps) resolves the real process TENANT_SETTINGS, not a hardcoded refusal', async () => {
    // This test's own process runs self-hosted (no `tenant` section in its
    // config), so omitting the field entirely must behave like SELF_HOSTED.
    const res = new FakeServerResponse()
    const req = fakeRequest({ argv: ['backup', '/tmp/x'] })
    let ranTheCommand = false
    const deps: ConsoleRunDeps = {
      adminStore: storeResolving('tok', OWNER),
      rateLimiter: alwaysAllow(),
      behindTls: false,
      maxBodyBytes: 65_536,
      runner: async () => {
        ranTheCommand = true
        return 0
      },
      stderr: { write: () => undefined },
    }
    await handleConsoleRun(req, res as unknown as ServerResponse, deps)
    expect(ranTheCommand).toBe(true)
  })
})
