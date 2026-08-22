import { describe, expect, test } from 'vitest'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import type { UiSession } from '../../src/ui/auth.js'
import {
  createQuarantineHandlers,
  type QuarantineAuditEvent,
  type QuarantineHandlerDeps,
} from '../../src/ui/handlers/quarantine.js'
import { renderQuarantinePage, toQuarantineCards, type QuarantineCardView } from '../../src/ui/pages/quarantine.js'

/** Task 12 — quarantine page (structural diff) + approve/reject actions. */

const OPERATOR: UiSession = { adminName: 'alice', role: 'operator', csrfToken: 'csrf-abcdef-1234567890' }

function makeCtx(overrides: Partial<UiRequestContext> = {}): UiRequestContext {
  return {
    method: 'GET',
    path: '/quarantine',
    params: {},
    query: new URLSearchParams(),
    session: OPERATOR,
    body: Buffer.alloc(0),
    headers: {},
    ...overrides,
  }
}

function formBody(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString(), 'utf8')
}

function storeWithChangedTool(): InventoryStoreData {
  const before = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  const after = {
    type: 'object',
    properties: { title: { type: 'string' }, force: { type: 'boolean' } },
    required: ['title'],
  }
  return {
    version: 1,
    servers: {
      github: {
        approved: {
          create_issue: { schemaHash: 'h1', approvedAt: '2026-08-01T00:00:00.000Z', descriptor: { name: 'create_issue', inputSchema: before } },
        },
        quarantined: {
          create_issue: {
            schemaHash: 'h2',
            firstSeenAt: '2026-08-11T00:00:00.000Z',
            state: 'changed',
            descriptor: { name: 'create_issue', inputSchema: after },
          },
        },
      },
    },
  }
}

function bodyText(result: UiResult): string {
  if (result.kind !== 'response') throw new Error('expected a response result')
  const body = result.body ?? ''
  return typeof body === 'string' ? body : body.toString('utf8')
}

describe('toQuarantineCards structural diff', () => {
  test('computes an added-property change and a widened surface delta', () => {
    const cards = toQuarantineCards(storeWithChangedTool())
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card?.serverName).toBe('github')
    expect(card?.toolName).toBe('create_issue')
    expect(card?.surfaceDelta).toBe('widened')
    expect(card?.changes.some((c) => c.kind === 'property-added' && c.path === 'properties.force')).toBe(true)
  })

  test('a brand-new tool has no diff (nothing approved to compare against)', () => {
    const store: InventoryStoreData = {
      version: 1,
      servers: {
        github: {
          approved: {},
          quarantined: {
            danger: { schemaHash: 'h', firstSeenAt: '2026-08-11T00:00:00.000Z', state: 'new', descriptor: { name: 'danger' } },
          },
        },
      },
    }
    const cards = toQuarantineCards(store)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.state).toBe('new')
    expect(cards[0]?.changes).toHaveLength(0)
  })
})

function deps(overrides: Partial<QuarantineHandlerDeps> = {}): QuarantineHandlerDeps {
  return {
    readStore: async () => storeWithChangedTool(),
    approve: async () => true,
    reject: async () => true,
    ...overrides,
  }
}

describe('quarantinePage rendering', () => {
  test('renders the added property path and the surfaceDelta: widened label', async () => {
    const handlers = createQuarantineHandlers(deps())
    const html = bodyText(await handlers.quarantinePage(makeCtx()))
    expect(html).toContain('properties.force')
    expect(html).toContain('surfaceDelta: widened')
  })

  test('escapes a hostile tool name from a malicious server', async () => {
    const handlers = createQuarantineHandlers(
      deps({
        readStore: async () => ({
          version: 1,
          servers: {
            evil: {
              approved: {},
              quarantined: {
                '<script>x</script>': {
                  schemaHash: 'h',
                  firstSeenAt: '2026-08-11T00:00:00.000Z',
                  state: 'new',
                  descriptor: { name: '<script>x</script>', description: '<b>bad</b>' },
                },
              },
            },
          },
        }),
      }),
    )
    const html = bodyText(await handlers.quarantinePage(makeCtx()))
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('name="csrf_token"')
  })
})

