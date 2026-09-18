import { describe, expect, test } from 'vitest'
import type { PolicyView } from '../../src/policy/edit/policy-view.js'
import type { PolicyTargetReaders } from '../../src/policy/edit/write-target.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { renderServersPage, toServerToolsByName, type ServersView } from '../../src/ui/pages/servers.js'

/**
 * The per-tool rule on the Servers card (plan policy-tool-rules-ui §6, wave
 * 4): the outcome pill and its source label per `effectiveToolRule` source,
 * the owner's button-forms and their pressed/disabled states across every
 * `PolicyView` status, the read-only view for non-owners, and the encoding
 * of hostile inventory names. Tool names and descriptions are server-authored
 * (untrusted for render), so the XSS fixtures are load-bearing.
 */

const OWNER = { name: 'alice', role: 'owner' } as const
const VIEWER = { name: 'vic', role: 'viewer' } as const

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('bad policy fixture')
  return parsed.policy
}

const EVERY_ENTRY_POINT: PolicyTargetReaders = { kind: 'every-entry-point' }

function loadedView(policy: Policy, extra: Partial<PolicyView> = {}): PolicyView {
  return {
    status: 'loaded',
    policy,
    hash: policyHashOf(policy),
    sourcePath: '/state/policy.json',
    readers: EVERY_ENTRY_POINT,
    ...extra,
  }
}

