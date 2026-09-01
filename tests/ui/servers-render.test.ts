import { describe, expect, test } from 'vitest'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { CSS_BASE } from '../../src/ui/assets/css/base.js'
import { CSS_COMPONENTS } from '../../src/ui/assets/css/components.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import {
  renderAddConfirm,
  renderServersPage,
  type ServersView,
  type ServerStatusView,
  type ServerToolsByName,
} from '../../src/ui/pages/servers.js'

/**
 * Task 7 (M5.5 p.1, O7): the per-server status dot on `/servers` — its class
 * per status, the blink states, the mandatory tooltip, the `data-server` hook
 * the SSE handler updates through, the Refresh form, and the no-JS
 * degradation. The tooltip and every error string are server-authored,
 * untrusted-for-render text, so the XSS fixtures here are load-bearing.
 *
 * Status → dot (owner decision O7):
 *   alive                → white dot;         alive + fresh traffic → white blinking
 *   error / unreachable / vault-refused → gray dot
 *   probing              → gray blinking
 *   never-checked        → hollow (outline) dot — its own neutral state
 */

const JS_SOURCE = APP_JS.body.toString('utf8')

const ADMIN = { name: 'alice', role: 'owner' } as const

const ECHO: ServerRecord = { name: 'echo', transport: 'stdio', command: 'echo-mcp' }

function pageWith(
  status: ServerStatusView | undefined,
  extra: Partial<ServersView> = {},
): string {
  const statuses = new Map<string, ServerStatusView>()
  if (status !== undefined) statuses.set(ECHO.name, status)
  return renderServersPage({
    servers: [ECHO],
    canManage: false,
    csrfToken: 'csrf-token-value',
    currentAdmin: ADMIN,
    statuses,
    ...extra,
  })
}

/** The status-dot tag for one server, located by its `data-server` hook. */
function dotTagOf(documentHtml: string, serverName: string): string {
  const pattern = new RegExp(`<span[^>]*data-server="${serverName}"[^>]*>`)
  const tag = pattern.exec(documentHtml)?.[0]
  expect(tag, `no status dot with data-server="${serverName}"`).toBeDefined()
  return tag ?? ''
}

function classesOf(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter((c) => c !== '')
}

function titleOf(tag: string): string {
  return /title="([^"]*)"/.exec(tag)?.[1] ?? ''
}

const ALIVE: ServerStatusView = {
  status: 'alive',
  probedVia: 'initialize',
  latencyMs: 34,
  probedAt: '2026-08-24T10:00:00.000Z',
}

describe('status dot classes (O7)', () => {
  test('alive → white dot, no blink, no off', () => {
    const classes = classesOf(dotTagOf(pageWith(ALIVE), 'echo'))
    expect(classes).toContain('dot')
    expect(classes).not.toContain('dot-off')
    expect(classes).not.toContain('dot-blink')
    expect(classes).not.toContain('dot-hollow')
  })

  test('alive with fresh traffic → white blinking dot', () => {
    const classes = classesOf(
      dotTagOf(
        pageWith({ ...ALIVE, lastActivityAt: '2026-08-24T10:04:00.000Z', activityFresh: true }),
        'echo',
      ),
    )
    expect(classes).toContain('dot-blink')
    expect(classes).not.toContain('dot-off')
  })

  test('stale traffic does not blink', () => {
    const classes = classesOf(
      dotTagOf(
        pageWith({ ...ALIVE, lastActivityAt: '2026-08-24T08:00:00.000Z', activityFresh: false }),
        'echo',
      ),
    )
    expect(classes).not.toContain('dot-blink')
  })

  test.each(['error', 'unreachable', 'vault-refused'] as const)('%s → gray dot, no blink', (status) => {
    const classes = classesOf(
      dotTagOf(
        pageWith({ status, error: 'went away', probedAt: '2026-08-24T10:00:00.000Z' }),
        'echo',
      ),
    )
    expect(classes).toContain('dot-off')
    expect(classes).not.toContain('dot-blink')
  })

  test('probing → gray blinking dot', () => {
    const classes = classesOf(
      dotTagOf(pageWith({ status: 'probing', probeStartedAt: '2026-08-24T10:00:00.000Z' }), 'echo'),
    )
    expect(classes).toContain('dot-off')
    expect(classes).toContain('dot-blink')
  })

  test('never-checked (explicit and absent entry) → hollow neutral dot', () => {
    for (const documentHtml of [pageWith({ status: 'never-checked' }), pageWith(undefined)]) {
      const classes = classesOf(dotTagOf(documentHtml, 'echo'))
      expect(classes).toContain('dot-hollow')
      expect(classes).not.toContain('dot-off')
      expect(classes).not.toContain('dot-blink')
    }
  })

  test('a page without any statuses map still renders the neutral dot', () => {
    const documentHtml = renderServersPage({
      servers: [ECHO],
      canManage: false,
      csrfToken: 'csrf-token-value',
      currentAdmin: ADMIN,
    })
    expect(classesOf(dotTagOf(documentHtml, 'echo'))).toContain('dot-hollow')
  })
})

