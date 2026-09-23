import { describe, expect, test } from 'vitest'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { POOL_NAME_HIDE_ABOVE_CHARS, POOL_NAME_WARN_ABOVE_CHARS } from '../../src/pool/constants.js'
import { renderServersPage, toServerToolsByName } from '../../src/ui/pages/servers.js'

/**
 * The server card marks tools whose name in the agent pool is too long
 * (ADR-0015 phase 5, L1/L2). The thresholds are the pool's own (`name-codec`,
 * `constants`), so the card cannot disagree with what the merge actually hides:
 * past 64 characters `<server>__<tool>` is left out of every pool, past 47 some
 * clients shorten or refuse it.
 */

const OWNER = { name: 'alice', role: 'owner' } as const
const SERVER = 'github'
/** `github__` -- what the pool puts in front of every tool name of this server. */
const PREFIX_LENGTH = `${SERVER}__`.length

function toolOfPoolLength(length: number, seed = 'a'): string {
  return seed.repeat(length - PREFIX_LENGTH)
}

function inventoryWith(server: string, tools: readonly string[]): InventoryStoreData {
  const approved = Object.fromEntries(tools.map((name) => [name, { schemaHash: 'h', approvedAt: '2026-09-01T00:00:00.000Z' }]))
  return { version: 1, servers: { [server]: { approved, quarantined: {} } } }
}

function viewOf(tools: readonly string[], server = SERVER) {
  return toServerToolsByName(inventoryWith(server, tools)).get(server)
}

function page(tools: readonly string[], open = true): string {
  return renderServersPage({
    servers: [{ name: SERVER, transport: 'stdio', command: 'gh-mcp' }],
    canManage: false,
    csrfToken: 'csrf-token-value',
    currentAdmin: OWNER,
    tools: toServerToolsByName(inventoryWith(SERVER, tools)),
    ...(open ? { openTools: SERVER } : {}),
  })
}

describe('toServerToolsByName: the pool-name fit of each tool (L1)', () => {
  test('uses the pool thresholds themselves', () => {
    expect(POOL_NAME_WARN_ABOVE_CHARS).toBe(47)
    expect(POOL_NAME_HIDE_ABOVE_CHARS).toBe(64)
  })

  test.each([
    [47, undefined],
    [48, { fit: 'warn', length: 48 }],
    [64, { fit: 'warn', length: 64 }],
    [65, { fit: 'hidden', length: 65 }],
  ])('a pool name of %i characters is marked %o', (length, expected) => {
    const tool = viewOf([toolOfPoolLength(length)])?.tools[0]

    expect(tool?.poolName).toEqual(expected)
  })

  test('counts the hidden tools of a server, and leaves the count out at zero', () => {
    expect(viewOf([toolOfPoolLength(65, 'a'), toolOfPoolLength(70, 'b'), 'short'])?.poolHiddenCount).toBe(2)
    expect(viewOf(['short', toolOfPoolLength(50)])?.poolHiddenCount).toBeUndefined()
  })

  test('marks nothing for a server whose name the pool cannot carry', () => {
    // Only registry names can be pool members; anything else never reaches a pool.
    const view = viewOf(['x'.repeat(80)], 'Not_A_Registry_Name')

    expect(view?.tools[0]?.poolName).toBeUndefined()
    expect(view?.poolHiddenCount).toBeUndefined()
  })

  test('counts length in UTF-16 units, exactly as the merge does', () => {
    // 28 astral characters are 56 code units: with the prefix, 64 -> warn.
    const astral = '\u{1F600}'.repeat(28)

    expect(viewOf([astral])?.tools[0]?.poolName).toEqual({ fit: 'warn', length: 64 })
  })
})

describe('the server card and its tools modal (L2)', () => {
  test('the card row counts the tools no pool will list', () => {
    const document = page([toolOfPoolLength(65, 'a'), toolOfPoolLength(66, 'b'), 'short'], false)

    expect(document).toContain('3 exposed · 0 quarantined · 2 not in pool')
  })

  test('the card row says nothing about pools when every name fits', () => {
    const document = page(['short'], false)

    expect(document).toContain('1 exposed · 0 quarantined</span>')
    expect(document).not.toContain('not in pool')
  })

  test('the modal pills a hidden and a long name with their lengths, and nothing on a short one', () => {
    const hidden = toolOfPoolLength(65, 'h')
    const long = toolOfPoolLength(60, 'l')

    const document = page([hidden, long, 'short'])

    expect(document).toMatch(/<span class="pill pill-pixel pill-alert" title="[^"]*">not in pool · 65<\/span>/)
    expect(document).toMatch(/<span class="pill pill-pixel" title="[^"]*">long pool name · 60<\/span>/)
    expect(document.match(/not in pool · |long pool name · /g)).toHaveLength(2)
  })

  test('the pill explains itself without echoing the tool name', () => {
    const hidden = toolOfPoolLength(65, 'q')
    const long = toolOfPoolLength(50, 'w')

    const document = page([hidden, long])

    const titles = [...document.matchAll(/class="pill pill-pixel(?: pill-alert)?" title="([^"]*)"/g)].map((match) => match[1] ?? '')
    expect(titles).toHaveLength(2)
    expect(titles[0]).toContain('over 64')
    expect(titles[0]).toContain('/mcp')
    expect(titles[0]).toContain('per-server address')
    expect(titles[1]).toContain('over 47')
    for (const title of titles) {
      expect(title).not.toContain(hidden)
      expect(title).not.toContain(long)
    }
  })

  test('renders the pills with no JavaScript, from ?tools=<name>', () => {
    const document = page([toolOfPoolLength(65)])

    expect(document).toMatch(/<details class="drawer srv-tools-modal" id="tools-github" open>/)
    expect(document).toContain('not in pool · 65')
  })
})