function inventoryWith(tools: readonly string[], quarantined: readonly string[] = []): InventoryStoreData {
  const approved = Object.fromEntries(tools.map((name) => [name, { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' }]))
  const held = Object.fromEntries(
    quarantined.map((name) => [
      name,
      { schemaHash: 'q', firstSeenAt: '2026-08-02T00:00:00.000Z', state: 'new' as const, descriptor: { name } },
    ]),
  )
  return { version: 1, servers: { github: { approved, quarantined: held } } }
}

interface PageOptions {
  readonly policyView?: PolicyView
  readonly inventory?: InventoryStoreData
  readonly canManage?: boolean
  readonly admin?: ServersView['currentAdmin']
}

function page(options: PageOptions = {}): string {
  const inventory = options.inventory ?? inventoryWith(['create_issue'])
  const policy = options.policyView?.status === 'loaded' ? options.policyView.policy : undefined
  return renderServersPage({
    servers: [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
    canManage: options.canManage ?? true,
    csrfToken: 'csrf-token-value',
    currentAdmin: options.admin ?? OWNER,
    tools: toServerToolsByName(inventory, policy),
    ...(options.policyView !== undefined ? { policyView: options.policyView } : {}),
  })
}

/** The rule pill tag + the source label that follows it, for one tool row. */
function ruleOf(documentHtml: string, toolName: string): { pill: string; source: string } {
  const row = new RegExp(`<span class="srv-tool-name">${toolName}</span>[\\s\\S]*?<span class="spacer">`).exec(documentHtml)?.[0] ?? ''
  const pill = /<span class="pill[^"]*srv-rule[^"]*">[^<]*<\/span>/.exec(row)?.[0] ?? ''
  const source = /<span class="srv-rule-src[^"]*">([^<]*)<\/span>/.exec(row)?.[1] ?? ''
  return { pill, source }
}

function ruleButtons(documentHtml: string): string[] {
  return documentHtml.match(/<button[^>]*srv-rule-btn[^>]*>[^<]*<\/button>/g) ?? []
}

describe('outcome pill + source label per effectiveToolRule source', () => {
  test.each([
    ['explicit deny', { servers: { github: { tools: { create_issue: 'deny' } } } }, 'pill pill-alert srv-rule srv-rule-deny', 'deny', 'rule'],
    ['explicit approval', { servers: { github: { tools: { create_issue: 'require-approval' } } } }, 'pill pill-on srv-rule srv-rule-approval', 'approval', 'rule'],
    ['wildcard allow', { servers: { github: { tools: { 'create_*': 'allow' } } } }, 'pill srv-rule srv-rule-allow', 'allow', 'rule create_*'],
    ['server default', { servers: { github: { defaultDecision: 'deny' } } }, 'pill pill-alert srv-rule srv-rule-deny', 'deny', 'server default'],
    ['class default', { classDefaults: { write: 'require-approval' } }, 'pill pill-on srv-rule srv-rule-approval', 'approval', 'class write'],
    // The schema's default `defaultDecision` is require-approval.
    ['global default', {}, 'pill pill-on srv-rule srv-rule-approval', 'approval', 'default'],
  ])('%s', (_label, raw, pillClass, pillText, sourceText) => {
    const document = page({ policyView: loadedView(policyOf({ version: 1, ...raw })) })
    const rule = ruleOf(document, 'create_issue')
    expect(rule.pill).toBe(`<span class="${pillClass}">${pillText}</span>`)
    expect(rule.source).toBe(sourceText)
  })

  test('a quarantined tool shows the quarantine source AND still gets controls', () => {
    const policy = policyOf({ version: 1, quarantine: { enabled: true, onQuarantined: 'require-approval' } })
    const document = page({ policyView: loadedView(policy), inventory: inventoryWith([], ['new_tool']) })
    const rule = ruleOf(document, 'new_tool')
    expect(rule.pill).toContain('approval')
    expect(rule.source).toBe('quarantine')
    expect(document).toContain('quarantined · new')
    expect(ruleButtons(document)).toHaveLength(3)
  })

  test('without a policy view there are no pills and no controls (the page as before)', () => {
    const document = page()
    expect(document).not.toContain('srv-rule')
    expect(document).not.toContain('srv-policy-sources')
  })
})

describe('controls', () => {
  test('owner, loaded policy: three enabled button-forms, the explicit rule pressed, plus reset', () => {
    const document = page({ policyView: loadedView(policyOf({ version: 1, servers: { github: { tools: { create_issue: 'deny' } } } })) })
    const buttons = ruleButtons(document)
    expect(buttons.map((b) => />([^<]*)</.exec(b)?.[1])).toEqual(['allow', 'approval', 'deny', 'reset'])
    expect(buttons.filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1)
    expect(buttons[2]).toContain('aria-pressed="true"')
    expect(buttons[2]).toContain('is-on')
    expect(buttons.some((b) => b.includes('disabled'))).toBe(false)
    expect(document).toContain('<input type="hidden" name="rule" value="clear" />')
  })

  test('a non-explicit outcome has nothing pressed and no reset', () => {
    const document = page({ policyView: loadedView(policyOf({ version: 1, servers: { github: { tools: { 'create_*': 'deny' } } } })) })
    const buttons = ruleButtons(document)
    expect(buttons).toHaveLength(3)
    expect(buttons.some((b) => b.includes('aria-pressed="true"'))).toBe(false)
  })

  test('absent policy: buttons disabled, no CAS token, the O4 note in the panel, and no data-action', () => {
    const document = page({ policyView: { status: 'absent', sourcePath: '/state/policy.json', readers: EVERY_ENTRY_POINT } })
    // No policy → no outcome to show → no rule rows at all; the note says why.
    expect(document).toContain('<div class="srv-tools-note faint small">no policy — enforcement off</div>')
    expect(document).toContain('absent — enforcement off')
    expect(ruleButtons(document)).toHaveLength(0)
    expect(document).not.toContain('data-action="/servers/')
  })

  test('invalid policy: page-top banner lists the errors and the file stays uneditable', () => {
    const document = page({ policyView: { status: 'error', errors: ['version: expected 1', 'servers: <bad>'], sourcePath: '/state/policy.json', readers: EVERY_ENTRY_POINT } })
    expect(document).toMatch(/<div class="callout srv-policy-banner" role="alert">/)
    expect(document).toContain('<li><code>version: expected 1</code></li>')
    expect(document).toContain('<li><code>servers: &lt;bad&gt;</code></li>')
    expect(document).toContain('<span class="pill pill-alert" data-live-text="policy-hash">invalid</span>')
    expect(ruleButtons(document)).toHaveLength(0)
  })

  /**
   * Correction 2026-08-26: a file other entry points read differently is a
   * STATEMENT, not a refusal — the edit reaches whoever loaded this file.
   */
  test('a file connect does not read: controls stay enabled, the readers line says who is affected', () => {
    const view = loadedView(policyOf({ version: 1 }), {
      sourcePath: '/work/.mcpcut-project/policy.json',
      readers: { kind: 'connect-elsewhere', connectPath: '/state/policy.json', shadowsTarget: false },
    })
    const document = page({ policyView: view })
    const buttons = ruleButtons(document)
    expect(buttons).toHaveLength(3)
    for (const button of buttons) expect(button).not.toContain('disabled')
    expect(document).toContain('data-action="/servers/')
    expect(document).not.toContain('srv-policy-banner')
    expect(document).toContain('ui/wrap/serve read this file; connect sessions read /state/policy.json')
  })

  test('a non-owner keeps the pills but gets no controls at all', () => {
    const document = page({
      policyView: loadedView(policyOf({ version: 1, servers: { github: { tools: { create_issue: 'deny' } } } })),
      canManage: false,
      admin: VIEWER,
    })
    expect(ruleOf(document, 'create_issue').pill).toContain('deny')
    expect(ruleButtons(document)).toHaveLength(0)
    expect(document).not.toContain('srv-rule-form')
  })
})

describe('sources panel', () => {
  test('shows the write path and the first 8 hash characters', () => {
    const policy = policyOf({ version: 1 })
    const document = page({ policyView: loadedView(policy) })
    expect(document).toContain(
      `policy · <code>/state/policy.json</code> · <span class="num" data-live-text="policy-hash">${policyHashOf(policy).slice(0, 8)}</span>`,
    )
  })

  /**
   * The line sits outside every card's settle region; without `data-live-text`
   * a rule change would leave a stale digest next to freshly-changed rules —
   * and that digest is what an operator compares against the journal.
   */
  test('the hash follows a settle swap (it is a live-text node in every state)', () => {
    const loaded = page({ policyView: loadedView(policyOf({ version: 1 })) })
    expect(loaded).toMatch(/<span class="num" data-live-text="policy-hash">[0-9a-f]{8}<\/span>/)
    const absent = page({ policyView: { status: 'absent', sourcePath: '/state/policy.json', readers: EVERY_ENTRY_POINT } })
    expect(absent).toContain('data-live-text="policy-hash"')
  })

  test('states that every entry point reads the file when it is the one connect loads', () => {
    const document = page({ policyView: loadedView(policyOf({ version: 1 })) })
    expect(document).toContain('<div class="srv-policy-src faint small">every entry point reads this file</div>')
  })

  test('states that connect reads the nested file first when it shadows the state-dir file', () => {
    const document = page({
      policyView: loadedView(policyOf({ version: 1 }), {
        readers: { kind: 'connect-elsewhere', connectPath: '/state/.mcpcut-project/policy.json', shadowsTarget: true },
      }),
    })
    expect(document).toContain('connect reads /state/.mcpcut-project/policy.json first — rules here reach ui/wrap/serve only')
  })

  /** The live install of 2026-08-26: the plane enforces a project file, the state dir holds none. */
  test('states that connect sessions have no policy at all when nothing resolves for them', () => {
    const document = page({
      policyView: loadedView(policyOf({ version: 1 }), {
        sourcePath: '/work/.mcpcut-project/policy.json',
        readers: { kind: 'connect-unset' },
      }),
    })
    expect(document).toContain('policy · <code>/work/.mcpcut-project/policy.json</code>')
    expect(document).toContain(
      'ui/wrap/serve read this file; connect sessions have no policy right now (journaling only) — rules here do not reach them',
    )
    expect(ruleButtons(document)).toHaveLength(3)
  })
})

describe('hostile names', () => {
  test('a tool name with markup and slashes is escaped in text and percent-encoded in the path', () => {
    const hostile = 'a/b<script>"x'
    const policy = policyOf({ version: 1 })
    const document = page({ policyView: loadedView(policy), inventory: inventoryWith([hostile]) })
    expect(document).not.toContain('<script>')
    expect(document).toContain('a/b&lt;script&gt;&quot;x')
    const encoded = `/servers/github/tools/${encodeURIComponent(hostile)}/rule`
    expect(document).toContain(`action="${encoded}"`)
    expect(document).toContain(`data-action="${encoded}"`)
    expect(encoded.split('/')).toHaveLength(6)
  })

  test('a server name with a colon yields a colon-safe region key and an encoded path', () => {
    const policy = policyOf({ version: 1 })
    const inventory: InventoryStoreData = {
      version: 1,
      servers: { 'gh:prod': { approved: { t: { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' } }, quarantined: {} } },
    }
    const document = renderServersPage({
      servers: [{ name: 'gh:prod', transport: 'stdio', command: 'gh-mcp' }],
      canManage: true,
      csrfToken: 'csrf',
      currentAdmin: OWNER,
      tools: toServerToolsByName(inventory, policy),
      policyView: loadedView(policy),
    })
    expect(document).toContain('data-live-region="server-tools:gh:prod"')
    expect(document).toContain('action="/servers/gh%3Aprod/tools/t/rule"')
  })
})