describe('status tooltip (O7: source, time, latency or cause)', () => {
  test('alive: names the probe source with probedVia, the time and the latency', () => {
    const title = titleOf(dotTagOf(pageWith(ALIVE), 'echo'))
    expect(title).toContain('alive')
    expect(title).toContain('probe (initialize)')
    expect(title).toContain('2026-08-24T10:00:00.000Z')
    expect(title).toContain('34ms')
  })

  test('alive with traffic: the tooltip names the traffic signal and its time', () => {
    const title = titleOf(
      dotTagOf(
        pageWith({ ...ALIVE, lastActivityAt: '2026-08-24T10:04:00.000Z', activityFresh: true }),
        'echo',
      ),
    )
    expect(title).toContain('traffic')
    expect(title).toContain('2026-08-24T10:04:00.000Z')
  })

  test('a stateless-http probe is honest about what it measured (tools/list)', () => {
    const title = titleOf(
      dotTagOf(pageWith({ ...ALIVE, probedVia: 'tools/list', latencyMs: 12 }), 'echo'),
    )
    expect(title).toContain('probe (tools/list)')
    expect(title).toContain('12ms')
  })

  test('a failure carries the status, the time and the cause', () => {
    const title = titleOf(
      dotTagOf(
        pageWith({
          status: 'vault-refused',
          error: 'secret "gh-token" is not in the vault',
          probedAt: '2026-08-24T10:00:00.000Z',
        }),
        'echo',
      ),
    )
    expect(title).toContain('vault-refused')
    expect(title).toContain('2026-08-24T10:00:00.000Z')
    // The quote-bearing cause is escaped into the attribute, so the raw
    // extract sees entities, not a broken-out attribute.
    expect(title).toContain('secret &quot;gh-token&quot; is not in the vault')
  })

  test('probing shows a started-at time', () => {
    const title = titleOf(
      dotTagOf(pageWith({ status: 'probing', probeStartedAt: '2026-08-24T10:00:00.000Z' }), 'echo'),
    )
    expect(title).toContain('probing')
    expect(title).toContain('2026-08-24T10:00:00.000Z')
  })

  test('never-checked says so', () => {
    expect(titleOf(dotTagOf(pageWith(undefined), 'echo'))).toContain('never checked')
  })
})

describe('hostile server output is escaped (XSS fixtures)', () => {
  const XSS_ERROR = '<script>alert(1)</script>"onmouseover="alert(2)'

  test('an error cause with markup and quote breakouts cannot escape the attribute', () => {
    const documentHtml = pageWith({
      status: 'error',
      error: XSS_ERROR,
      probedAt: '2026-08-24T10:00:00.000Z',
    })
    expect(documentHtml).not.toContain('<script>alert(1)')
    expect(documentHtml).not.toContain('"onmouseover="')
    expect(documentHtml).toContain('&lt;script&gt;')
  })

  test('a hostile tool name from the inventory stays escaped alongside the dot', () => {
    const tools: ServerToolsByName = new Map([
      [
        'echo',
        {
          tools: [{ name: '"><script>alert(3)</script>', description: '<img src=x onerror=alert(4)>' }],
          quarantinedCount: 0,
        },
      ],
    ])
    const documentHtml = pageWith(ALIVE, { tools })
    expect(documentHtml).not.toContain('<script>alert(3)')
    expect(documentHtml).not.toContain('<img src=x')
    expect(documentHtml).toContain('&lt;script&gt;alert(3)&lt;/script&gt;')
  })
})

