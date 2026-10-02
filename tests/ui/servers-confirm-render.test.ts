import { describe, expect, test } from 'vitest'
import type { PolicyView } from '../../src/policy/edit/policy-view.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { confirmRuleViewOf, confirmSummaryOf } from '../../src/ui/pages/servers-confirm-rule.js'
import { renderServersPage, toServerToolsByName, type ServersView } from '../../src/ui/pages/servers.js'
import { TENANT_SETTINGS } from '../../src/tenant/settings.js'

/**
 * The per-tool client rule on the Servers card (ADR-0019): the union pill, the
 * exact-key controls, pattern-covered agents shown fixed, "deny wins", the
 * agents form, and the "On this machine (wrap)" section.
 */

const OWNER = { name: 'alice', role: 'owner' } as const
const VIEWER = { name: 'vic', role: 'viewer' } as const

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy({ version: 1, ...(raw as object) })
  if (!parsed.ok) throw new Error('bad policy fixture')
  return parsed.policy
}

function loaded(policy: Policy): PolicyView {
  return { status: 'loaded', policy, hash: policyHashOf(policy), sourcePath: '/state/policy.json', readers: { kind: 'every-entry-point' } }
}

function inventoryOf(servers: Record<string, readonly string[]>): InventoryStoreData {
  return {
    version: 1,
    servers: Object.fromEntries(
      Object.entries(servers).map(([server, tools]) => [
        server,
        {
          approved: Object.fromEntries(tools.map((name) => [name, { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' }])),
          quarantined: {},
        },
      ]),
    ),
  }
}

interface PageOptions {
  readonly policy?: Policy
  readonly policyView?: PolicyView
  readonly inventory?: InventoryStoreData
  readonly canManage?: boolean
  readonly agentDirectory?: ServersView['agentDirectory']
  readonly wrapServers?: readonly string[]
  readonly tenant?: boolean
}

function page(options: PageOptions = {}): string {
  const policy = options.policy ?? policyOf({})
  const view = options.policyView ?? loaded(policy)
  const inventory = options.inventory ?? inventoryOf({ github: ['create_issue'] })
  return renderServersPage({
    servers: [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
    canManage: options.canManage ?? true,
    csrfToken: 'csrf-token-value',
    currentAdmin: options.canManage === false ? VIEWER : OWNER,
    tools: toServerToolsByName(inventory, view.status === 'loaded' ? view.policy : undefined),
    policyView: view,
    ...(options.agentDirectory !== undefined ? { agentDirectory: options.agentDirectory } : {}),
    ...(options.wrapServers !== undefined ? { wrapServers: options.wrapServers } : {}),
    ...(options.tenant === true ? { tenant: { ...TENANT_SETTINGS, isTenant: true } } : {}),
  })
}

const DIRECTORY = {
  known: ['laptop', 'alice-cursor', 'ci'],
  grantedBy: new Map([['github', ['laptop', 'alice-cursor']]]),
}

function clientForms(documentHtml: string): string[] {
  return documentHtml.match(/<form[^>]*srv-client-form[^>]*>[\s\S]*?<\/form>/g) ?? []
}

function pillOf(documentHtml: string): string {
  return /<span class="pill[^"]*srv-client[^"]*">([^<]*)<\/span>/.exec(documentHtml)?.[1] ?? ''
}

describe('confirmRuleViewOf / confirmSummaryOf', () => {
  const policy = policyOf({
    servers: { s: { confirmInClient: { 'write_*': ['*'], 'write_f*': ['ci'], write_file: ['laptop'], 'other_*': ['x'] } } },
  })

  test('exact entry plus every matching pattern, longest prefix first, non-matching ones left out', () => {
    expect(confirmRuleViewOf(policy, 's', 'write_file')).toEqual({
      exact: ['laptop'],
      patterns: [
        { pattern: 'write_f*', agents: ['ci'] },
        { pattern: 'write_*', agents: ['*'] },
      ],
    })
    expect(confirmRuleViewOf(policy, 's', 'read_x')).toEqual({ patterns: [] })
    expect(confirmRuleViewOf(policy, 'nope', 'write_file')).toEqual({ patterns: [] })
  })

  test('the summary reads as the union with the rule named', () => {
    expect(confirmSummaryOf(confirmRuleViewOf(policy, 's', 'write_file'))).toBe('laptop; ci (rule write_f*); all (rule write_*)')
    expect(confirmSummaryOf({ patterns: [] })).toBe('off')
    expect(confirmSummaryOf({ exact: ['*'], patterns: [] })).toBe('all')
    expect(confirmSummaryOf({ exact: ['a', 'b'], patterns: [] })).toBe('a, b')
  })
})

describe('the pill', () => {
  test.each([
    ['off', {}, 'client: off'],
    ['all', { servers: { github: { confirmInClient: { create_issue: ['*'] } } } }, 'client: all'],
    ['agents', { servers: { github: { confirmInClient: { create_issue: ['laptop', 'alice-cursor'] } } } }, 'client: laptop, alice-cursor'],
    ['pattern only', { servers: { github: { confirmInClient: { 'create_*': ['*'] } } } }, 'client: all (rule create_*)'],
    [
      'union',
      { servers: { github: { confirmInClient: { create_issue: ['laptop'], 'create_*': ['*'] } } } },
      'client: laptop; all (rule create_*)',
    ],
  ])('%s', (_label, raw, text) => {
    expect(pillOf(page({ policy: policyOf(raw), agentDirectory: DIRECTORY }))).toBe(text)
  })

  test('non-owners see the pill and no client control at all', () => {
    const document = page({ canManage: false, policy: policyOf({ servers: { github: { confirmInClient: { create_issue: ['*'] } } } }) })
    expect(pillOf(document)).toBe('client: all')
    expect(document).not.toContain('srv-client-form')
    expect(document).not.toContain('srv-client-ctl')
  })

  test('no policy loaded: no pill, no controls, no hint', () => {
    const document = page({ policyView: { status: 'absent', sourcePath: '/p', readers: { kind: 'every-entry-point' } } })
    expect(document).not.toContain('srv-client')
  })
})

describe('controls', () => {
  test('owner, loaded: off / all forms post to the confirm route with the CAS hash; the exact choice is pressed', () => {
    const policy = policyOf({ servers: { github: { confirmInClient: { create_issue: ['*'] } } } })
    const forms = clientForms(page({ policy, agentDirectory: DIRECTORY }))
    expect(forms[0]).toContain('action="/servers/github/tools/create_issue/confirm"')
    expect(forms[0]).toContain('data-action="/servers/github/tools/create_issue/confirm"')
    expect(forms[0]).toContain('name="confirm" value="off"')
    expect(forms[0]).toContain(`name="expected_hash" value="${policyHashOf(policy)}"`)
    expect(forms[0]).toContain('name="csrf_token" value="csrf-token-value"')
    expect(forms[1]).toContain('name="confirm" value="all"')
    expect(forms[1]).toContain('aria-pressed="true"')
    expect(forms[0]).toContain('aria-pressed="false"')
  })

  test('off is pressed when there is no exact key', () => {
    const forms = clientForms(page({ agentDirectory: DIRECTORY }))
    expect(forms[0]).toContain('aria-pressed="true"')
    expect(forms[1]).toContain('aria-pressed="false"')
  })

  test('the agents form lists agents with a grant on this server, unchecked by default', () => {
    const forms = clientForms(page({ agentDirectory: DIRECTORY }))
    const agents = forms[2] ?? ''
    expect(agents).toContain('name="confirm" value="agents"')
    expect(agents).toContain('<input type="checkbox" name="agent" value="laptop" />')
    expect(agents).toContain('<input type="checkbox" name="agent" value="alice-cursor" />')
    expect(agents).not.toContain('value="ci"')
    expect(agents).not.toContain('checked')
  })

  test('exact agents are checked; one missing from the agents store says so', () => {
    const policy = policyOf({ servers: { github: { confirmInClient: { create_issue: ['laptop', 'ghost'] } } } })
    const agents = clientForms(page({ policy, agentDirectory: DIRECTORY }))[2] ?? ''
    expect(agents).toContain('value="laptop" checked />')
    expect(agents).toContain('value="ghost" checked />')
    expect(agents).toMatch(/ghost[\s\S]*\(no such agent\)/)
    expect(agents).not.toMatch(/laptop[^<]*<[^>]*>\s*\(no such agent\)/)
  })

  test('agents covered by a pattern are checked and disabled with the rule named; the next step names policy.json', () => {
    const policy = policyOf({ servers: { github: { confirmInClient: { 'create_*': ['laptop'] } } } })
    const document = page({ policy, agentDirectory: DIRECTORY })
    const agents = clientForms(document)[2] ?? ''
    expect(agents).toContain('value="laptop" checked disabled />')
    expect(agents).toContain('(rule create_*)')
    expect(agents).toContain('<input type="checkbox" name="agent" value="alice-cursor" />')
    expect(document).toContain('edit it in policy.json')
  })

  test('a "*" pattern fixes every listed agent; an exact copy of a pattern agent survives a re-save', () => {
    const policy = policyOf({ servers: { github: { confirmInClient: { 'create_*': ['*'], create_issue: ['laptop'] } } } })
    const agents = clientForms(page({ policy, agentDirectory: DIRECTORY }))[2] ?? ''
    expect(agents).toContain('value="laptop" checked disabled />')
    expect(agents).toContain('value="alice-cursor" checked disabled />')
    expect(agents).toContain('<input type="hidden" name="agent" value="laptop" />')
    expect(agents).not.toContain('<input type="hidden" name="agent" value="alice-cursor" />')
  })

  test('no agent has a grant: only off / all, with the grant command using real names', () => {
    const document = page({ agentDirectory: { known: ['laptop'], grantedBy: new Map() } })
    expect(clientForms(document)).toHaveLength(2)
    expect(document).toContain('<code>mcpcut agent grant laptop github</code>')
  })

  test('no agents at all: the command keeps a placeholder for the agent only', () => {
    const document = page({ agentDirectory: { known: [], grantedBy: new Map() } })
    expect(document).toContain('<code>mcpcut agent grant &lt;agent&gt; github</code>')
  })

  test('deny wins: the whole client control is disabled, with the reason, and carries no data-action', () => {
    const policy = policyOf({ servers: { github: { tools: { create_issue: 'deny' } } } })
    const document = page({ policy, agentDirectory: DIRECTORY })
    const forms = clientForms(document)
    expect(forms.length).toBeGreaterThan(0)
    for (const form of forms) {
      expect(form).not.toContain('data-action')
      expect(form).toContain('disabled')
    }
    expect(document).toContain('deny wins')
  })

  test('an admin allow keeps the client control enabled (the rules are independent)', () => {
    const policy = policyOf({ servers: { github: { tools: { create_issue: 'allow' } } } })
    expect(clientForms(page({ policy, agentDirectory: DIRECTORY }))[0]).toContain('data-action=')
  })

  test('the hint appears once per tools panel', () => {
    const document = page({ inventory: inventoryOf({ github: ['a', 'b', 'c'] }), agentDirectory: DIRECTORY })
    expect(document.match(/Client confirmation: Accept \/ Decline in the client/g)).toHaveLength(1)
    expect(document).toContain('over HTTP (serve, connect --url, hosted) it is refused for now.')
  })

  test('hostile tool names reach markup escaped and percent-encoded in the path', () => {
    const document = page({ inventory: inventoryOf({ github: ['a/b"><script>'] }), agentDirectory: DIRECTORY })
    expect(document).not.toContain('<script>')
    expect(document).toContain('/tools/a%2Fb%22%3E%3Cscript%3E/confirm')
  })
})

describe('On this machine (wrap)', () => {
  const inventory = inventoryOf({ github: ['create_issue'], 'my-local': ['run'], 'auto:ab12cd': ['exec'] })

  test('lists wrap servers with a tools panel, both controls, and off / all only', () => {
    const document = page({ inventory, wrapServers: ['my-local'], agentDirectory: DIRECTORY })
    expect(document).toContain('On this machine (wrap)')
    expect(document).toContain('id="tools-my-local"')
    const start = document.indexOf('id="tools-my-local"')
    const panel = document.slice(start, document.indexOf('</details>', start))
    expect(panel).toContain('/servers/my-local/tools/run/rule')
    expect(panel).toContain('/servers/my-local/tools/run/confirm')
    expect(panel).not.toContain('name="confirm" value="agents"')
    expect(panel).toContain('Under wrap there is no agent name: only off / all apply')
  })

  test('an auto: server is shown, with the --server hint', () => {
    const document = page({ inventory, wrapServers: ['auto:ab12cd'], agentDirectory: DIRECTORY })
    expect(document).toContain('auto:ab12cd')
    expect(document).toContain('--server &lt;name&gt;')
  })

  test('the hint is absent when no name is generated', () => {
    expect(page({ inventory, wrapServers: ['my-local'], agentDirectory: DIRECTORY })).not.toContain('readable name for auto:')
  })

  test('not rendered when empty or absent', () => {
    expect(page({ inventory, wrapServers: [] })).not.toContain('On this machine')
    expect(page({ inventory })).not.toContain('On this machine')
  })

  test('hidden on a tenant install', () => {
    expect(page({ inventory, wrapServers: ['my-local'], tenant: true })).not.toContain('On this machine')
  })

  test('a non-owner sees the pills only', () => {
    const document = page({ inventory, wrapServers: ['my-local'], canManage: false })
    expect(document).toContain('On this machine (wrap)')
    expect(document).not.toContain('/servers/my-local/tools/run/confirm')
  })
})
