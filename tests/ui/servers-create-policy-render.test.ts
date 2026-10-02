import { describe, expect, test } from 'vitest'
import { CREATED_POLICY_DOCUMENT } from '../../src/policy/edit/created-policy.js'
import type { PolicyView } from '../../src/policy/edit/policy-view.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy } from '../../src/policy/schema.js'
import { TENANT_SETTINGS } from '../../src/tenant/settings.js'
import { renderServersPage, toServerToolsByName } from '../../src/ui/pages/servers.js'

/**
 * The Servers page with no policy (ADR-0009 O4, amendment 2026-10-02): the
 * empty state says how to fill it — for an owner, one button that writes the
 * allow-everything starter, with the file and its content shown before the
 * click; for anyone else, who can do it. Nothing of it on a loaded policy or
 * a hosted install.
 */

const OWNER = { name: 'alice', role: 'owner' } as const
const VIEWER = { name: 'vic', role: 'viewer' } as const
const PATH = '/home/op/.mcpcut/data/policy.json'

const ABSENT: PolicyView = { status: 'absent', sourcePath: PATH, readers: { kind: 'every-entry-point' } }

function loadedView(): PolicyView {
  const parsed = parsePolicy({ version: 1 })
  if (!parsed.ok) throw new Error('bad fixture')
  return { ...ABSENT, status: 'loaded', policy: parsed.policy, hash: policyHashOf(parsed.policy) }
}

interface PageOptions {
  readonly policyView?: PolicyView
  readonly isOwner?: boolean
  readonly isTenant?: boolean
}

function page(options: PageOptions = {}): string {
  const isOwner = options.isOwner ?? true
  return renderServersPage({
    servers: [],
    canManage: isOwner,
    csrfToken: 'csrf-token-value',
    currentAdmin: isOwner ? OWNER : VIEWER,
    policyView: options.policyView ?? ABSENT,
    ...(options.isTenant === true ? { tenant: { ...TENANT_SETTINGS, isTenant: true } } : {}),
  })
}

/** The create form, or undefined. */
function createForm(document: string): string | undefined {
  return /<form method="post" action="\/servers\/create-policy"[^>]*>[\s\S]*?<\/form>/.exec(document)?.[0]
}

describe('no policy, owner', () => {
  test('one native form posts to /servers/create-policy with the CSRF field and a Create policy button', () => {
    const form = createForm(page())
    expect(form).toBeDefined()
    expect(form).toContain('<input type="hidden" name="csrf_token" value="csrf-token-value" />')
    expect(form).toContain('<button type="submit">Create policy</button>')
    // Native post: the answer is a page that carries the next step, not a fetch.
    expect(form).not.toContain('data-action')
  })

  test('says what mcpcut does now, what the button changes, and what it writes where', () => {
    const document = page()
    expect(document).toContain('No policy yet — mcpcut only journals')
    expect(document).toContain('It allows every call, so nothing changes until you choose')
    expect(document).toContain(`Writes <code>${PATH}</code>`)
    expect(document).toContain(`<code>${JSON.stringify(CREATED_POLICY_DOCUMENT).replace(/"/g, '&quot;')}</code>`)
  })

  test('the callout sits above the cards, once', () => {
    const document = page()
    expect(document.split('action="/servers/create-policy"')).toHaveLength(2)
    expect(document.indexOf('srv-policy-create')).toBeLessThan(document.indexOf('srv-policy-sources'))
  })
})

describe('no policy, not an owner', () => {
  test('no form; the line names who can create it', () => {
    const document = page({ isOwner: false })
    expect(createForm(document)).toBeUndefined()
    expect(document).toContain('No policy yet — mcpcut only journals. An owner can create one on this page.')
  })
})

describe('nothing to create', () => {
  test('a loaded policy shows no callout', () => {
    const document = page({ policyView: loadedView() })
    expect(document).not.toContain('srv-policy-create')
  })

  test('an invalid policy keeps its banner and offers no create', () => {
    const document = page({ policyView: { ...ABSENT, status: 'error', errors: ['version: expected 1'] } })
    expect(createForm(document)).toBeUndefined()
    expect(document).toContain('srv-policy-banner')
  })

  test('a hosted (tenant) install offers no create', () => {
    const document = page({ isTenant: true })
    expect(document).not.toContain('srv-policy-create')
  })

  test('a page with no policy port shows no callout', () => {
    const document = renderServersPage({ servers: [], canManage: true, csrfToken: 'c', currentAdmin: OWNER })
    expect(document).not.toContain('srv-policy-create')
  })
})

describe('after Create policy: quarantine off means nothing shows as quarantined', () => {
  const inventory: InventoryStoreData = {
    version: 1,
    servers: {
      fs: {
        approved: {},
        quarantined: {
          write_file: {
            state: 'new',
            schemaHash: 'h',
            detectedAt: '2026-10-02T00:00:00.000Z',
            descriptor: { name: 'write_file', description: 'Writes a file', inputSchema: { type: 'object' } },
          },
        },
      },
    },
  }

  function toolsOf(raw: object) {
    const parsed = parsePolicy(raw)
    if (!parsed.ok) throw new Error('bad fixture')
    return toServerToolsByName(inventory, parsed.policy).get('fs')
  }

  test('the starter (quarantine off): no quarantined state, a zero count', () => {
    const tools = toolsOf(CREATED_POLICY_DOCUMENT)
    expect(tools?.quarantinedCount).toBe(0)
    expect(tools?.tools[0]?.quarantined).toBeUndefined()
  })

  test('quarantine on (the default): the state and the count are shown as before', () => {
    const tools = toolsOf({ version: 1, defaultDecision: 'allow' })
    expect(tools?.quarantinedCount).toBe(1)
    expect(tools?.tools[0]?.quarantined).toBe('new')
  })
})

describe('no registered server: the empty state names where adopted servers show up', () => {
  const LINE = 'Servers behind mcpcut on this machine (<code>adopt</code>, <code>wrap</code>) show up here once your client has started them with a policy.'

  test('no wrap server either: the line is there, after the register link', () => {
    const document = page()
    expect(document).toMatch(/<p class="empty">No servers registered\.[^<]*<a href="\/servers\?add=1#add-server">Register a server<\/a>/)
    expect(document).toContain(LINE)
    expect(page({ isOwner: false })).toContain(LINE)
  })

  test('a wrap server already listed, or a hosted install: no line', () => {
    const withWrap = renderServersPage({
      servers: [],
      canManage: true,
      csrfToken: 'c',
      currentAdmin: OWNER,
      policyView: loadedView(),
      wrapServers: ['fs'],
    })
    expect(withWrap).not.toContain(LINE)
    expect(page({ isTenant: true })).not.toContain(LINE)
  })
})