describe('markup contract for the SSE updater', () => {
  test('every server card carries a data-server hook on its dot', () => {
    const other: ServerRecord = { name: 'gh', transport: 'stdio', command: 'gh-mcp' }
    const documentHtml = renderServersPage({
      servers: [ECHO, other],
      canManage: false,
      csrfToken: 'csrf-token-value',
      currentAdmin: ADMIN,
    })
    dotTagOf(documentHtml, 'echo')
    dotTagOf(documentHtml, 'gh')
  })

  test('the dot renders in the list view too', () => {
    const documentHtml = pageWith(ALIVE, { viewMode: 'list' })
    dotTagOf(documentHtml, 'echo')
  })

  test('styles come from classes only — no style attribute anywhere on the page', () => {
    expect(pageWith(ALIVE)).not.toContain('style="')
  })
})

describe('Refresh (operator+; the route row is Task 6 territory)', () => {
  test('canRefresh renders a CSRF-guarded POST form to /servers/refresh naming the server', () => {
    const documentHtml = pageWith(ALIVE, { canRefresh: true })
    const form = /<form[^>]*class="[^"]*srv-refresh[^"]*"[^>]*>[\s\S]*?<\/form>/.exec(documentHtml)?.[0]
    expect(form).toBeDefined()
    expect(form).toContain('method="post"')
    // The flat route Task 6's handler serves: the server arrives as a body
    // field, exactly like /servers/remove.
    expect(form).toContain('action="/servers/refresh"')
    expect(form).toContain('name="csrf_token"')
    expect(form).toContain('name="name" value="echo"')
  })

  test('without canRefresh there is no refresh form (viewer sees none)', () => {
    expect(pageWith(ALIVE)).not.toContain('srv-refresh')
    expect(pageWith(ALIVE)).not.toContain('/servers/refresh')
  })
})

describe('no-JS degradation', () => {
  test('the saved status — including probing — is readable in static markup', () => {
    const documentHtml = pageWith({ status: 'probing', probeStartedAt: '2026-08-24T10:00:00.000Z' })
    // Without JS the dot and its title come straight from the render: the
    // stored `probing` state is visible (blinking gray dot + tooltip).
    const tag = dotTagOf(documentHtml, 'echo')
    expect(titleOf(tag)).toContain('probing')
  })

  test('the page stays well-formed: details/span/form tags balance', () => {
    const documentHtml = pageWith(ALIVE, { canRefresh: true })
    for (const tag of ['details', 'span', 'form', 'section']) {
      const opens = documentHtml.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0
      const closes = documentHtml.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0
      expect(opens, `<${tag}> balance`).toBe(closes)
    }
  })
})

describe('CSS backing for the dot states', () => {
  test('the hollow (never-checked) dot class exists', () => {
    expect(CSS_COMPONENTS).toContain('.dot-hollow')
  })

  test('blink is a CSS animation silenced under prefers-reduced-motion', () => {
    expect(CSS_COMPONENTS).toContain('.dot-blink')
    expect(CSS_BASE).toContain('@keyframes blink')
    expect(CSS_BASE).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CSS_BASE).toContain('animation: none !important')
  })
})

/**
 * The Task-6 seam: the handler reads `{status: ServerStatus, activity?}`
 * entries (probe-schema shapes) via `statusViewOf` and hands them to the page
 * through `toServerStatusesByName`, which flattens them into the render model
 * and applies the 5-minute blink window (`ACTIVITY_BLINK_WINDOW_MS`) — the
 * `fresh` flag on `ServerActivity` is the 1-hour staleness horizon, NOT the
 * blink window, so blink is computed here from `lastActivityAt`.
 */
