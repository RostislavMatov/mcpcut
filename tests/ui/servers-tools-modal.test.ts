import { describe, expect, test } from 'vitest'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { CSS_PAGE_SERVERS } from '../../src/ui/assets/css/page-servers.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import {
  renderServersPage,
  type ServersView,
  type ServerStatusView,
  type ServerToolsByName,
  type ServerToolsView,
} from '../../src/ui/pages/servers.js'

/**
 * The Servers screen as `Servers.dc.html` draws it: the card body carries a
 * single `tools · N exposed · M quarantined · view →` row, and the tool list
 * itself lives in a MODAL that row opens — including the design's
 * release-from-quarantine control and its confirmation.
 *
 * Two properties are load-bearing beyond looks:
 *  - the modal is a `<details>` outside the card, so `/servers?tools=<name>`
 *    renders it open with no JavaScript at all;
 *  - the release control is operator+ only and always names the structural
 *    diff it does NOT show, because approving a `changed` tool accepts a new
 *    declared surface for a tool agents already call.
 */

const JS_SOURCE = APP_JS.body.toString('utf8')

const ADMIN = { name: 'alice', role: 'owner' } as const

const ECHO: ServerRecord = { name: 'echo', transport: 'stdio', command: 'echo-mcp', args: ['--serve'] }

const REMOTE: ServerRecord = {
  name: 'remote',
  transport: 'http',
  url: 'https://mcp.example.com/sse',
  protocol: 'auto',
}

const TOOLS: ServerToolsView = {
  tools: [
    { name: 'read_note', description: 'Reads a note' },
    { name: 'write_note', description: 'Writes a note', quarantined: 'new' },
  ],
  quarantinedCount: 1,
}

function toolsMap(view: ServerToolsView = TOOLS, server = ECHO.name): ServerToolsByName {
  return new Map([[server, view]])
}

function pageWith(extra: Partial<ServersView> = {}): string {
  return renderServersPage({
    servers: [ECHO],
    canManage: false,
    csrfToken: 'csrf-token-value',
    currentAdmin: ADMIN,
    tools: toolsMap(),
    ...extra,
  })
}

/** The `<details>` element that is the tools modal for one server. */
function modalOf(documentHtml: string, serverName: string): string {
  const pattern = new RegExp(
    `<details class="drawer srv-tools-modal" id="tools-${serverName}"[^>]*>[\\s\\S]*?</details>`,
  )
  const found = pattern.exec(documentHtml)?.[0]
  expect(found, `no tools modal for "${serverName}"`).toBeDefined()
  return found ?? ''
}

describe('the card body opens the tools modal instead of listing tools inline', () => {
  test('the row states the exposed and quarantined counts, and says how to open it', () => {
    const document = pageWith()
    expect(document).toContain('<span class="dim small num">2 exposed · 1 quarantined</span>')
    expect(document).toContain('<span class="faint small srv-tools-action">view →</span>')
  })

  test('the row is a real link to ?tools=<name>, with the in-place opener beside it', () => {
    const document = pageWith()
    expect(document).toContain(
      '<a class="srv-tools-open" href="/servers?tools=echo#tools-echo" data-open-details="tools-echo">',
    )
  })

  test('the tool rows are no longer inside the card', () => {
    const document = pageWith()
    expect(document).not.toContain('srv-tools-sum')
    const grid = /<section class="srv-grid[\s\S]*?<\/section>/.exec(document)?.[0] ?? ''
    expect(grid).toContain('srv-tools-open')
    expect(grid, 'the modal must be a sibling of the grid, not nested in a card').not.toContain(
      'srv-tools-modal',
    )
    expect(document).toContain('srv-tools-modal')
  })

  test('a page with no inventory port renders neither the row nor the modal', () => {
    const document = renderServersPage({
      servers: [ECHO],
      canManage: false,
      csrfToken: 'csrf-token-value',
      currentAdmin: ADMIN,
    })
    expect(document).not.toContain('srv-tools-open')
    expect(document).not.toContain('srv-tools-modal')
  })
})