describe('quarantineApprove / quarantineReject actions', () => {
  test('approve calls the store mutation and audits with the deciding admin', async () => {
    const audited: QuarantineAuditEvent[] = []
    const calls: Array<[string, string]> = []
    const handlers = createQuarantineHandlers(
      deps({
        approve: async (server, tool) => (calls.push([server, tool]), true),
        audit: (event) => audited.push(event),
      }),
    )
    const result = await handlers.quarantineApprove(
      makeCtx({ method: 'POST', path: '/quarantine/approve', body: formBody({ server: 'github', tool: 'create_issue', csrf_token: OPERATOR.csrfToken }) }),
    )
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(200)
    expect(calls).toEqual([['github', 'create_issue']])
    expect(audited).toEqual([{ action: 'approve', serverName: 'github', toolName: 'create_issue', adminName: 'alice' }])
  })

  test('reject calls the store mutation', async () => {
    const calls: Array<[string, string]> = []
    const handlers = createQuarantineHandlers(deps({ reject: async (server, tool) => (calls.push([server, tool]), true) }))
    const result = await handlers.quarantineReject(
      makeCtx({ method: 'POST', path: '/quarantine/reject', body: formBody({ server: 'github', tool: 'create_issue' }) }),
    )
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(200)
    expect(calls).toEqual([['github', 'create_issue']])
  })

  test('a missing server/tool field is a readable 400, not a 500', async () => {
    const handlers = createQuarantineHandlers(deps())
    const result = await handlers.quarantineApprove(makeCtx({ method: 'POST', path: '/quarantine/approve', body: formBody({ server: 'github' }) }))
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(400)
    expect(bodyText(result).length).toBeGreaterThan(0)
  })

  test('approving a tool that is not quarantined is a readable message, not a 500', async () => {
    const handlers = createQuarantineHandlers(deps({ approve: async () => false }))
    const result = await handlers.quarantineApprove(
      makeCtx({ method: 'POST', path: '/quarantine/approve', body: formBody({ server: 'github', tool: 'ghost' }) }),
    )
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).not.toBe(500)
    expect(bodyText(result).toLowerCase()).toContain('not')
  })

  test('a missing admin session fails closed and never mutates', async () => {
    const calls: Array<[string, string]> = []
    const handlers = createQuarantineHandlers(deps({ approve: async (s, t) => (calls.push([s, t]), true) }))
    const result = await handlers.quarantineApprove(
      makeCtx({ method: 'POST', path: '/quarantine/approve', session: undefined, body: formBody({ server: 'github', tool: 'create_issue' }) }),
    )
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe('McpCut quarantine page structure', () => {
  const CSRF = 'csrf-abcdef-1234567890'
  const changedCard: QuarantineCardView = {
    serverName: 'github',
    toolName: 'create_issue',
    state: 'changed',
    firstSeenAt: '2026-08-11T12:34:56.000Z',
    surfaceDelta: 'widened',
    changes: [{ kind: 'property-added', path: 'properties.force' }],
    truncated: false,
  }

  test('wraps the live region in a strong panel with the held count', () => {
    const doc = renderQuarantinePage({ cards: [changedCard], csrfToken: CSRF })
    expect(doc).toContain('class="panel panel-strong')
    expect(doc).toContain('1 held')
    expect(doc).toMatch(/<section[^>]*class="quarantine"[^>]*data-live-region="quarantine-changed"[^>]*data-live-src="\/quarantine"/)
    expect(doc).toContain('data-server="github"')
    expect(doc).toContain('data-tool="create_issue"')
    expect(doc).toContain('surfaceDelta: widened')
    // the widened delta is alert-styled, never a quiet note
    expect(doc).toMatch(/class="pill[^"]*pill-alert[^"]*surface-delta-widened"/)
  })

  test('the empty state text is unchanged', () => {
    expect(renderQuarantinePage({ cards: [], csrfToken: CSRF })).toContain('No quarantined tools.')
    expect(renderQuarantinePage({ cards: [], csrfToken: CSRF })).toContain('0 held')
  })

  test('a truncated diff shows the explicit, alert-styled marker (M5 lesson)', () => {
    const doc = renderQuarantinePage({ cards: [{ ...changedCard, truncated: true }], csrfToken: CSRF })
    expect(doc).toMatch(/class="pill pill-alert[^"]*">diff truncated</)
    expect(doc).toContain('incomplete')
  })

  test('a new tool blinks; a changed tool does not', () => {
    const fresh = renderQuarantinePage({
      cards: [{ serverName: 's', toolName: 't', state: 'new', firstSeenAt: '2026-08-11T00:00:00.000Z', changes: [], truncated: false }],
      csrfToken: CSRF,
    })
    expect(fresh).toMatch(/qr-state-new[^>]*>[^<]*<span class="dot dot-s dot-blink"/)
    expect(fresh).toContain('New tool — no prior schema to diff.')
    const changed = renderQuarantinePage({ cards: [changedCard], csrfToken: CSRF })
    expect(changed).not.toContain('dot-blink')
  })

  test('a hostile, over-long description is escaped and truncated with a visible marker', () => {
    const hostile = '<b>bad</b>' + 'x'.repeat(600)
    const doc = renderQuarantinePage({ cards: [{ ...changedCard, description: hostile }], csrfToken: CSRF })
    expect(doc).not.toContain('<b>bad</b>')
    expect(doc).toContain('&lt;b&gt;bad&lt;/b&gt;')
    expect(doc).not.toContain('x'.repeat(600))
    expect(doc).toContain('… (truncated)')
    expect(doc).toMatch(/class="pill pill-alert qr-trunc">… \(truncated\)</)
  })

  test('a short description is shown whole, without a marker', () => {
    const doc = renderQuarantinePage({ cards: [{ ...changedCard, description: 'Creates an issue.' }], csrfToken: CSRF })
    expect(doc).toContain('Creates an issue.')
    expect(doc).not.toContain('(truncated)')
  })

  test('approve is primary, reject is secondary; both carry server/tool/csrf', () => {
    const doc = renderQuarantinePage({ cards: [changedCard], csrfToken: CSRF })
    expect(doc).toMatch(/action="\/quarantine\/approve" data-action="\/quarantine\/approve"/)
    expect(doc).toMatch(/action="\/quarantine\/reject" data-action="\/quarantine\/reject"/)
    expect(doc).toMatch(/<button type="submit" class="secondary">Reject</)
    expect(doc).toContain('name="server" value="github"')
    expect(doc).toContain('name="tool" value="create_issue"')
    expect(doc).toContain(`name="csrf_token" value="${CSRF}"`)
  })
})