describe('toServerStatusesByName (the handler → page projection)', () => {
  const NOW = Date.parse('2026-08-24T10:05:00.000Z')
  const INITIATOR = { trigger: 'lazy' } as const

  test('an alive entry with activity inside the blink window blinks white', async () => {
    const { toServerStatusesByName } = await import('../../src/ui/pages/servers.js')
    const statuses = toServerStatusesByName(
      {
        echo: {
          status: {
            status: 'alive',
            probedVia: 'initialize',
            initializeLatencyMs: 34,
            probedAt: '2026-08-24T10:00:00.000Z',
            initiator: INITIATOR,
          },
          activity: { lastActivityAt: '2026-08-24T10:03:00.000Z', fresh: true },
        },
      },
      NOW,
    )
    const view = statuses.get('echo')
    expect(view).toMatchObject({
      status: 'alive',
      probedVia: 'initialize',
      latencyMs: 34,
      probedAt: '2026-08-24T10:00:00.000Z',
      lastActivityAt: '2026-08-24T10:03:00.000Z',
      activityFresh: true,
    })
  })

  test('activity older than the blink window (but still "fresh" for staleness) does not blink', async () => {
    const { toServerStatusesByName } = await import('../../src/ui/pages/servers.js')
    const statuses = toServerStatusesByName(
      {
        echo: {
          status: {
            status: 'alive',
            probedVia: 'initialize',
            initializeLatencyMs: 34,
            probedAt: '2026-08-24T09:00:00.000Z',
            initiator: INITIATOR,
          },
          // 25 minutes old: inside the 1h staleness horizon, outside 5min blink.
          activity: { lastActivityAt: '2026-08-24T09:40:00.000Z', fresh: true },
        },
      },
      NOW,
    )
    expect(statuses.get('echo')?.activityFresh).toBe(false)
  })

  test('failure and probing entries map their fields; never-checked stays bare', async () => {
    const { toServerStatusesByName } = await import('../../src/ui/pages/servers.js')
    const statuses = toServerStatusesByName(
      {
        down: {
          status: {
            status: 'unreachable',
            error: 'connect ECONNREFUSED',
            probedAt: '2026-08-24T10:00:00.000Z',
            initiator: INITIATOR,
          },
        },
        busy: {
          status: { status: 'probing', probeStartedAt: '2026-08-24T10:04:00.000Z', initiator: INITIATOR },
        },
        idle: { status: { status: 'never-checked' } },
      },
      NOW,
    )
    expect(statuses.get('down')).toMatchObject({
      status: 'unreachable',
      error: 'connect ECONNREFUSED',
      probedAt: '2026-08-24T10:00:00.000Z',
    })
    expect(statuses.get('busy')).toMatchObject({
      status: 'probing',
      probeStartedAt: '2026-08-24T10:04:00.000Z',
    })
    expect(statuses.get('idle')).toEqual({ status: 'never-checked' })
  })
})

/**
 * The SSE half: the shipped `applyServerStatus` (run out of the real APP_JS
 * source, page-contracts pattern) must find the dot by `data-server`, swap its
 * class and rewrite its tooltip without a reload. `title` is assigned as a DOM
 * property (plain text), never parsed as HTML.
 */
