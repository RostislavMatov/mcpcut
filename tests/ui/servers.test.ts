import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createVaultStore } from '../../src/vault/store.js'
import {
  createServersHandlers,
  type ServersHandlers,
  type UiAuditEvent,
} from '../../src/ui/handlers/servers.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * Server registry + read-only vault pages (M4 Task 13). Uses the real stores
 * (temp journal dir) so `serversAdd` goes through the SAME secret-literal
 * validation the CLI does, and the vault page reads the SAME `listSecrets`
 * (names + dates, never values).
 */

interface Harness {
  readonly dir: string
  readonly handlers: ServersHandlers
  readonly audit: UiAuditEvent[]
  readonly registry: ReturnType<typeof createRegistryStore>
  readonly agents: ReturnType<typeof createAgentsStore>
  readonly vault: ReturnType<typeof createVaultStore>
  dispose(): void
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ui-servers-'))
  const registry = createRegistryStore(dir)
  const agents = createAgentsStore({ journalDir: dir })
  const vault = createVaultStore({ journalDir: dir })
  const audit: UiAuditEvent[] = []
  const handlers = createServersHandlers({
    registry,
    agents,
    vault,
    audit: (event) => audit.push(event),
  })
  return {
    dir,
    handlers,
    audit,
    registry,
    agents,
    vault,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf-token-xyz' }

function getCtx(overrides: Partial<UiRequestContext> = {}): UiRequestContext {
  return {
    method: 'GET',
    path: '/servers',
    params: {},
    query: new URLSearchParams(),
    session: OWNER,
    body: Buffer.alloc(0),
    headers: {},
    ...overrides,
  }
}

function formPost(pairs: Record<string, string>, path = '/servers/add'): UiRequestContext {
  const body = Buffer.from(new URLSearchParams(pairs).toString(), 'utf8')
  return getCtx({
    method: 'POST',
    path,
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

let h: Harness | null = null
afterEach(() => {
  h?.dispose()
  h = null
})

describe('serversPage', () => {
  test('lists servers and shows vault references, never secret values', async () => {
    h = makeHarness()
    await h.registry.addServer({
      name: 'github',
      transport: 'http',
      url: 'https://api.github.com',
      headers: { Authorization: 'vault:gh-token' },
      protocol: 'auto',
    })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('github')
    expect(body).toContain('vault:gh-token')
  })

  test('escapes hostile env values instead of emitting raw markup', async () => {
    h = makeHarness()
    await h.registry.addServer({
      name: 'noisy',
      transport: 'stdio',
      command: 'node',
      env: { NOTE: '<script>alert(1)</script>' },
    })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('<script>alert(1)</script>')
  })

  test('embeds the session CSRF token in every mutating form', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'srv', transport: 'stdio', command: 'node' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('name="csrf_token" value="csrf-token-xyz"')
  })

  test('hides management controls from non-owners', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'srv', transport: 'stdio', command: 'node' })
    const viewer = getCtx({ session: { adminName: 'val', role: 'viewer', csrfToken: 'c' } })
    const body = String(asResponse(await h.handlers.serversPage(viewer)).body)
    expect(body).not.toContain('action="/servers/add"')
    expect(body).not.toContain('action="/servers/remove"')
  })
})

describe('serversAdd', () => {
  test('rejects a secret-looking literal with the same hint as the CLI', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'gh',
          transport: 'stdio',
          command: 'node',
          env: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        }),
      ),
    )
    expect(res.status).toBe(400)
    const body = String(res.body)
    expect(body).toContain('looks like a secret literal')
    expect(body).toContain('mcp-journal vault set')
    // Nothing was persisted.
    expect(await h.registry.listServers()).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('a valid submission without confirmation shows an interstitial and persists nothing', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'local',
          transport: 'stdio',
          command: 'node',
          args: 'server.js,--flag',
        }),
      ),
    )

    // Registering a stdio server is remote code execution by design: the plane
    // will later spawn exactly this command line. It is the same power as the
    // CLI's `server add`, so the browser path gets an explicit "this is what
    // will be run" step rather than a one-click form post.
    expect(res.status).toBe(200)
    const body = String(res.body)
    expect(body).toContain('node')
    expect(body).toContain('server.js')
    expect(body).toContain('name="confirm"')
    expect(await h.registry.listServers()).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('the interstitial escapes the command it echoes back', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'evil',
          transport: 'stdio',
          command: '<script>alert(1)</script>',
        }),
      ),
    )

    const body = String(res.body)
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
  })

  test('a rejected submission is rejected before the interstitial, not after it', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'gh',
          transport: 'stdio',
          command: 'node',
          env: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          confirm: 'true',
        }),
      ),
    )

    // Confirming must not be a way past validation.
    expect(res.status).toBe(400)
    expect(await h.registry.listServers()).toHaveLength(0)
  })

  test('persists a valid server, redirects, and attributes the mutation to the admin', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'local',
          transport: 'stdio',
          command: 'node',
          args: 'server.js,--flag',
          confirm: 'true',
        }),
      ),
    )
    expect(res.status).toBe(303)
    expect(res.headers?.location).toBe('/servers')
    const servers = await h.registry.listServers()
    expect(servers.map((s) => s.name)).toEqual(['local'])
    expect(h.audit).toEqual([
      { actor: 'ui', adminName: 'alice', action: 'server.add', target: 'local' },
    ])
  })

  test('accepts a vault reference as a header value', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'gh',
          transport: 'http',
          url: 'https://api.github.com',
          headers: 'Authorization=vault:gh-token',
          confirm: 'true',
        }),
      ),
    )
    expect(res.status).toBe(303)
    expect((await h.registry.listServers()).map((s) => s.name)).toEqual(['gh'])
  })
})

