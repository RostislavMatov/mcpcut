import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createVaultStore } from '../../src/vault/store.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
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

/**
 * `inventory` wires the OPTIONAL read port: with it the page lists each
 * server's tools; without it (the default) the page renders as before.
 */
function makeHarness(inventory?: InventoryStoreData): Harness {
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
    ...(inventory !== undefined ? { readInventory: async () => inventory } : {}),
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

/** A value the registry schema recognises as a secret literal (a GitHub PAT). */
const SECRET_LITERAL = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

/** The verbatim contents of a named `<textarea>` in a rendered document. */
function textareaValue(body: string, name: string): string | undefined {
  const match = new RegExp(`<textarea name="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(body)
  return match?.[1]
}

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

/** A hostile description: must reach the document escaped, never as markup. */
const HOSTILE_DESCRIPTION = '<img src=x onerror=alert(1)>'

/** An inventory with one approved and one quarantined tool on `github`. */
function githubInventory(overrides: { longDescription?: boolean } = {}): InventoryStoreData {
  const description = overrides.longDescription === true ? 'x'.repeat(1000) : 'Lists repositories'
  return {
    version: 1,
    servers: {
      github: {
        approved: {
          list_repos: {
            schemaHash: 'h-list',
            approvedAt: '2026-08-01T00:00:00.000Z',
            descriptor: { name: 'list_repos', description },
          },
        },
        quarantined: {
          create_issue: {
            schemaHash: 'h-create',
            firstSeenAt: '2026-08-02T00:00:00.000Z',
            state: 'new',
            descriptor: { name: 'create_issue', description: HOSTILE_DESCRIPTION },
          },
        },
      },
    },
  }
}

describe('serversPage — McpCut structure', () => {
  test('renders each server as a filterable disclosure card with its transport pill', async () => {
    h = makeHarness()
    await h.registry.addServer({
      name: 'github',
      transport: 'http',
      url: 'https://api.github.com',
      protocol: 'auto',
    })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('<details class="disclosure card srv-card" data-filter-item')
    expect(body).toContain('data-filter-text="github https://api.github.com http"')
    expect(body).toContain('data-filter-empty')
    expect(body).toContain('No server matches this search.')
    expect(body).toContain('placeholder="search servers — name, command, url"')
    expect(body).toContain('data-client-filter="1"')
  })

  test('lists tools from the inventory, marks quarantined ones and links them to /quarantine', async () => {
    h = makeHarness(githubInventory())
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('list_repos')
    expect(body).toContain('create_issue')
    expect(body).toContain('Lists repositories')
    expect(body).toContain('quarantined · new')
    expect(body).toContain('href="/quarantine"')
    expect(body).toContain('2 tools · 1 quarantined')
    // The card-level marker for a server holding quarantined tools.
    expect(body).toContain('shimmer')
  })

  test('escapes a hostile tool description instead of emitting it as markup', async () => {
    h = makeHarness(githubInventory())
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).not.toContain(HOSTILE_DESCRIPTION)
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('truncates a long tool description with a visible marker, never silently', async () => {
    h = makeHarness(githubInventory({ longDescription: true }))
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).not.toContain('x'.repeat(1000))
    expect(body).toContain('… (truncated)')
  })

  test('renders no tools panel and no counts when the inventory port is absent', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).not.toContain('srv-tools')
    expect(body).not.toContain('tools ·')
  })

  test('an owner gets the register drawer, the nav + action and the server count', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'a', transport: 'stdio', command: 'node' })
    await h.registry.addServer({ name: 'b', transport: 'stdio', command: 'node' })
    const body = String(asResponse(await h.handlers.serversPage(getCtx())).body)
    expect(body).toContain('<details class="drawer" id="add-server">')
    expect(body).toContain('data-open-details="add-server"')
    expect(body).toContain('2 servers')
    expect(body).toContain('action="/servers/add"')
    // Fixed vocabularies are pill radios, same names/values the handler parses.
    expect(body).toContain('<input type="radio" name="transport" value="stdio" checked>')
    expect(body).toContain('<input type="radio" name="transport" value="http">')
    expect(body).toContain('<input type="radio" name="protocol" value="auto" checked>')
  })

  test('a non-owner sees neither the drawer nor the nav + action nor a remove button', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'a', transport: 'stdio', command: 'node' })
    const viewer = getCtx({ session: { adminName: 'val', role: 'viewer', csrfToken: 'c' } })
    const body = String(asResponse(await h.handlers.serversPage(viewer)).body)
    expect(body).not.toContain('id="add-server"')
    expect(body).not.toContain('data-open-details')
    expect(body).not.toContain('>Remove<')
  })

  test('a rejected registration re-renders with the drawer OPEN and the error as an alert inside it', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({ csrf_token: OWNER.csrfToken, name: 'bad name!', transport: 'stdio', command: 'node' }),
      ),
    )
    expect(res.status).toBe(400)
    const body = String(res.body)
    const drawerStart = body.indexOf('<details class="drawer" id="add-server" open>')
    expect(drawerStart).toBeGreaterThan(-1)
    const alertAt = body.indexOf('role="alert"')
    expect(alertAt).toBeGreaterThan(drawerStart)
    expect(alertAt).toBeLessThan(body.indexOf('</details>', drawerStart))
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
          env: `GITHUB_TOKEN=${SECRET_LITERAL}`,
        }),
      ),
    )
    expect(res.status).toBe(400)
    const body = String(res.body)
    expect(body).toContain('looks like a secret literal')
    expect(body).toContain('mcp-journal vault set')
    // The rejected value must not survive anywhere in the response, not even
    // as a "helpfully" re-filled form field.
    expect(body).not.toContain(SECRET_LITERAL)
    // Nothing was persisted.
    expect(await h.registry.listServers()).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('restores every submitted field on a validation error except the secret-bearing one', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'secret-probe',
          transport: 'stdio',
          command: 'node',
          args: 'server.js,--flag',
          env: `LOG_LEVEL=debug\nX=${SECRET_LITERAL}`,
        }),
      ),
    )

    expect(res.status).toBe(400)
    const body = String(res.body)
    // Everything the operator typed comes back, so one field is corrected
    // instead of all eight being retyped.
    expect(body).toContain('<input name="name" value="secret-probe"')
    expect(body).toContain('<input name="command" value="node"')
    expect(body).toContain('<input name="args" value="server.js,--flag"')
    // ...except the one line the validator called a secret: it is dropped
    // whole, key included, and the secret is absent from the WHOLE body.
    expect(textareaValue(body, 'env')).toBe('LOG_LEVEL=debug')
    expect(body).not.toContain(SECRET_LITERAL)
  })

  test('keeps the chosen transport selected when the submission is rejected', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'gh',
          transport: 'http',
          url: 'https://api.github.com',
          protocol: 'auto',
          headers: `Authorization=${SECRET_LITERAL}`,
        }),
      ),
    )

    expect(res.status).toBe(400)
    const body = String(res.body)
    expect(body).toContain('<input type="radio" name="transport" value="http" checked>')
    expect(body).toContain('<input name="url" value="https://api.github.com"')
    expect(body).toContain('<input type="radio" name="protocol" value="auto" checked>')
    expect(textareaValue(body, 'headers')).toBe('')
    expect(body).not.toContain(SECRET_LITERAL)
  })

  test('restores the form when the registry itself refuses the (valid) record', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'dup', transport: 'stdio', command: 'node' })
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'dup',
          transport: 'stdio',
          command: 'node',
          confirm: 'true',
        }),
      ),
    )

    expect(res.status).toBe(400)
    expect(String(res.body)).toContain('<input name="name" value="dup"')
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

  test('the interstitial renders one argument per line, so a space inside one is unambiguous', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'local',
          transport: 'stdio',
          command: 'node',
          args: 'server.js,--flag with a space',
        }),
      ),
    )

    // This screen exists so a human can confirm the exact command line that
    // will be spawned; joining the vector with spaces makes one argument
    // holding a space indistinguishable from two arguments.
    expect(res.status).toBe(200)
    const body = String(res.body)
    expect(body).toContain('<li><code>server.js</code></li>')
    expect(body).toContain('<li><code>--flag with a space</code></li>')
    expect(body).not.toContain('server.js --flag with a space')
  })

  test('the interstitial escapes hostile arguments while listing them', async () => {
    h = makeHarness()
    const res = asResponse(
      await h.handlers.serversAdd(
        formPost({
          csrf_token: OWNER.csrfToken,
          name: 'evil',
          transport: 'stdio',
          command: 'node',
          args: '<script>alert(1)</script>,"><img src=x onerror=alert(2)>',
        }),
      ),
    )

    const body = String(res.body)
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;')
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