describe('server-status-changed handler in APP_JS', () => {
  test('the script subscribes to the server-status-changed SSE event', () => {
    expect(JS_SOURCE).toContain('server-status-changed')
  })

  interface DotStub {
    className: string
    title: string
  }

  /** The shipped functions, bound to a stub document holding one dot. */
  function loadApply(dots: ReadonlyMap<string, DotStub>): (detail: unknown) => void {
    const parts = ['cssEscape', 'serverStatusDotClass', 'serverStatusTitle', 'applyServerStatus'].map(
      (name) => {
        const source = new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`).exec(
          JS_SOURCE,
        )?.[0]
        expect(source, `${name} not found in APP_JS`).toBeDefined()
        return source ?? ''
      },
    )
    const documentStub = {
      querySelector: (selector: string): DotStub | null => {
        const name = /\[data-server="(.*)"\]/.exec(selector)?.[1] ?? ''
        return dots.get(name.replace(/\\(.)/g, '$1')) ?? null
      },
    }
    return new Function('document', `${parts.join('\n')}\nreturn applyServerStatus;`)(
      documentStub,
    ) as (detail: unknown) => void
  }

  test('an alive event turns the dot white and rewrites the tooltip', () => {
    const dot: DotStub = { className: 'dot srv-dot dot-off dot-blink', title: 'probing…' }
    const apply = loadApply(new Map([['echo', dot]]))

    apply({
      server: 'echo',
      status: 'alive',
      probedVia: 'initialize',
      probedAt: '2026-08-24T10:00:05.000Z',
      latencyMs: 34,
    })

    expect(dot.className.split(/\s+/)).not.toContain('dot-off')
    expect(dot.className.split(/\s+/)).not.toContain('dot-blink')
    expect(dot.title).toContain('alive')
    expect(dot.title).toContain('probe (initialize)')
    expect(dot.title).toContain('34ms')
    expect(dot.title).toContain('2026-08-24T10:00:05.000Z')
  })

  test('a failure event turns the dot gray and carries the cause verbatim as text', () => {
    const dot: DotStub = { className: 'dot srv-dot', title: 'alive' }
    const apply = loadApply(new Map([['echo', dot]]))

    apply({
      server: 'echo',
      status: 'unreachable',
      probedAt: '2026-08-24T11:00:00.000Z',
      error: '<script>alert(1)</script> connect ECONNREFUSED',
    })

    expect(dot.className.split(/\s+/)).toContain('dot-off')
    // A DOM `title` property is text by construction; the handler must not
    // build HTML from it. The payload arrives verbatim, unexecuted.
    expect(dot.title).toContain('<script>alert(1)</script> connect ECONNREFUSED')
    expect(dot.title).toContain('unreachable')
  })

  test('a probing event blinks gray', () => {
    const dot: DotStub = { className: 'dot srv-dot', title: 'alive' }
    loadApply(new Map([['echo', dot]]))({ server: 'echo', status: 'probing' })

    const classes = dot.className.split(/\s+/)
    expect(classes).toContain('dot-off')
    expect(classes).toContain('dot-blink')
    expect(dot.title).toContain('probing')
  })

  test('an event for an unknown server or a malformed payload is a no-op', () => {
    const dot: DotStub = { className: 'dot srv-dot', title: 'alive' }
    const apply = loadApply(new Map([['echo', dot]]))

    apply({ server: 'ghost', status: 'error', error: 'x' })
    apply({ status: 'error' })
    apply(null)
    apply('not an object')

    expect(dot.className).toBe('dot srv-dot')
    expect(dot.title).toBe('alive')
  })

  test('a server name needing CSS escaping still finds its dot', () => {
    // Registry names cannot hold quotes today, but the escaping is the
    // script's contract, not the registry's; keep it honest.
    const dot: DotStub = { className: 'dot srv-dot', title: '' }
    const apply = loadApply(new Map([['we"ird', dot]]))

    apply({ server: 'we"ird', status: 'alive', probedVia: 'initialize', latencyMs: 1 })

    expect(dot.className.split(/\s+/)).toContain('dot')
    expect(dot.title).toContain('alive')
  })
})

/**
 * T3 — the "already granted" callout on the add confirmation. Holder names
 * come from `agents.json` / `groups.json` and are untrusted for render: a
 * hand-edited document can carry anything the store would have refused.
 */
describe('the add confirmation callout for a name that is already granted (T3)', () => {
  const RECORD: ServerRecord = { name: 'github', transport: 'stdio', command: 'gh-mcp' }
  const BASE = {
    record: RECORD,
    fields: { name: 'github', transport: 'stdio', command: 'gh-mcp' },
    csrfToken: 'csrf-token-value',
    currentAdmin: { name: 'alice', role: 'owner' as const },
  }

  test('names the holders and points at both pages to review them', () => {
    const html = renderAddConfirm({
      ...BASE,
      grantedTo: { agents: ['research-bot'], groups: ['analytics'] },
    })

    expect(html).toContain('is already granted to 1 agent')
    expect(html).toContain('1 group')
    expect(html).toContain('<code>research-bot</code>')
    expect(html).toContain('<code>analytics</code>')
    expect(html).toContain('href="/agents"')
    expect(html).toContain('href="/groups"')
  })

  test('a hostile holder name is escaped, not executed', () => {
    const html = renderAddConfirm({
      ...BASE,
      grantedTo: { agents: ['<script>alert(1)</script>'], groups: [] },
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('an empty half is not printed as an empty pair of brackets', () => {
    const html = renderAddConfirm({ ...BASE, grantedTo: { agents: ['research-bot'], groups: [] } })

    expect(html).toContain('0 groups')
    expect(html).not.toContain('()')
  })

  test('without the field the confirmation carries no callout at all', () => {
    const html = renderAddConfirm(BASE)

    expect(html).not.toContain('already granted')
  })
})