describe('the modal itself', () => {
  test('names the server, lists its tools and closes back to /servers', () => {
    const modal = modalOf(pageWith(), 'echo')
    expect(modal).toContain('<span class="pixel upper">Tools</span>')
    expect(modal).toContain('<span class="faint small ellipsis">echo</span>')
    expect(modal).toContain('read_note')
    expect(modal).toContain('write_note')
    expect(modal).toContain('href="/servers" data-close-details="tools-echo"')
  })

  test('is closed by default and open when ?tools named this server', () => {
    expect(pageWith()).toContain('<details class="drawer srv-tools-modal" id="tools-echo">')
    const opened = pageWith({ openTools: 'echo' })
    expect(opened).toContain('<details class="drawer srv-tools-modal" id="tools-echo" open>')
  })

  test('?tools also expands the card — the row that opens the modal lives in its body', () => {
    const opened = pageWith({ openTools: 'echo' })
    expect(opened).toMatch(/<details class="disclosure card srv-card"[^>]* open>/)
    // A server the query did not name stays collapsed and closed.
    const other = renderServersPage({
      servers: [ECHO, REMOTE],
      canManage: false,
      csrfToken: 'csrf-token-value',
      currentAdmin: ADMIN,
      tools: new Map([
        [ECHO.name, TOOLS],
        [REMOTE.name, TOOLS],
      ]),
      openTools: 'echo',
    })
    expect(other).toContain('<details class="drawer srv-tools-modal" id="tools-remote">')
  })

  test('an inventory with no entry for the server says so rather than vanishing', () => {
    const modal = modalOf(pageWith({ tools: new Map() }), 'echo')
    expect(modal).toContain('no tools reported')
  })

  test('a running probe is announced in the row and in the modal', () => {
    const probing: ServerStatusView = { status: 'probing', probeStartedAt: '2026-08-27T09:00:00.000Z' }
    const document = pageWith({ statuses: new Map([[ECHO.name, probing]]) })
    expect(document).toContain('<span class="dim small num">probing…</span>')
    expect(modalOf(document, 'echo')).toContain('probing… receiving tool list from echo')
  })

  test('hostile tool text is escaped inside the modal', () => {
    const hostile: ServerToolsView = {
      tools: [{ name: '<img src=x onerror=alert(1)>', description: '</div><script>alert(2)</script>' }],
      quarantinedCount: 0,
    }
    const modal = modalOf(pageWith({ tools: toolsMap(hostile) }), 'echo')
    expect(modal).not.toContain('<img src=x')
    expect(modal).not.toContain('<script>alert(2)')
    expect(modal).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('release from quarantine (operator+, the design control)', () => {
  const released = (extra: Partial<ServersView> = {}): string =>
    modalOf(pageWith({ canRelease: true, ...extra }), 'echo')

  test('is offered only on a quarantined tool', () => {
    const modal = released()
    const forms = modal.match(/action="\/quarantine\/approve"/g) ?? []
    expect(forms.length).toBe(1)
    expect(modal).toContain('Release from quarantine')
  })

  test('posts server, tool, the CSRF token and the return path', () => {
    const modal = released()
    expect(modal).toContain('<input type="hidden" name="server" value="echo" />')
    expect(modal).toContain('<input type="hidden" name="tool" value="write_note" />')
    expect(modal).toContain('<input type="hidden" name="return_to" value="/servers" />')
    expect(modal).toContain('name="csrf_token" value="csrf-token-value"')
  })

  test('is absent for a viewer who may not approve', () => {
    expect(modalOf(pageWith(), 'echo')).not.toContain('/quarantine/approve')
    expect(modalOf(pageWith({ canRelease: false }), 'echo')).not.toContain('/quarantine/approve')
  })

  test('the confirmation says which case it is and always points at the diff', () => {
    const fresh = released()
    expect(fresh).toContain('has never run')
    expect(fresh).toContain('review the structural diff')

    const changed: ServerToolsView = {
      tools: [{ name: 'write_note', quarantined: 'changed' }],
      quarantinedCount: 1,
    }
    const modal = modalOf(pageWith({ canRelease: true, tools: toolsMap(changed) }), 'echo')
    expect(modal).toContain('has CHANGED since it was approved')
    expect(modal).toContain('review the structural diff')
  })

  test('the confirmation is a nested disclosure — it needs no JavaScript', () => {
    const modal = released()
    expect(modal).toContain('<details class="srv-release">')
    expect(modal).toContain('<summary class="srv-release-open">Release from quarantine</summary>')
    expect(CSS_PAGE_SERVERS).toContain('summary.srv-release-open')
  })
})

describe('card fidelity to the design', () => {
  test('the state word stands beside the transport pill and carries the SSE hook', () => {
    const alive: ServerStatusView = { status: 'alive', probedAt: '2026-08-27T09:00:00.000Z' }
    const document = pageWith({ statuses: new Map([[ECHO.name, alive]]) })
    expect(document).toContain('<span class="srv-state upper faint small" data-server="echo">alive</span>')
  })

  test('a server that was never probed says so rather than showing nothing', () => {
    expect(pageWith()).toContain('data-server="echo">never-checked</span>')
  })

  test('the SSE updater swaps the state word as text, never as markup', () => {
    expect(JS_SOURCE).toContain('.srv-state')
    expect(JS_SOURCE).toContain('label.textContent = detail.status')
  })

  test('counts are written against their cap, as the design writes them', () => {
    const document = pageWith()
    expect(document).toContain('<span class="label">args</span><span class="faint small num">1 / 100</span>')
    expect(document).toContain('<span class="label">env</span><span class="faint small num">0 / 100</span>')
    expect(document).toContain('no env entries')
  })

  test('an http tile drops the scheme from its target but the body keeps the url', () => {
    const document = renderServersPage({
      servers: [REMOTE],
      canManage: false,
      csrfToken: 'csrf-token-value',
      currentAdmin: ADMIN,
    })
    expect(document).toContain('>mcp.example.com/sse</span>')
    expect(document).toContain('<div class="srv-box">https://mcp.example.com/sse</div>')
    expect(document).toContain('<span class="label">headers</span><span class="faint small num">0 / 100</span>')
    expect(document).toContain('no headers')
  })

  test('arg rows are numbered from 00, like the design', () => {
    expect(CSS_PAGE_SERVERS).toContain('counter-reset: arg -1')
  })
})