describe('serversRemove', () => {
  test('warns and lists agents when the server still has active grants', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'node' })
    await h.agents.createAgent('research-bot')
    await h.agents.grantServer('research-bot', 'github', ['read_file'])
    const res = asResponse(
      await h.handlers.serversRemove(formPost({ csrf_token: OWNER.csrfToken, name: 'github' }, '/servers/remove')),
    )
    expect(res.status).toBe(200)
    const body = String(res.body)
    expect(body).toContain('research-bot')
    expect(body).toContain('Remove anyway')
    // Not removed until confirmed.
    expect((await h.registry.listServers()).map((s) => s.name)).toEqual(['github'])
    expect(h.audit).toHaveLength(0)
  })

  test('removes despite grants when explicitly confirmed, and attributes it', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'node' })
    await h.agents.createAgent('research-bot')
    await h.agents.grantServer('research-bot', 'github', ['read_file'])
    const res = asResponse(
      await h.handlers.serversRemove(
        formPost({ csrf_token: OWNER.csrfToken, name: 'github', confirm: 'true' }, '/servers/remove'),
      ),
    )
    expect(res.status).toBe(303)
    expect(await h.registry.listServers()).toHaveLength(0)
    expect(h.audit).toEqual([
      { actor: 'ui', adminName: 'alice', action: 'server.remove', target: 'github' },
    ])
  })

  test('removes directly when no agent grants the server', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'solo', transport: 'stdio', command: 'node' })
    const res = asResponse(
      await h.handlers.serversRemove(formPost({ csrf_token: OWNER.csrfToken, name: 'solo' }, '/servers/remove')),
    )
    expect(res.status).toBe(303)
    expect(await h.registry.listServers()).toHaveLength(0)
  })

  test('answers 404 for an unknown server', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversRemove(formPost({ csrf_token: OWNER.csrfToken, name: 'ghost' }, '/servers/remove')),
    )
    expect(res.status).toBe(404)
  })
})

describe('vaultPage — names and dates only', () => {
  test('shows secret names and dates but never the value', async () => {
    h = makeHarness()
    await h.vault.init()
    await h.vault.setSecret('gh-token', 'ghp_super_secret_value_1234567890')
    const body = String(asResponse(await h.handlers.vaultPage(getCtx({ path: '/vault' }))).body)
    expect(body).toContain('gh-token')
    expect(body).not.toContain('ghp_super_secret_value_1234567890')
  })

  test('renders a notice when the vault is not initialized', async () => {
    h = makeHarness()
    const body = String(asResponse(await h.handlers.vaultPage(getCtx({ path: '/vault' }))).body)
    expect(body).toContain('not initialized')
  })

  test('the handlers module never references the vault value-resolution path', () => {
    const source = readFileSync(new URL('../../src/ui/handlers/servers.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('readSecretValues')
    expect(source).not.toContain('vault/resolve')
  })
})
